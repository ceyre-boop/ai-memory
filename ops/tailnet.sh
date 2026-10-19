#!/usr/bin/env bash
# Reach the ai-memory server from your own devices (iPhone Action Button) over
# Tailscale. The server still binds 127.0.0.1; `tailscale serve` on this same
# machine forwards https from your tailnet only (never Funnel, never public).
# /api is token-gated, so a device on the tailnet still needs the bearer token.
#
# Exposing the loopback port beyond this machine is a human act, like
# `remote.sh`: it refuses to run inside an AI coding session.
#
# Needs: the store passphrase in AI_MEMORY_KEY (or --key-file), and Tailscale
# signed in on this Mac.
set -euo pipefail

PORT="${AI_MEMORY_PORT:-3131}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TS="${TAILSCALE_BIN:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}"

if [ -n "${CLAUDECODE:-}" ]; then
  cat <<EOF2
Refusing to expose the server from inside an AI coding session. Run in your own terminal:

  export AI_MEMORY_WEB_TOKEN="\$(openssl rand -hex 24)"   # write it down
  bash ops/tailnet.sh
EOF2
  exit 1
fi

[ -x "$TS" ] || { echo "Tailscale not found at $TS" >&2; exit 1; }

if [ -z "${AI_MEMORY_WEB_TOKEN:-}" ]; then
  AI_MEMORY_WEB_TOKEN="$(openssl rand -hex 24)"
  export AI_MEMORY_WEB_TOKEN
  echo "Generated access token (put it in the Shortcut as 'Authorization: Bearer <token>'):"
  echo "  $AI_MEMORY_WEB_TOKEN"
  echo
fi

bun "$HERE/../scripts/serve.ts" --remote --port "$PORT" ${AI_MEMORY_KEY_FILE:+--key-file "$AI_MEMORY_KEY_FILE"} &
SERVE_PID=$!
trap '"$TS" serve --https=443 off 2>/dev/null || true; kill "$SERVE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

"$TS" serve --bg --https=443 "http://127.0.0.1:$PORT"
echo
echo "Tailnet URL (tailnet devices only):"
"$TS" serve status
echo
echo "Shortcut: POST <that-url>/api/ask  header Authorization: Bearer <token>  body {\"question\": \"…\"}"
echo "Ctrl-C stops the server and removes the tailnet route."
wait "$SERVE_PID"
