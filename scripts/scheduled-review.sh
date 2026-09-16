#!/bin/sh
# The one scheduled thing in this codebase, per GOVERNANCE.md's 2026-09-16
# amendment: prepares a standing review and writes it to a file. Never
# ranks, notifies, or interrupts — the operator reads it by choosing to.
# Invoked by ~/Library/LaunchAgents/com.ai-memory.review.plist, not by hand;
# run it directly any time to test what the schedule would do.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PATH="/Users/taboost/.local/bin:/Users/taboost/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH

mkdir -p "$REPO/reviews"
OUT="$REPO/reviews/$(date +%Y-%m-%d_%H%M).md"

cd "$REPO"
exec bun scripts/review.ts --out "$OUT"
