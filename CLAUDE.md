# ai-memory — session brief

**Read `STATE.md` first.** It says what exists, what is only on the chip, and what is
still missing. Then read `CONSTRAINTS.md` and `GOVERNANCE.md` — they are binding, not
aspirational, and the code is wrong when it disagrees with them.

## Do not describe this system as more than it is

There is no mini-me, no second brain that thinks, no AI living on the SD card. There is
total recall over the operator's own record, portable and encrypted, plus a pull-only
pattern layer. Say that plainly. The operator is clear-eyed about the gap and does not
want it flattered.

## Hard rules

- **Docs before code.** `CONSTRAINTS.md` and `GOVERNANCE.md` are amended first, in their
  own commit, before any code that changes what they describe.
- **Outbound and removable-media writes are human acts.** `push`, `ask`, `contradictions`,
  `standing`, `review`, and `collect` refuse to run for real when `CLAUDECODE` is set.
  `--dry` always works. Do not route around this — print the command for the operator to
  run in their own terminal.
- **Two files may open a socket:** `lib/ask.ts` (hosted model, opt-in) and `lib/embed.ts`
  (loopback only). A test enforces it. Do not add a third.
- **No scheduler.** Proactive delivery is Tier-3 blocked. See the open decision in
  `STATE.md`; it is the operator's call, not a session's.
- **bun only** — never npm/npx. TypeScript only — never Python.
- `--dry` on every bulk or destructive command. No exceptions.

## Before claiming anything works

Run it and paste the real output. `bun test` is the gate (currently 143 passing). For the
embed job, check `pgrep -f scripts/embed.ts` before assuming it is still running — it has
died unattended several times, and never run two copies against one store.

## Retrieval

`query.ts`'s `search()` is the single retrieval path. `ask`, `contradictions`, `standing`,
and `review` all go through it. Add retrieval features there, not in a caller.
