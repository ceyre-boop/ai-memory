# CONSTRAINTS — what ai-memory does with your data, and what it never does

This page is the spine of the project. Every script, test, and later component (embeddings,
retrieval, the response layer) is bound by it. If code and this page disagree, the code is wrong.

**Thesis.** Your AI conversation history is legally yours and practically stranded inside
provider accounts. ai-memory is the on-ramp: it takes the export archive a provider gave you and
turns it into a local, encrypted, searchable store you can carry on removable media. You own the
context and rent the model. This is memory infrastructure, nothing more.

## What the system does with your data

1. **Reads only what you hand it.** You download the export (ChatGPT, Claude, Gemini Takeout) and
   pass the file or folder to `ingest`. The system never fetches an export for you, never logs in
   anywhere, and never holds a provider credential of any kind.
2. **Stores conversations in one encrypted SQLite file** (`embeddings/index.db`, SQLCipher).
   Timestamps, thread boundaries, and who-said-what (user / assistant / system / tool) are preserved.
   Where a boundary had to be guessed (Gemini Takeout has no thread id), the row says so:
   `thread_inferred = 1`.
3. **Marks what it did not keep verbatim** instead of dropping it silently: tool calls become
   `[tool_use: name]` markers, images become `[image: …]`, model reasoning is excluded from the
   searchable body unless you pass `--include-thinking`.
4. **Skips account-identity files** in every archive (`users.json`, `user.json`): your name, email,
   and phone are not conversation memory and are never written to the store.
5. **Indexes for search** (FTS5 keyword plus local vector embeddings) so `query` answers from your own record, and prints "no matches"
   rather than inventing a result. With a model key configured, `ask` sends the question and the
   matching snippets to the model; the answer must cite which snippet it came from and say "not in
   your record" when the snippets do not contain the answer. Every answer lists its sources.
6. **Embeds locally, on this machine only.** Vectors are computed by a model running on your own
   hardware (Ollama on `127.0.0.1`, default `nomic-embed-text`). Text goes to loopback and never
   leaves the machine: no embedding provider, no API key, no account. Vectors live in the same
   encrypted store as the text, quantized to int8. If the local model is unavailable, `embed`
   stops with an error and never falls back to a hosted service. `query` works with or without
   vectors; without them it is keyword-only.
7. **Copies to the media you name** with `push`, then reopens the copied index on that media with
   your key and counts rows before it says "verified". A copy that does not reopen is a failure.
8. **Deletes on request.** `forget <conversation-id>` or `forget --provider X` removes conversations,
   their search index entries, and their vectors together.

## What it never does

- Never fetches, scrapes, or automates anything against a provider account.
- Never sends text to a hosted embedding service. Embedding is local-only over loopback, or it fails.
- Never sends data anywhere, with one opt-in exception: `ask` sends your question plus the top-k
  matching snippets to the model provider you configure — by default the `claude` CLI signed in to your
  own subscription, or the Messages API with `ANTHROPIC_API_KEY` (read from `.env`, never logged, never
  in output) when `AI_MEMORY_PROVIDER=api`. No provider → no call; `--dry` shows exactly what would be
  sent and sends nothing. `ask` also checks the same retrieved snippets for a standing pattern by
  default (same rule as `standing`, one more call on the snippets already in hand, `--no-patterns`
  turns it off) — still one question, one act of asking, nothing delivered between questions.
  `contradictions` shares that same one file, same provider, same rule — it sends a topic plus the
  top-k snippets and nothing else, to find where your own record asserts one thing at two different
  times, not to judge which is true. `standing` shares it too — it looks for a topic you already named a
  mistake, a rule, or a pattern in your own words, and refuses to flag anything unless the snippet itself
  contains that self-characterization; the system never supplies the standard, only cites yours back. It
  is pull-only: nothing in this codebase calls it on your behalf or on a schedule, you run it. Never the
  passphrase, never the whole store. A test enforces that `scripts/lib/ask.ts` is the
  only outbound network code in the repository.
