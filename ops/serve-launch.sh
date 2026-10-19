#!/usr/bin/env bash
# launchd entry point: token-gated server on 127.0.0.1. The bearer token lives in
# ~/.config/ai-memory/web.env (mode 600, outside the repo), never in the plist.
set -euo pipefail
ENV_FILE="${AI_MEMORY_WEB_ENV:-$HOME/.config/ai-memory/web.env}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
set -a; . "$ENV_FILE"; set +a
cd "$(dirname "$0")/.."
exec /Users/taboost/.bun/bin/bun scripts/serve.ts --remote --port 3131 --key-file "$HOME/.config/ai-memory/key"
