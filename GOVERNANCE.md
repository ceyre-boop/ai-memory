# GOVERNANCE — what this system may do on its own, and what stays yours

This store surfaces; the operator decides. Every capability below is placed by one test: is this
presenting the operator's own record back to him, or is it making a judgment about his life?

## Tier 1 — Autonomous

Read-only operations over the corpus. No approval, no cost, no state change.

- Retrieval and citation of prior conversations
- Contradiction flags (same specific claim asserted incompatibly)
- Standing-question extraction — recurring concerns across instances
- Constraint violations: flagging when a proposed action conflicts with `CONSTRAINTS.md`
- Recurrence counts: "you have asked a version of this N times"

## Tier 2 — Proposes, operator approves

Anything that costs money, changes state, or leaves the machine.

- Writes to the store or corpus
- Push, pull, eject
- Outbound API calls
- Spawning sub-agents
- Publishing anything

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
