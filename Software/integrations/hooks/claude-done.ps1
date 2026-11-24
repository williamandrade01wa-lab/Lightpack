# Hook "Stop" do Claude Code: quando o Claude termina uma resposta, uma onda
# laranja suave acende nas pontas da mesa no Prismatik.
# Caminho principal: POST http://127.0.0.1:3637/api/v1/trigger com source "claude"
# (a cena ativa decide onde acende e se o aviso e permitido; 202 suppressed = silencio).
# Reserva opcional: PRISMATIK_LEGACY_FALLBACK=1 (API TCP na porta 3636).
# Silencioso e rapido: se o Prismatik/API nao estiver disponivel, sai sem erro.
# Para desligar: remova a entrada deste script em ~/.claude/settings.json (hook Stop).
# O token NUNCA e impresso nem gravado em log.

$ErrorActionPreference = 'SilentlyContinue'
$conf = Join-Path $env:USERPROFILE 'Prismatik\main.conf'

# --- caminho principal: API web (3637) ---
function Get-WebResult([int]$status) {
    if ($status -ge 200 -and $status -lt 300) { return 'Delivered' }
    if ($status -ge 400 -and $status -lt 500 -and $status -ne 408) { return 'Refused' }
    return 'Uncertain'
}

function Send-Web {
    $section = ''
    $token = ''
    $enabled = $true
    $hasWebSection = $false
    $port = 3637
    $response = $null
    $request = $null
    try {
        foreach ($line in Get-Content -LiteralPath $conf -ErrorAction Stop) {
            if ($line -match '^\[(.+)\]\s*$') {
                $section = $Matches[1]
                if ($section -eq 'WebApi') { $hasWebSection = $true }
                continue
            }
            if ($section -ne 'WebApi') { continue }
            if ($line -match '^IsEnabled=false\s*$') { $enabled = $false }
            if ($line -match '^Token=(.*)$') { $token = $Matches[1].Trim() }
            if ($line -match '^Port=(.*)$') {
                if (-not [int]::TryParse($Matches[1], [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
                    return 'Refused'
                }
            }
        }
        if (-not $enabled) { return 'Unavailable' }
        if ($hasWebSection -and -not $token) { return 'Refused' }
        if (-not $token) { return 'Unavailable' }

        $body = '{"id":"claude-done","source":"claude","effect":{"type":"wave","color":"#D97757","period_ms":1200,"width":0.2},"duration_ms":2400,"opacity":0.8,"priority":55}'
        $payload = [Text.Encoding]::UTF8.GetBytes($body)
        $request = [Net.WebRequest]::Create("http://127.0.0.1:$port/api/v1/trigger")
        $request.Method = 'POST'
        $request.Proxy = $null
        $request.AllowAutoRedirect = $false
        $request.Timeout = 2000
        $request.ReadWriteTimeout = 2000
        $request.ContentType = 'application/json'
        $request.ContentLength = $payload.Length
        $request.Headers['Authorization'] = "Bearer $token"
        $stream = $request.GetRequestStream()
        try { $stream.Write($payload, 0, $payload.Length) } finally { $stream.Dispose() }
        $response = $request.GetResponse()
        # 202 (inclusive suppressed) encerra a entrega conforme a politica da cena.
        return (Get-WebResult ([int]$response.StatusCode))
    } catch {
        $failure = $_.Exception
        while ($failure) {
            if ($failure -is [Net.WebException]) {
                if ($failure.Response) {
                    $response = $failure.Response
                    return (Get-WebResult ([int]$response.StatusCode))
                }
                if ($failure.Status -eq [Net.WebExceptionStatus]::ConnectFailure) { return 'Unavailable' }
            }
            if ($failure -is [Net.Sockets.SocketException] -and
                $failure.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return 'Unavailable' }
            $failure = $failure.InnerException
        }
        return 'Uncertain'
    } finally {
        if ($response) { $response.Dispose() }
        if ($request) { $request.Abort() }
    }
}

# --- reserva: API TCP antiga (3636) ---
function Send-Legacy {
    $trigger = 'trigger:{"id":"claude-done","source":"claude","target":{"groups":["desk-center","desk-ends"]},"effect":{"type":"wave","color":"#D97757","period_ms":1200,"width":0.2},"duration_ms":2400,"opacity":0.8,"priority":55}'
    $key = (Select-String -Path $conf -Pattern '^AuthKey=(.*)$' | Select-Object -First 1).Matches.Groups[1].Value

    $client = New-Object Net.Sockets.TcpClient
    $reader = $null
    $writer = $null
    try {
        $connect = $client.BeginConnect('127.0.0.1', 3636, $null, $null)
        $waitHandle = $connect.AsyncWaitHandle
        try {
            if (-not $waitHandle.WaitOne(500)) { return }
            $client.EndConnect($connect)
        } finally {
            $waitHandle.Dispose()
        }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 1000
        $stream.WriteTimeout = 1000
        $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 1024, $true)
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false), 1024, $true)
        $writer.AutoFlush = $true
        $null = $reader.ReadLine()
        if ($key) { $writer.WriteLine("apikey:$key"); $null = $reader.ReadLine() }
        $writer.WriteLine($trigger)
        $null = $reader.ReadLine()
    } finally {
        try {
            if ($writer) { $writer.Dispose() }
        } finally {
            try {
                if ($reader) { $reader.Dispose() }
            } finally {
                $client.Close()
            }
        }
    }
}

$result = Send-Web
if ($result -eq 'Unavailable' -and $env:PRISMATIK_LEGACY_FALLBACK -eq '1') {
    try { Send-Legacy } catch { }
}
exit 0
