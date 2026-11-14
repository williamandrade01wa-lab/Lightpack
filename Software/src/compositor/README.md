# Frame compositor — groups and overlays

Every color source (screen grab, mood lamp, sound, API/plugins) goes through
`FrameCompositor` before reaching the LED device:

1. **Base**: each LED follows the mode of its group (LEDs in no group follow the profile mode).
2. **Smooth**: software smoothing of the base (Smoothness setting; off for Lightpack hardware).
3. **Overlays**: temporary effects on top, by priority, with fade in/out. The base keeps
   running underneath, so the LEDs return to it smoothly when an overlay ends.
4. **Output**: one frame to the device, never faster than the link can carry
   (159 LEDs @ 115200 baud ≈ 23.8 FPS); newer frames replace pending ones.

LED indices are **0-based** (Prismatik's UI shows them 1-based: UI LED 72 = index 71).

## Groups (per profile)

Profile key `Compositor/Groups` (in `Profiles/<name>.ini`), a JSON array:

```json
[
  { "id": "monitor",     "leds": { "ranges": [[0, 70]] },             "mode": { "type": "source" } },
  { "id": "desk-center", "leds": { "ranges": [[98, 130]] },           "mode": { "type": "source" } },
  { "id": "desk-ends",   "leds": { "ranges": [[71, 97], [131, 158]] },
    "mode": { "type": "gradient", "brightness": 0.6,
              "stops": [ { "at": 0, "color": "#ff6a00" }, { "at": 1, "color": "#7a00ff" } ] } }
]
```

`leds`: `{"ranges": [[first, last], ...], "list": [i, ...]}` or `{"all": true}`.
Position along a group (for gradients, waves) follows the order given.

| mode `type` | parameters |
|---|---|
| `source` (alias `screen`) | — what the active profile mode produces |
| `off` | — |
| `solid` | `color`, `brightness` (0..1) |
| `gradient` | `stops` [{`at` 0..1, `color`}], `brightness` |
| `breathe` | `color`, `period_ms` (1000), `min` (0..1), `brightness` |
| `rainbow` | `period_ms` (8000), `brightness` |

## Overlays (triggers)

Legacy API (TCP, default port 3636, enable it in Expert > Enable server), one line per command:

```
trigger:{"id":"whatsapp","target":{"groups":["desk-ends"]},"effect":{"type":"pulse","color":"#25D366","period_ms":700,"count":3},"priority":60}
untrigger:whatsapp
untrigger:*
```

Answer: `ok` or `error: <reason>`. No lock needed: overlays layer over whatever is running.

| field | meaning (default) |
|---|---|
| `id` | same id restarts the overlay instead of stacking ("") |
| `target` | `{"groups": [...]}`, `{"leds": {"ranges": ...}}` or `{"all": true}` |
| `effect.type` | `pulse`, `flash`, `wave`, `breathe`, `rainbow`, `solid`, `gradient` |
| `effect.*` | `color`, `period_ms`, `count` (pulse 3, flash endless), `width` (wave, 0.25), `direction` (`left`/`right`), `min`, `brightness`, `stops` |
| `blend` | `alpha` (mix by effect alpha), `override` (replace), `add` (`alpha`) |
| `opacity` | 0..1 (1) |
| `priority` | 0..100, higher draws on top (50) |
| `duration_ms` | 0 = until `untrigger` (pulse/flash with `count`: period × count) |
| `fade_in_ms` / `fade_out_ms` | (120 / 300) |

PowerShell example:

```powershell
$c = New-Object Net.Sockets.TcpClient('127.0.0.1', 3636); $s = $c.GetStream()
$w = New-Object IO.StreamWriter($s); $w.AutoFlush = $true
$w.WriteLine('trigger:{"id":"test","target":{"groups":["desk-ends"]},"effect":{"type":"pulse","color":"#25D366"}}')
Start-Sleep -Milliseconds 300; $c.Close()
```
