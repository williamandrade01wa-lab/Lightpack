# Hook "Stop" do Claude Code: quando o Claude termina uma resposta, uma onda
# laranja suave acende nas pontas da mesa no Prismatik.
# Caminho principal: POST http://127.0.0.1:3637/api/v1/trigger com source "claude"
# (a cena ativa decide onde acende e se o aviso e permitido; 202 suppressed = silencio).
# Reserva: API antiga na porta 3636 (grupos desk-center + desk-ends).
# Silencioso e rapido: se o Prismatik/API nao estiver disponivel, sai sem erro.
# Para desligar: remova a entrada deste script em ~/.claude/settings.json (hook Stop).
# O token NUNCA e impresso nem gravado em log.

$ErrorActionPreference = 'SilentlyContinue'
$conf = Join-Path $env:USERPROFILE 'Prismatik\main.conf'

# --- caminho principal: API web (3637) ---
function Send-Web {
    $section = ''
    $token = ''
    $port = '3637'
    foreach ($line in Get-Content -Path $conf) {
        if ($line -match '^\[(.+)\]\s*$') { $section = $Matches[1]; continue }
        if ($section -ne 'WebApi') { continue }
        if ($line -match '^Token=(.*)$') { $token = $Matches[1].Trim() }
        if ($line -match '^Port=(\d+)$') { $port = $Matches[1] }
    }
    if (-not $token) { return $false }
    $body = '{"id":"claude-done","source":"claude","effect":{"type":"wave","color":"#D97757","period_ms":1200,"width":0.2},"duration_ms":2400,"opacity":0.8,"priority":55}'
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/v1/trigger" -Method Post `
        -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
        -Body $body -UseBasicParsing -TimeoutSec 2
    # 202 (inclusive {"suppressed":true}) conta como entregue: a cena ativa pediu silencio
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
}

# --- reserva: API TCP antiga (3636) ---
function Send-Legacy {
    $trigger = 'trigger:{"id":"claude-done","target":{"groups":["desk-center","desk-ends"]},"effect":{"type":"wave","color":"#D97757","period_ms":1200,"width":0.2},"duration_ms":2400,"opacity":0.8,"priority":55}'
    $key = (Select-String -Path $conf -Pattern '^AuthKey=(.*)$' | Select-Object -First 1).Matches.Groups[1].Value

    $client = New-Object Net.Sockets.TcpClient
    $connect = $client.BeginConnect('127.0.0.1', 3636, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500)) { $client.Close(); return }
    $client.EndConnect($connect)

    $stream = $client.GetStream()
    $stream.ReadTimeout = 1000
    $reader = New-Object IO.StreamReader($stream)
    $writer = New-Object IO.StreamWriter($stream)
    $writer.AutoFlush = $true
    $null = $reader.ReadLine()
    if ($key) { $writer.WriteLine("apikey:$key"); $null = $reader.ReadLine() }
    $writer.WriteLine($trigger)
    $null = $reader.ReadLine()
    $client.Close()
}

$ok = $false
try { $ok = Send-Web } catch { $ok = $false }
if (-not $ok) { try { Send-Legacy } catch { } }
exit 0
