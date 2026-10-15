#!/usr/bin/env bash
# Stable-URL remote access for the read-only ai-memory display, via a *named*
# Cloudflare tunnel. Unlike the quick tunnel in remote.sh, the hostname is the
# same every time (memory.<your-domain>), so you can bookmark it.
#
# The server still binds 127.0.0.1; cloudflared, on this machine, forwards the
# hostname to it. The store and passphrase never leave this machine — only
# query results do, as the page draws them. /api stays gated by a bearer token
# even behind the tunnel, so it is never wide open; add Cloudflare Access
# (see `access`) to gate it behind your Google login instead of a pasted token.
#
# Exposing the loopback port, and provisioning DNS on your Cloudflare account,
# are human acts — like `push` and `collect`, this refuses inside an AI coding
# session. Run it yourself.
#
#   One-time:   cloudflared tunnel login          # opens a browser, you pick your domain
#               bash ops/tunnel.sh setup memory.<your-domain>
#   Each time:  bash ops/tunnel.sh run             # or: bun run tunnel
#   Optional:   bash ops/tunnel.sh install-service # keep it up across reboots
#               bash ops/tunnel.sh access          # how to add Google-login gating
#
set -euo pipefail

TUNNEL="${AI_MEMORY_TUNNEL_NAME:-ai-memory}"
PORT="${AI_MEMORY_PORT:-3131}"
CF_DIR="$HOME/.cloudflared"
CONFIG="$CF_DIR/config.yml"
HERE="$(cd "$(dirname "$0")" && pwd)"
TOKEN_FILE="${AI_MEMORY_WEB_TOKEN_FILE:-$HOME/.config/ai-memory/web-token}"
KEY_FILE="${AI_MEMORY_KEY_FILE:-$HOME/.config/ai-memory/key}"
PLIST="$HOME/Library/LaunchAgents/com.ai-memory.tunnel.plist"

die() { echo "error: $*" >&2; exit 1; }

guard_human() {
  [ -z "${CLAUDECODE:-}" ] && return 0
  cat >&2 <<EOF
Refusing to run '$1' from inside an AI coding session — exposing the display and
provisioning DNS are yours to do. In your own terminal:

  cloudflared tunnel login                       # once, opens a browser
  bash ops/tunnel.sh setup memory.<your-domain>  # once
  export AI_MEMORY_KEY="<your store passphrase>"
  bash ops/tunnel.sh run
EOF
  exit 1
}

need_token() {
  mkdir -p "$(dirname "$TOKEN_FILE")"
  if [ ! -s "$TOKEN_FILE" ]; then
    openssl rand -hex 24 > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    echo "generated a web token at $TOKEN_FILE"
  fi
}

cmd_setup() {
  guard_human setup
  local host="${1:-}"
  [ -n "$host" ] || die "usage: ops/tunnel.sh setup <hostname>   e.g. memory.yourdomain.com"
  [ -f "$CF_DIR/cert.pem" ] || die "not logged in to Cloudflare. Run first:  cloudflared tunnel login"
  command -v cloudflared >/dev/null || die "cloudflared not found — brew install cloudflared"

  # Create the tunnel if it doesn't exist yet (idempotent).
  if ! cloudflared tunnel list -o json 2>/dev/null | grep -q "\"name\":\"$TUNNEL\""; then
    echo "creating named tunnel '$TUNNEL'…"
    cloudflared tunnel create "$TUNNEL"
  else
    echo "tunnel '$TUNNEL' already exists — reusing it."
  fi

  local uuid cred
  uuid="$(cloudflared tunnel list -o json | sed -n "s/.*\"id\":\"\([0-9a-f-]*\)\",\"name\":\"$TUNNEL\".*/\1/p" | head -1)"
  [ -n "$uuid" ] || uuid="$(cloudflared tunnel info "$TUNNEL" 2>/dev/null | sed -n 's/^.*id: *\([0-9a-f-]*\).*/\1/p' | head -1)"
  [ -n "$uuid" ] || die "could not resolve the tunnel UUID — run 'cloudflared tunnel list' and check."
  cred="$CF_DIR/$uuid.json"
  [ -f "$cred" ] || die "credentials file $cred missing — the tunnel create step did not complete."

  echo "writing $CONFIG…"
  cat > "$CONFIG" <<EOF