- Never writes plaintext into `corpus/`. That folder is an inbox you control; the store is the
  encrypted database. `push` never copies `corpus/` to removable media.
- Never places a plaintext database on removable media. `push` checks the file header and refuses.
- Never keeps a second way in: no key escrow, no recovery key, no cloud backup, no telemetry.
- Never logs, prints, or writes your passphrase. It enters through `AI_MEMORY_KEY`, `--key-file`,
  or an interactive prompt, and lives only in process memory.
- Never runs a bulk or destructive operation without a rehearsal: `ingest`, `collect`, `encrypt`,
  `forget`, and `push` all accept `--dry`, which prints the plan and writes nothing.
- Never builds a profile, index, or summary keyed on a person other than you (see below).
- Never claims agency, sentience, or a mind of its own. It is a filing cabinet with a lock.

## If the drive is lost

**Decision: losing a drive loses nothing; losing the passphrase loses everything.**

- Every copy of the store is ciphertext. Whoever finds the chip holds an opaque file. SQLCipher
  derives the key from your passphrase (PBKDF2-HMAC-SHA512, 256k iterations, per-file salt), so a
  weak passphrase is the only realistic attack. Choose a long one.
- The store on your machine is the primary. A chip is a copy. `push` records each verified copy in
  `manifest.json` (target, time, row counts — no secrets), so `status` tells you where copies exist.
  Keep at least two.
- There is no recovery key and no escrow, by design. If you forget the passphrase, no one,
  including this software, can open the store. Write the passphrase down and keep it apart from
  the chip. `encrypt rekey` changes it without re-ingesting.
- Re-ingesting the original export archives rebuilds the store from scratch. Keep the archives.

## Third parties named in conversations

Your conversations mention other people: colleagues, friends, family, public figures.

- Their words and names are stored **only as part of your own record**, the way they would be in
  your email or notes. Nothing is extracted, cross-referenced, enriched, or indexed by person.
- No retrieval or response layer built on this store may assert anything about a third party beyond
  what your own record says, and it must say where in the record it came from.
- You can remove any conversation with `forget`. The deletion covers the search index too.
- If someone asks you to remove what you hold about them, `forget` is the mechanism; there is no
  hidden copy to chase.

## The display, and reaching it from another device — amended 2026-10-14

`serve` is the read-only display over the store (`ui/`, `scripts/serve.ts`). It binds
`127.0.0.1` and only ever binds `127.0.0.1` — it never opens itself on a public interface.
By default it is loopback: open on this machine, invisible everywhere else. That has not changed,
and the test that pins the bind address stays.

The operator may reach the display from another device — a phone, a second laptop — **without moving
the store or the passphrase off this machine**. The mechanism is a tunnel the operator runs
(`cloudflared` or equivalent) that forwards an outside URL to `127.0.0.1:3131` here. The server still
binds loopback; the tunnel, running on this same machine, is the only thing that talks to it. The
database at rest and the passphrase never leave. Only query *results* do, as the display draws them.

Because a tunnel makes the loopback port reachable by anyone who holds the URL, remote mode is gated:

- **A token, or it does not start.** `serve --remote` refuses to run unless `AI_MEMORY_WEB_TOKEN`
  is set. With it set, every `/api` request must carry `Authorization: Bearer <token>`; without the
  header the request is `401`. The static page still loads, so the token can be entered in the browser;
  the data behind it does not. The token is a gate on the socket, not a second encryption — choose a
  long one, keep it with the passphrase, never in the repo. Plain `serve` (no `--remote`) is unchanged
  and needs no token.
- **Still read-only, still no new outbound code.** Remote mode adds a bearer-token check to the
  existing read-only API and nothing else. It opens no socket of its own — the tunnel is a separate
  program the operator runs — so the rule that only `lib/ask.ts` and `lib/embed.ts` may open a socket
  is untouched.
