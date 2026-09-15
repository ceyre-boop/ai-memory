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
  sent and sends nothing.
  `contradictions` shares that same one file, same provider, same rule — it sends a topic plus the
  top-k snippets and nothing else, to find where your own record asserts one thing at two different
  times, not to judge which is true. Never the passphrase, never the whole store. A test enforces that `scripts/lib/ask.ts` is the
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

## Rules that every component inherits

- The user supplies the export file. The system never fetches it.
- Nothing writes to `corpus/` unencrypted. The encrypted database is the corpus.
- `--dry` on every destructive or bulk operation.
- `push` verification is mandatory: reopen the index on the target after the copy.
- Copying to removable media is a human act. `push` refuses to write to a target when it is run from
  inside an AI coding session (the `CLAUDECODE` environment variable is set); from there only `--dry` works.
  What goes on the chip, and therefore what the assistant can ever recall, is decided by a person at a
  terminal.
- Changing any rule on this page requires editing this page first, in its own commit.
