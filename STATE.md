# STATE — what exists, what is only on the chip, and what is still missing

Written 2026-09-15. Update this page when the answer to any heading changes.
This is the orientation doc for a fresh session: read it before proposing work.

## The honest headline

There is no mini-me, no second brain that thinks, and no AI living on an SD card.
What exists is **total recall over the operator's own record, portable and encrypted**,
plus the first, pull-only slice of a pattern layer. That is a real system and it works.
It is not the thing the operator is ultimately building toward, and no session should
describe it as though it were.

The gap is named precisely in "What is still missing" below. Build from the middle
outward — the recall layer is load-bearing and finished; the pattern layer is young;
the proactive layer does not exist and is governance-blocked by design.

## Layer status

| Layer | State | Where it lives |
|---|---|---|
| **1. Recall** — retrieve, cite, decline honestly | **Done.** Verified end to end, survives chip round-trip, reopens on other hardware. | store + all scripts |
| **2. Pattern** — flags standing patterns from the operator's own prior words | **Partial.** `standing.ts`, `review.ts`, and the standing check folded into `ask`. Pull-only: it answers when run, never on its own. | `standing.ts`, `review.ts`, `lib/ask.ts` |
| **3. Proactive** — surfaces without being asked | **Narrowly unblocked.** A scheduled run may prepare a file; it may not notify or interrupt. Still pull at the delivery end — the operator opens the file. See "Open decision" and "Scheduling". | `review.ts`, launchd job |

## On this computer vs only on the chip

The store on this machine is the primary. The chip is a verified copy, and the two
**drift between pushes** — that is expected, not a fault.

Last verified push: **2026-09-15T19:45Z** → `/Volumes/AIMEMORY/ai-memory`

| | Local (primary) | Chip (last push) |
|---|---|---|
| conversations | 236 | 236 |
| messages | 2,919 | 2,919 |
| file chunks | 907,698 | 907,698 |
| message vectors | 2,919 | 2,919 |
| **file vectors** | **~70k and climbing** | **~49k, frozen at push time** |
| scripts | all 13 | all 13 as of last push |

**Only difference that matters:** file-level semantic search is still building locally.
Everything else is identical. The chip is complete and self-contained — it is not a
partial backup, it is a snapshot.

## Work in flight

`bun scripts/embed.ts --kind file` — building vectors for 907,698 file chunks at
~13/s against local Ollama. **~838k remain, roughly 18 hours of wall clock.**

**It has died unattended three times** with no error in the log, which points at an
external kill (sleep, session teardown) rather than a crash. It is resumable by
design: rerun the same command and it embeds only what is missing. Always check
`pgrep -f scripts/embed.ts` before assuming it is still going, and never run two
copies — two writers on one SQLite store dropped throughput from 13/s to 5/s.

When it finishes: store grows to ~2.9 GB, re-push, then the chip has full semantic
search over files too.

## What is still missing

Stated as the operator stated it, so a future session does not soften it:

- **"Notice when I'm drifting."**
- **"Surface what I decided earlier without me asking."**
- **"Catch me when I'm polishing instead of building."**

Every one of those is *proactive*. Everything built so far is *pull* — it answers
when run. That is the whole remaining gap, and it is one component, not a rewrite.

## Open decision — resolved 2026-09-16

The operator accepted the amendment as worded, in GOVERNANCE.md, in its own commit:

> A scheduled run may **prepare** a standing review and write it to a file. It may
> not rank, prioritize, notify, or interrupt. The operator reads it by choosing to.

`review.ts --out <path>` already satisfies this exactly as it stood before the
amendment — it was written Tier-1-clean from the start (topics come from the record's
own timestamps, every flag cites the operator's own words, no ranking). The only thing
the amendment actually unblocks is *running it on a schedule* rather than only by hand;
`requireHumanOperator()`'s `CLAUDECODE` guard only blocks an AI coding session, never a
scheduler, so nothing there needed to change either. See "Scheduling" below.

## Scheduling

The one scheduled thing in this codebase: `launchd/com.ai-memory.review.plist`
(macOS launchd), installed at `~/Library/LaunchAgents/com.ai-memory.review.plist`, runs
`scripts/scheduled-review.sh` daily at 08:00. That wrapper sets `PATH` explicitly (launchd's
own environment doesn't have `bun`/`claude` in it) and calls `bun scripts/review.ts --out
<dated file>` — nothing more. Output lands in `reviews/` (gitignored: it quotes the
operator's own record and must never reach the public repo).

Install/reinstall after editing the plist:
```sh
cp launchd/com.ai-memory.review.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.ai-memory.review 2>/dev/null   # if already loaded
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ai-memory.review.plist
```
Test without waiting for 08:00: `launchctl kickstart -p gui/$(id -u)/com.ai-memory.review`,
then check `reviews/launchd.log` and the newest file in `reviews/`.

`review.ts`'s own `requireHumanOperator()` guard only blocks an *AI coding session*
(`CLAUDECODE` set) — launchd never sets that, so the schedule was never blocked by it and
nothing needed to change there. The thing the 2026-09-16 amendment actually authorized was
running this outside a human typing the command at all; the content and citation discipline
were already correct.

## Rules a fresh session must not rediscover the hard way

- `push`, `ask`, `contradictions`, `standing`, `review`, and `collect` all refuse to
  run for real inside an AI coding session (`CLAUDECODE` set). `--dry` always works.
  This is correct. Do not route around it — hand the operator the command.
- CONSTRAINTS.md and GOVERNANCE.md are amended **first, in their own commit**, before
  any code that changes what they describe.
- Embedding is local-only over loopback. `lib/ask.ts` and `lib/embed.ts` are the only
  files permitted to open a socket, and a test enforces it.
- The chip is written by a human at a terminal. Always.
- The `--more` pagination cache (`~/.config/ai-memory/query-cache.json` by default) is
  local, non-secret, and outside the repo — but early in that work it got written to
  for real during a test run, before `AI_MEMORY_QUERY_CACHE` was isolated in every test
  helper. It held fixture refs, nothing sensitive, and was deleted. The fix (tests now
  always override `AI_MEMORY_QUERY_CACHE`, and the cache module resolves its path lazily
  per call rather than freezing it at import time) is in place and tested. If a future
  session adds a new tool that touches this cache, isolate it in tests the same way —
  this exact mistake is cheap to repeat and easy to miss.