- **Opening the tunnel is a human act.** Exposing the loopback port beyond this machine stands with
  `push`, `collect`, and the outbound tools: `ops/remote.sh` refuses to run inside an AI coding session
  (`CLAUDECODE` set) and prints the commands for the operator to run at their own terminal. A session
  may run plain loopback `serve`; it may not open the tunnel.
- **Plaintext in transit is the operator's to accept.** Results travel decrypted through whatever
  tunnel the operator chose, TLS-terminated at that provider's edge. The store is never exposed, but a
  snippet the display shows is visible to the tunnel provider while it is in flight. Running the tunnel
  is the act that accepts this.
- **One action on the display is generative, and it is the ghostwrite draft — amended 2026-10-18.**
  Everything else the display does is read-only over the store. The one exception is
  `POST /api/ghostwrite`, the browser surface of item 10 below: it reads the store and `SOUL.md`,
  assembles the same prompt the CLI does, and returns a draft through the one outbound path
  (`lib/ask.ts`). It writes nothing to the store and opens no new socket — the `fetch` stays in
  `lib/ask.ts`, and the test that pins the two socket files is untouched. It is bound by every rule
  item 10 names: it drafts and never delivers; it refuses the real call when the *server process* was
  started inside an AI coding session (`CLAUDECODE` set), so a draft is produced only by a server the
  operator ran at their own terminal; it sends only `SOUL.md` and the retrieved snippets, never the
  passphrase or the whole store. Under `--remote` it sits behind the same bearer token as every other
  `/api` route.

## Rules that every component inherits

- The user supplies the export file. The system never fetches it.
- Nothing writes to `corpus/` unencrypted. The encrypted database is the corpus.
- `--dry` on every destructive or bulk operation.
- `push` verification is mandatory: reopen the index on the target after the copy.
- Copying to removable media is a human act. `push` refuses to write to a target when it is run from
  inside an AI coding session (the `CLAUDECODE` environment variable is set); from there only `--dry` works.
  What goes on the chip, and therefore what the assistant can ever recall, is decided by a person at a
  terminal.
- Sweeping local files into the store is the same kind of act. `collect` refuses to write when run from
  inside an AI coding session, the same `CLAUDECODE` check and the same `--dry` escape hatch as `push`.
  What gets swept in, and therefore what the assistant can ever recall, is decided by a person at a
  terminal here too.
- Sending anything outbound is the same kind of act, again. `ask`, `contradictions`, and `standing`
  refuse to call the model when run from inside an AI coding session, the same `CLAUDECODE` check and
  the same `--dry` escape hatch as `push` and `collect`. What leaves the machine, and on whose say-so, is
  decided by a person at a terminal — not by an agent asking on its own behalf.
- `ask` and `contradictions` retrieval is steerable, all read-only, Tier 1 under `GOVERNANCE.md`: `--more`
  (next batch, excluding what a local cache says you've already seen for this question — opaque refs
  only, never the store's plaintext, kept at `~/.config/ai-memory/query-cache.json` by default, same
  convention as the passphrase file so it never rides a push), `--oldest`/`--newest`/`--since`/`--until`
  (order or bound by date instead of relevance), and `--chunk` (re-fetch one exact snippet by the stable
  ref every source line now prints, rather than re-approximating it with a fresh search).
- When a batch is cut off by `--k`, the only thing either tool is told is a yes/no: whether more exists.
  Never a match count — FTS5's counts say nothing about answer completeness, and a number invites false
  precision about coverage, which is a new failure, not a fix for the old one. `ask` may mention it
  inline, cited to that signal; `contradictions`' own structured reply format never carries it — the
  note there is printed by the CLI itself, deterministically, so `NO CONTRADICTIONS FOUND.` stays exactly
  that literal string and nothing riskier gets asked of the parser.
