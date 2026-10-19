# JARVIS phone API

`POST https://taboosts-macbook-pro.tail07ab60.ts.net/api/ask` (tailnet only, via `tailscale serve`, not Funnel).

- Header: `Authorization: Bearer <token>` (401 without it). Token: `~/.config/ai-memory/web.env` and Keychain item `ai-memory-web-token`.
- Body: `{"message": "...", "image_b64": "..."?}` (`question` is accepted as an alias; images are ignored, the server has no vision path).
- Response: `{"reply": "...", "actions": [...], "grounded": n, "sources": [...]}`.
- The reply is answered only from your own record ("Not in your record." otherwise).
- The server never executes an action. It only returns them; the phone dispatches.

## actions[] schema (closed; anything else is dropped)

| type | fields | phone does |
|---|---|---|
| `run_shortcut` | `name`, `input?`, `requires_approval` | Run Shortcut by name (name must be in `shortcuts.json`). If `requires_approval` is true, confirm with the user first. |
| `open_url` | `url` (http/https only) | Open URL |
| `open_app` | `name` | Open App |
| `speak` | `text` | Speak Text |
| `copy` | `text` | Copy to Clipboard |

Anything that writes (send, email, calendar, purchase) must be a shortcut registered with `"writes": true`; those always come back `requires_approval: true`.

## Shortcuts

`bun ops/make-shortcut.ts "<name>" --notify "<text>" --purpose "<why>" [--writes]` builds, signs (`shortcuts sign`), registers in `shortcuts.json`, and opens it on the Mac so iCloud syncs it to the iPhone.

## Always-on

`~/Library/LaunchAgents/com.taboost.ai-memory.serve.plist` runs `ops/serve-launch.sh` (token-gated, 127.0.0.1:3131) at login and restarts it on crash. Tailscale Serve is persistent: `tailscale serve --https=443 off` removes the route.
