#!/usr/bin/env bash
# Reach the read-only ai-memory display from another device via a Cloudflare
# quick tunnel. The server still binds 127.0.0.1; cloudflared, on this same
# machine, forwards a public https URL to it. The store and passphrase never
# leave this machine — only query results do, as the page draws them.
#
# Exposing the loopback port beyond this machine is a human act, like `push`
# and `collect`: it refuses to run inside an AI coding session. Run it yourself.
#
# Needs: the store passphrase in AI_MEMORY_KEY (or run `serve` with --key-file),
# and `cloudflared` (brew install cloudflared).
set -euo pipefail

PORT="${AI_MEMORY_PORT:-3131}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${CLAUDECODE:-}" ]; then
  cat <<EOF
Refusing to open a tunnel from inside an AI coding session — exposing the
display is yours to do. Run these in your own terminal:

  export AI_MEMORY_WEB_TOKEN="\$(openssl rand -hex 24)"   # your access token — write it down
  export AI_MEMORY_KEY="<your store passphrase>"
  bash ops/remote.sh

Then open the https URL cloudflared prints and paste the token when asked.
EOF
  exit 1
fi

command -v cloudflared >/dev/null 2>&1 || {
  echo "cloudflared not found. Install it first:  brew install cloudflared" >&2
  exit 1
}

if [ -z "${AI_MEMORY_WEB_TOKEN:-}" ]; then
  AI_MEMORY_WEB_TOKEN="$(openssl rand -hex 24)"
  export AI_MEMORY_WEB_TOKEN
  echo "Generated access token (write it down — you'll paste it in the browser):"
  echo "  $AI_MEMORY_WEB_TOKEN"
  echo
fi

echo "Starting read-only display on 127.0.0.1:$PORT (token-gated)…"
bun "$HERE/../scripts/serve.ts" --remote --port "$PORT" &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

# Wait for the server to answer before opening the tunnel.
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

echo
echo "Opening a Cloudflare quick tunnel — the https URL below is your dashboard."
echo "Open it on any device, paste the access token, and you're in."
echo "(The URL and this tunnel last only while this command runs.)"
echo
exec cloudflared tunnel --url "http://127.0.0.1:$PORT"