# ai-memory named tunnel — written by ops/tunnel.sh setup
tunnel: $TUNNEL
credentials-file: $cred
ingress:
  - hostname: $host
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF

  echo "routing DNS: $host -> tunnel $TUNNEL…"
  cloudflared tunnel route dns "$TUNNEL" "$host"

  need_token
  echo
  echo "Setup complete. Your stable dashboard URL will be:  https://$host"
  echo "Bring it up with:   bash ops/tunnel.sh run   (or bun run tunnel)"
  echo "Gate it behind your Google login (optional):  bash ops/tunnel.sh access"
  echo "Until Access is added, the page asks for the token in $TOKEN_FILE."
}

cmd_run() {
  guard_human run
  [ -f "$CONFIG" ] || die "no $CONFIG — run 'ops/tunnel.sh setup <hostname>' first."
  need_token
  export AI_MEMORY_WEB_TOKEN; AI_MEMORY_WEB_TOKEN="$(cat "$TOKEN_FILE")"

  local keyargs=()
  if [ -n "${AI_MEMORY_KEY:-}" ]; then :; elif [ -f "$KEY_FILE" ]; then keyargs=(--key-file "$KEY_FILE"); fi

  echo "starting read-only display on 127.0.0.1:$PORT (token-gated)…"
  bun "$HERE/../scripts/serve.ts" --remote --port "$PORT" "${keyargs[@]}" &
  local serve_pid=$!
  trap 'kill "$serve_pid" 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 0.2; done

  local host; host="$(sed -n 's/^ *- hostname: *//p' "$CONFIG" | head -1)"
  echo "running tunnel '$TUNNEL' — dashboard at: https://$host"
  exec cloudflared tunnel run "$TUNNEL"
}

cmd_access() {
  local host=""; [ -f "$CONFIG" ] && host="$(sed -n 's/^ *- hostname: *//p' "$CONFIG" | head -1)"
  cat <<EOF
Gate the dashboard behind your Google login (Cloudflare Zero Trust — free):

  1. https://one.dash.cloudflare.com  ->  Access  ->  Applications  ->  Add an application
  2. Type: Self-hosted.  Application domain: ${host:-memory.<your-domain>}
  3. Add a policy:  Action = Allow,  Include = Emails = colineyre222@gmail.com
  4. Save. Now opening the URL shows a Google login; only you get in.

The bearer token stays as a backstop, so even without this the API is never open.
EOF
}

cmd_install_service() {
  guard_human install-service
  [ -f "$CONFIG" ] || die "run setup first."
  [ -n "${AI_MEMORY_KEY:-}" ] || [ -f "$KEY_FILE" ] || die "install a key file at $KEY_FILE first (a boot service can't prompt for the passphrase)."
  need_token
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ai-memory.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$HERE/tunnel.sh</string><string>run</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>AI_MEMORY_KEY_FILE</key><string>$KEY_FILE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HERE/tunnel.log</string>
  <key>StandardErrorPath</key><string>$HERE/tunnel.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)/com.ai-memory.tunnel" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "installed boot service -> $PLIST  (logs: $HERE/tunnel.log)"
  echo "note: this keeps your display reachable 24/7 behind Access/token. Remove with: ops/tunnel.sh uninstall-service"
}

cmd_uninstall_service() {
  launchctl bootout "gui/$(id -u)/com.ai-memory.tunnel" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed boot service."
}

case "${1:-}" in
  setup)             shift; cmd_setup "${1:-}";;
  run)               cmd_run;;
  access)            cmd_access;;
  install-service)   cmd_install_service;;
  uninstall-service) cmd_uninstall_service;;
  *) cat >&2 <<EOF
usage: ops/tunnel.sh <command>
  setup <hostname>     one-time: create the named tunnel, DNS route, token
  run                  bring the stable dashboard up (serve + cloudflared)
  access               how to gate it behind your Google login
  install-service      keep it up across reboots (launchd)
  uninstall-service    remove that service
EOF
     exit 1;;
esac