- Changing any rule on this page requires editing this page first, in its own commit.

## Rules you wrote yourself (`reflex`) — amended 2026-10-08

A fourth kind of pull, and the first one with no model in it at all.

9. **Matches your input against rules you wrote by hand, and prints your own words back.**
   `reflex "text"` reads a plain markdown file of rules the operator authored
   (`~/.config/ai-memory/rules.md` by default, `AI_MEMORY_RULES` to override — same convention as the
   passphrase file: outside the repo, never rides a push). Each rule is a heading, a `match:` line of
   plain words or `/regexes/`, an optional `ref:` pointing at one stable chunk ref the `query` tool
   printed, and a quoted line in the operator's own words. When the input contains a match term, the
   rule's quote is printed. That is the whole mechanism: substring and regex, deterministic, offline.

What this adds, and what it does not:

- **No model, no socket, no key required.** It is plain string matching. It therefore has no
  `CLAUDECODE` guard — nothing leaves the machine and nothing is written, so it is the one
  pattern-layer tool an AI coding session may run for real. That is deliberate: it lets the record's
  standing rules reach a session without the session ever sending anything out.
- **The system never writes, edits, infers, or suggests a rule.** `reflex` opens the rules file
  read-only. Every rule exists because a person typed it. If the file is missing, it says so and
  matches nothing.
- **A `ref:` is verified, never trusted.** When a rule names a ref and the store is unlocked, the
  ref is fetched with `fetchByRef` and the quote is checked to appear in that chunk. A rule whose ref
  does not resolve, or whose quote is not in the chunk, is printed as **unverified** — still shown,
  because the words are the operator's own, but marked, so a drifted quote never passes as record.
- **Output is ordered by the rule file's own order, never ranked.** No scoring, no "most important",
  no counts beyond the matched rules themselves.
- **Pull-only, like everything else here.** Nothing calls it on a schedule. It runs when the
  operator, or a session the operator is in, runs it. It never notifies.
- It is not a mind, a reflex arc, or a judgment. It is `grep` over a file you wrote, printing lines
  you wrote. The name says only that it fires without thinking.

## Ghostwriting — drafting as me — amended 2026-10-14

A fifth kind of pull, and the first that produces new prose rather than returning old words.

