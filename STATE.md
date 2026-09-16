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
| **3. Proactive** — surfaces without being asked | **Does not exist.** Blocked by GOVERNANCE.md, deliberately. See "Open decision". | — |

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

## Open decision — the operator's, not a session's

GOVERNANCE.md Tier 1 says standing flags are "pull-only: run by the operator, never
delivered on the system's own initiative," and Tier 3 forbids "deciding what matters
or what is urgent." A scheduler crosses both.

The narrowest amendment that would unblock layer 3 without gutting the boundary:

> A scheduled run may **prepare** a standing review and write it to a file. It may
> not rank, prioritize, notify, or interrupt. The operator reads it by choosing to.

That keeps "what matters" with the operator: the system prepares material, the
person decides what is important. **Not yet accepted.** Do not implement a scheduler
until this page and GOVERNANCE.md both say it is allowed, in a commit of its own.

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
