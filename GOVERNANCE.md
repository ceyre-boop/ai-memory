# GOVERNANCE — what this system may do on its own, and what stays yours

This store surfaces; the operator decides. Every capability below is placed by one test: is this
presenting the operator's own record back to him, or is it making a judgment about his life?

## Tier 1 — Autonomous

Read-only operations over the corpus. No approval, no cost, no state change.

- Retrieval and citation of prior conversations
- Contradiction flags (same specific claim asserted incompatibly)
- Standing-pattern flags (`standing`) — a topic the operator's own record already named a mistake, a
  rule, or a pattern, cited back to their own words. The standard always comes from a retrieved
  snippet, never from the system itself — same discipline as a contradiction flag, aimed at decisions
  instead of facts. Pull-only: run by the operator, never delivered on the system's own initiative.
- Constraint violations: flagging when a proposed action conflicts with `CONSTRAINTS.md`
- Recurrence counts: "you have asked a version of this N times"

**Amended 2026-09-16, by the operator, accepted as worded.** A scheduled run may *prepare* a
standing review and write it to a file. It may not rank, prioritize, notify, or interrupt. The
operator reads it by choosing to. This is the one narrow exception to "pull by the operator": the
*timing* of preparation may be a schedule, but the *content* still carries no standard the record
didn't already state, and nothing about its delivery crosses into Tier 2 or Tier 3 — no ranking of
what matters, no notification, no interruption. `review.ts --out <path>` is the implementation.

## Tier 2 — Proposes, operator approves

Anything that costs money, changes state, or leaves the machine.

- Writes to the store or corpus
- Push, pull, eject
- Outbound API calls
- Spawning sub-agents
- Publishing anything

**Standing approval, one exception.** JARVIS's `/api/chat` (`server.ts`) is the product's main path:
every message the operator sends is itself the approval for the outbound call that answers it — there
is no separate confirmation step, and gating one behind the other would break the thing being demoed.
This differs from `ask` and `contradictions`, which also require the call to originate from a human
terminal (see `CONSTRAINTS.md`); `/api/chat` carries no such check. The boundary that still holds: the
operator decides what gets sent by choosing to send it, turn by turn.

## Tier 3 — Never

Not capability limits. Boundaries that keep the operator's judgment load-bearing.

- Deciding what to build, ship, or abandon
- Deciding what matters or what is urgent
- Overriding or routing around a refusal from the underlying model
- Acting on a provider account, or handling credentials
- Representing itself as the operator to any person or system

## Standing rules

- It speaks only from retrieved snippets. Absent evidence, it says so. No inference presented as record.
- It holds the record steady. It does not revise past statements toward the operator's present view.
- It is a prompt-builder, not a reasoner. Judgment stays with the underlying model; refusals stay intact.
- Tier 3 is amended only by the operator, deliberately, in a commit of its own.