10. **Drafts in the operator's own mind and voice, from the operator's own material.**
   `ghostwrite "topic"` assembles two things the operator already owns — `SOUL.md`, a distillation of
   how the operator thinks and writes (itself built only from the operator's own corpus, every pattern
   pinned to a quote, the same discipline as `reflex`: the standard is the operator's, never the
   system's) and the top-k snippets `search` retrieves from the store — and sends them, with the topic,
   to the model through the one outbound path (`lib/ask.ts`). It returns a draft.

What it is bound by:

- **Same outbound discipline as `ask`.** It is the single hosted call, reused — no new network code, a
  test still enforces that `lib/ask.ts` and `lib/embed.ts` are the only files that may open a socket.
  Never the passphrase, never the whole store — only `SOUL.md` and the retrieved snippets leave. `--dry`
  prints exactly what would be sent and sends nothing. Like `ask`, `contradictions`, and `standing`, it
  refuses the real call inside an AI coding session (`CLAUDECODE` set); what leaves the machine is
  decided by a person at a terminal.
- **It drafts; it never delivers.** The output is a draft handed to the operator, nothing more. It does
  not send, post, publish, sign, or present itself as the operator to any person or system — that stays
  Tier 3 under `GOVERNANCE.md`, unchanged. A ghostwriter hands you pages; you decide what becomes of them.
- **It never invents a belief.** It writes from what `SOUL.md` records and what the store returns. Where
  the record is silent and `SOUL.md` predicts no clear stance, it writes the open question the operator
  would ask rather than manufacturing a position — surfacing the unsettled thing is itself one of the
  operator's documented moves. It must not put a conviction in the operator's mouth that the record does
  not support.
- **`SOUL.md` is the operator's own record, distilled — not a mind.** It predicts moves from evidence; it
  can be wrong or stale, and it carries no claim of sentience or agency. It is a profile built from the
  operator's writing, kept out of the public repo the same way `reviews/` is.
- **Reachable from the display, not only the CLI — amended 2026-10-18.** `ghostwrite` is also exposed as
  `POST /api/ghostwrite` by `scripts/serve.ts`, so the operator can draft from the browser — locally, or
  tunneled behind the token. It is the identical capability under identical bounds: the prompt assembly
  is shared code (`scripts/lib/ghostwrite.ts`), the model call is the same single outbound path, and it
  refuses when the server process was started inside an AI coding session (`CLAUDECODE` set). The draft
  is returned to the screen and sent, posted, and signed nowhere — the operator decides what becomes of
  the pages, exactly as with the CLI.

## The public page and the voice API — amended 2026-10-19

Two things leave the machine's loopback that did not before: a public web page about the JARVIS
dashboard, and a narrow, key-gated API over the operator's voices. Neither is the display, and
neither can reach the store.

11. **The public page is static and holds nothing.** It is HTML, CSS, and JavaScript on Vercel: what the
    product is, and a thin client that pairs back to the operator's machine with a URL and token the
    visitor types. No store, no `SOUL.md`, no key, no conversation, no sample of the operator's writing
    is ever deployed. `scripts/deploy-ui.sh` (in the app repo) stages an allowlist of files; anything
    not on it does not go up.
12. **The voice API is three operations, not the app.** `scripts/ext-api.ts` (app repo) is its own
    process on `127.0.0.1`. A caller with a key may: list the voices that key is allowed, ask for one
    piece in an allowed voice, and fetch the result of that request. It cannot reach chats, memory,
    the vault, uploads, personas, sessions, or any other route of the app; those are not proxied.
    - **Keys are the approval, and issuing one is a human act.** `ops/api-key.ts` refuses inside an AI
      coding session (`CLAUDECODE` set). A key is shown once and stored only as a SHA-256 hash outside
      the repo (`~/.config/jarvis/api-keys.json`). Each key carries a voice allowlist, a daily request
      cap, and can be revoked; a revoked, unknown, or exhausted key gets `401`/`429` and nothing else.
    - **Drafts, never delivery.** Every response is marked as a draft and says it was written in a voice
      from the operator's record, not by or for the operator. The API sends, posts, and signs nothing.
      Handing a key to another assistant lets that assistant request drafts; whether it submits one
      anywhere is that assistant's act and the operator's to review.
    - **No content in the audit log.** `~/.config/jarvis/api-audit.log` records time, key name, voice,
      request length, outcome. Never the request text, the readings, or the draft.
    - **Opening it beyond the machine is a human act.** The process binds loopback. A tunnel the operator
      runs, behind the Vercel gateway or directly, is what makes it reachable; `scripts/remote.sh`
      already refuses inside an AI coding session and the same holds here. The gateway on Vercel is a
      pass-through: it holds no keys, no store, no output, and an origin URL it cannot reach returns
      `503`, not data.
    - **Same outbound path as the app.** The model call is the one the app already makes for voices;
      no new socket-opening file in the memory repo, and the test pinning that is untouched.
13. **Voices share the author, not the format.** Every voice but the everyday one (`colin/chat`) adds a
    second layer to its prompt (`voiceprint/prose/core.ts`): sentences from the operator's own everyday
    writing chosen for the request, what marks that writing against generic AI, and the operator's own
    cuts and rewrites from edits to *other* voices. The measured bands still govern form and still gate
    the output; this layer governs word choice and stance. Typing slips (typos, lowercase "i", missing
    apostrophes) are excluded so they are not taught as language. It sends the operator's own words to
    the same provider through the same single call, nothing new and nothing to a new destination.
