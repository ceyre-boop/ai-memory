---
task: "ai-memory foundation pass: constraints, ingester, encryption, push"
slug: 20260913-234958_ai-memory-foundation
project: ai-memory
effort: deep
effort_source: classifier
phase: build
progress: 0/146
mode: interactive
started: 2026-09-13T23:49:58Z
updated: 2026-09-13T23:55:00Z
---

## Problem

A person's AI conversation history is legally theirs and practically stranded inside provider accounts. `~/ai-memory` already sweeps local files into a 2 GB FTS5 index (collect.ts, query.ts, push.ts work), but it has no written rules about what it does with user data, cannot read a single provider export, stores everything in plaintext, and has no answer to "what happens when the chip is lost." Without the spine (CONSTRAINTS.md) every later component drifts; without the ingester there is nothing differentiated; without encryption the portable store is a liability, not an asset.

## Vision

The user drops the ZIP their provider emailed them onto one command, and minutes later every conversation they ever had — with its timestamps, threads, and who-said-what intact — is searchable from an encrypted file on a chip in their pocket. They read one page and know exactly what the system will and will not do with that file. When the chip is lost, they already know what that means because they read it before it happened. Euphoric surprise: the ingest summary says "116 conversations · 2,554 messages · skipped users.json (account identity — never stored)" and they realize the system is on their side by default.

## Out of Scope

- No fetching of exports from providers, no API calls, no browser automation against provider accounts. The user supplies the file.
- No credential handling of any kind for provider accounts. The store passphrase is the user's key, not a credential to anyone else.
- No embeddings, vector index, or semantic retrieval in this pass. Build order is fixed; step 4 follows 1–3.
- No retrieval/response character in this pass; the character contract is recorded for later.
- No key escrow, cloud backup, or recovery service. Losing the passphrase loses the data.
- No profile-building, cross-referencing, or enrichment of third parties named in conversations.
- No streaming JSON parser; archives are loaded whole (a multi-hundred-MB conversations.json is fine on a 24 GB machine).
- No Gemini HTML-format Takeout support; the JSON format is required and the error says so.
- No sentience, agency, or emergent-mind framing anywhere in docs or code.

## Principles

- The user owns the context and rents the model. Every design choice must survive the provider disappearing.
- Honesty over completeness: a flag saying "thread boundary inferred" beats a confident wrong thread.
- Provenance is preserved before convenience: branches, tool parts, and attachments are marked, never silently dropped.
- The written rule precedes the code that enforces it. CONSTRAINTS.md is the spine.
- Zero dependencies keeps the store readable in ten years with only bun and a cipher library.
- Every bulk or destructive operation rehearses first (`--dry`).
- Every claim of success carries the command and its real output.

## Constraints

- bun + TypeScript only; no npm, no Python, no packages in package.json.
- Encryption at rest is SQLCipher loaded through `Database.setCustomSQLite`; the encrypted database IS the corpus. `corpus/` is a user inbox the system never writes to and never copies to media.
- The store passphrase enters only via `AI_MEMORY_KEY`, `--key-file`, or an interactive no-echo prompt; it is never logged, written, or placed in manifest.json.
- push.ts must reopen the copied index on the target with the key and count rows before declaring success; it must refuse to copy a plaintext database.
- `--dry` exists on ingest, collect, encrypt, forget, and push.
- Existing tables (`files`, `chunks`, `docs`) and the 2 GB index are preserved through migration; row counts must match before the plaintext original is removed.
- ISC IDs never renumber.

## Goal

CONSTRAINTS.md is committed first; `bun scripts/ingest.ts <archive>` ingests ChatGPT, Claude, and Gemini exports into the store with timestamps, thread boundaries, and roles preserved, each proven by a fixture under `bun test`; `embeddings/index.db` is SQLCipher-encrypted with the plaintext removed after count verification; push.ts refuses plaintext and verifies the copied index on the target with the key.

## Criteria

### Repository and spine
- [ ] ISC-1: `~/ai-memory` is a git repository on branch `main` with ≥1 commit.
- [ ] ISC-2: `CONSTRAINTS.md` exists at repo root and is tracked by git.
- [ ] ISC-3: `CONSTRAINTS.md` is ≤120 lines (`wc -l`).
- [ ] ISC-4: `CONSTRAINTS.md` has a heading containing "does with your data".
- [ ] ISC-5: `CONSTRAINTS.md` has a heading containing "never does".
- [ ] ISC-6: `CONSTRAINTS.md` has a heading containing "drive is lost" and states the passphrase-only, no-escrow decision.
- [ ] ISC-7: `CONSTRAINTS.md` has a heading containing "Third parties".
- [ ] ISC-8: `CONSTRAINTS.md` states that the user supplies the export file and the system never fetches it.
- [ ] ISC-9: `CONSTRAINTS.md` states that plaintext never lands on removable media.
- [ ] ISC-10: `CONSTRAINTS.md` states the `--dry` rule.
- [ ] ISC-11: `README.md` documents init, ingest, query, collect, encrypt, forget, status, and push commands.
- [ ] ISC-12: `.gitignore` excludes `embeddings/`, `corpus/`, `.env`, and `*.key`.
- [ ] ISC-13: The first commit on `main` contains `CONSTRAINTS.md` and no `scripts/` changes (build order proven by `git log`).
- [ ] ISC-14: The repository has a private GitHub remote and `main` is pushed (`git status -sb` shows no `ahead`).

### Shared library
- [ ] ISC-15: `scripts/lib/db.ts` exports `openStore()`.
- [ ] ISC-16: `openStore()` calls `Database.setCustomSQLite` with a libsqlcipher path before any database opens.
- [ ] ISC-17: `AI_MEMORY_SQLCIPHER` overrides the cipher library path.
- [ ] ISC-18: A missing cipher library produces an error message that names the install command and exits non-zero.
- [ ] ISC-19: The passphrase is read from `AI_MEMORY_KEY` when set.
- [ ] ISC-20: The passphrase is read from the file named by `--key-file` (trailing newline stripped).
- [ ] ISC-21: With no key source and no TTY, scripts exit code 2 with a message naming the three key sources.
- [ ] ISC-22: A wrong passphrase produces the message "wrong passphrase or not an ai-memory store" and exit non-zero.
- [ ] ISC-23: Anti: no script prints the passphrase (test asserts stdout+stderr of every command exclude it).
- [ ] ISC-24: `conversations` table exists with columns id, provider, source_id, title, created_at, updated_at, message_count, thread_inferred, export_file, export_hash, imported_at.
- [ ] ISC-25: `messages` table exists with columns id, conversation_id, seq, role, created_at, body, parent_id, on_main_path, content_types.
- [ ] ISC-26: `messages_fts` is an FTS5 external-content table kept in sync by insert/delete/update triggers.
- [ ] ISC-27: `files` and `chunks` tables are unchanged in shape after migration (same column list).
- [ ] ISC-28: Calling `openStore()` twice on the same file raises no error (schema creation idempotent).
- [ ] ISC-29: `AI_MEMORY_HOME` overrides the store root directory.
- [ ] ISC-30: Anti: no `new Database(` call exists outside `scripts/lib/db.ts`, `scripts/encrypt.ts`, and `tests/`.

### Encryption at rest
- [ ] ISC-31: `scripts/encrypt.ts` exists with subcommands `migrate`, `rekey`, `check`.
- [ ] ISC-32: `encrypt.ts migrate --dry` prints the plan and leaves `embeddings/` byte-identical (mtimes unchanged, no new files).
- [ ] ISC-33: `migrate` exports via `sqlcipher_export` into a sibling file and compares `files`, `chunks`, `docs` counts before swapping.
- [ ] ISC-34: After migration the first 16 bytes of `embeddings/index.db` are not `SQLite format 3\0`.
- [ ] ISC-35: After migration, opening `embeddings/index.db` without a key fails with "file is not a database".
- [ ] ISC-36: After migration, `openStore()` with the key reports 905,205 chunks and 54,612 files.
- [ ] ISC-37: `migrate` on an already-encrypted file exits non-zero with "already encrypted".
- [ ] ISC-38: The plaintext original and its `-wal`/`-shm` sidecars are removed only after ISC-33 passes (test on a temp store).
- [ ] ISC-39: `rekey` changes the passphrase: old key fails, new key opens (temp store test).
- [ ] ISC-40: `check` reports `encrypted: true|false` from the header without needing a key.
- [ ] ISC-41: `scripts/status.ts` prints encrypted flag, row counts, and last pushes.
- [ ] ISC-42: Anti: no message body text from a temp store appears in its `-wal` file after a write (WAL pages encrypted).
- [ ] ISC-43: `tests/crypto.test.ts` covers ISC-35, ISC-37, ISC-39, ISC-42.
- [ ] ISC-44: Anti: no script writes under `corpus/` (grep for writes targeting the corpus path returns none).

### Ingester — general
- [ ] ISC-45: `scripts/ingest.ts` accepts a `.zip` path.
- [ ] ISC-46: `ingest.ts` accepts an extracted directory path.
- [ ] ISC-47: `ingest.ts` accepts a bare `conversations.json` or `MyActivity.json` file path.
- [ ] ISC-48: Provider is auto-detected from content (`mapping` → chatgpt, `chat_messages` → claude, `Gemini Apps` → gemini).
- [ ] ISC-49: `--provider chatgpt|claude|gemini` overrides detection.
- [ ] ISC-50: `--dry` prints conversation and message counts per role and leaves the database row counts unchanged.
- [ ] ISC-51: Zip entries are streamed with `unzip -p`; grep of `ingest.ts` shows no `mkdtemp`, `tmpdir`, or extraction to disk.
- [ ] ISC-52: When `unzip` is absent the error names the fallback (extract manually, pass the directory).
- [ ] ISC-53: Ingesting the same fixture twice leaves conversation and message counts unchanged.
- [ ] ISC-54: Ingesting a modified export with the same conversation source_id replaces that conversation's messages (upsert).
- [ ] ISC-55: Anti: `users.json` / `user.json` are never read; the fixture's account email does not appear anywhere in the database.
- [ ] ISC-56: The ingest summary lists skipped files by name with a reason.
- [ ] ISC-57: Anti: no `fetch(` and no provider hostname appears in `scripts/`.
- [ ] ISC-58: `created_at` values are integer unix milliseconds (`typeof === 'number'`, > 1e12).
- [ ] ISC-59: Messages with an empty body are skipped and counted as `empty_skipped`.
- [ ] ISC-60: A phrase from each fixture is returned by `query.ts` immediately after ingest.
- [ ] ISC-61: `content_types` is a JSON array string per message (e.g. `["thinking","text"]`).
- [ ] ISC-62: An unrecognised archive exits 1 with a message listing the three supported providers.
- [ ] ISC-63: `export_file` records the archive basename and `export_hash` a content hash of the parsed file.

### ChatGPT parser
- [ ] ISC-64: Parses a `conversations.json` array whose items carry `mapping`.
- [ ] ISC-65: `source_id` = `conversation_id` when present, else `id`.
- [ ] ISC-66: `title` is preserved verbatim.
- [ ] ISC-67: `created_at` = `create_time` seconds → ms.
- [ ] ISC-68: `updated_at` = `update_time` seconds → ms.
- [ ] ISC-69: Nodes on the path from `current_node` to the root have `on_main_path = 1`.
- [ ] ISC-70: Off-path nodes (edits/regenerations) are retained with `on_main_path = 0`.
- [ ] ISC-71: `seq` is depth-first with parent before child; sibling order follows `children`.
- [ ] ISC-72: Roles `user`, `assistant`, `system`, `tool` are stored verbatim.
- [ ] ISC-73: `content_type: text` parts are joined with newlines.
- [ ] ISC-74: `content_type: code` bodies are fenced with the language.
- [ ] ISC-75: `multimodal_text` image parts become `[image: <asset_pointer>]`.
- [ ] ISC-76: The root system node with empty parts is skipped.
- [ ] ISC-77: A null `create_time` yields `created_at = NULL`, never 0 or NaN.
- [ ] ISC-78: `parent_id` mirrors `mapping[id].parent`.
- [ ] ISC-79: Fixture `tests/fixtures/chatgpt/conversations.json` has 2 conversations, one with an edited branch.
- [ ] ISC-80: `tests/ingest.test.ts` asserts the ChatGPT fixture counts and the branch flag.

### Claude parser
- [ ] ISC-81: Parses a `conversations.json` array whose items carry `chat_messages`.
- [ ] ISC-82: `source_id` = `uuid`, `title` = `name`.
- [ ] ISC-83: ISO `created_at`/`updated_at` become ms integers.
- [ ] ISC-84: `sender: human` → `user`; `assistant` stays `assistant`.
- [ ] ISC-85: `text` content parts are concatenated in order.
- [ ] ISC-86: `thinking` parts are excluded from body by default and recorded in `content_types`.
- [ ] ISC-87: `--include-thinking` includes thinking text in the body.
- [ ] ISC-88: `tool_use` parts become `[tool_use: <name>]` and `tool_result` parts `[tool_result]` lines.
- [ ] ISC-89: When `content` is absent the `text` field is used.
- [ ] ISC-90: `attachments[].extracted_content` is appended as `[attachment: <file_name>]` followed by the content.
- [ ] ISC-91: `files[]` are listed as `[file: <file_name>]`.
- [ ] ISC-92: `parent_message_uuid` → `parent_id`.
- [ ] ISC-93: `seq` follows array order.
- [ ] ISC-94: Fixture `tests/fixtures/claude/conversations.json` is synthetic and includes thinking, tool_use, and an attachment.
- [ ] ISC-95: Test asserts Claude fixture counts and that thinking text is absent from bodies by default.
- [ ] ISC-96: `users.json`, `memories.json`, and `projects/` alongside the file are skipped and reported.

### Gemini parser
- [ ] ISC-97: Locates `My Activity/Gemini Apps/MyActivity.json` at any depth in a directory or zip.
- [ ] ISC-98: Only entries whose `products` include "Gemini Apps" are used.
- [ ] ISC-99: `title: "Prompted X"` becomes a `user` message with body X.
- [ ] ISC-100: `safeHtmlItem[].html` becomes an `assistant` message with tags stripped and entities decoded.
- [ ] ISC-101: Block-level HTML (`p`, `br`, `li`, `div`, headings) becomes newlines.
- [ ] ISC-102: `time` ISO → ms for both messages of a pair.
- [ ] ISC-103: Entries are sorted ascending by time before threading.
- [ ] ISC-104: Consecutive entries ≤30 minutes apart share a thread; `--gap-minutes` changes the window.
- [ ] ISC-105: Inferred threads have `thread_inferred = 1` and title = first prompt truncated to 80 chars.
- [ ] ISC-106: Thread ids are deterministic (hash of first entry time + text) so re-ingest is idempotent.
- [ ] ISC-107: An entry without `safeHtmlItem` yields the user message only.
- [ ] ISC-108: Fixture `tests/fixtures/gemini/Takeout/My Activity/Gemini Apps/MyActivity.json` has 4 entries forming 2 threads.
- [ ] ISC-109: Test asserts 2 conversations, `thread_inferred = 1`, and stripped HTML.
- [ ] ISC-110: An HTML-only Takeout (`MyActivity.html`, no JSON) exits 1 with "re-export as JSON".

### query.ts
- [ ] ISC-111: `query.ts` opens the store through `openStore()`.
- [ ] ISC-112: Results from conversations show provider, title, role, and date with a snippet.
- [ ] ISC-113: Results from files (`chunks`) still appear, labelled `file`.
- [ ] ISC-114: `--source conv|files|all` filters sources.
- [ ] ISC-115: `--limit N` caps results.
- [ ] ISC-116: No matches prints exactly "no matches".
- [ ] ISC-117: A query containing `"`, `:` or `*` does not throw (terms are quoted).
- [ ] ISC-118: A three-term query on the 2 GB encrypted index completes in ≤1,000 ms.

### collect.ts
- [ ] ISC-119: `collect.ts` opens the store through `openStore()`.
- [ ] ISC-120: `collect.ts --dry` leaves row counts unchanged.
- [ ] ISC-121: `collect.ts` on the fixtures directory indexes text files into `chunks` (count > 0).
- [ ] ISC-122: Anti: `collect.ts` skips the store's own `embeddings/` directory.

### forget.ts
- [ ] ISC-123: `scripts/forget.ts <conversation-id>` deletes the conversation and its messages.
- [ ] ISC-124: `forget.ts --provider X` deletes every conversation of that provider.
- [ ] ISC-125: `forget.ts --dry` prints what would be deleted and changes no counts.
- [ ] ISC-126: After forget, `query.ts` no longer returns the deleted text (FTS in sync).
- [ ] ISC-127: `forget.ts` with no selector exits 1 with usage.

### push.ts
- [ ] ISC-128: `push.ts` checkpoints the WAL before copying.
- [ ] ISC-129: The copy excludes `corpus/`, `.git/`, and `node_modules/` (absent on target).
- [ ] ISC-130: Anti: `push.ts` refuses with exit 1 when `embeddings/index.db` has a plaintext SQLite header.
- [ ] ISC-131: Verification reopens the copied index through `openStore()` with the key and prints chunks, files, conversations, messages counts.
- [ ] ISC-132: A failed reopen on the target exits 1 with "index did not open on target".
- [ ] ISC-133: `push.ts --dry` prints size, free space, and file list and copies nothing.
- [ ] ISC-134: `push.ts --pull` still works (temp target round-trip).
- [ ] ISC-135: A successful push appends `{target, at, counts}` to `manifest.json` `pushes[]`.
- [ ] ISC-136: Anti: `manifest.json` never contains the passphrase (test greps after push).
- [ ] ISC-137: `push.ts` prints the libsqlcipher install hint for the reader machine.
- [ ] ISC-138: `tests/push.test.ts` pushes a temp store to a temp target and passes verification.

### Tests, hygiene, real data
- [ ] ISC-139: `bun test` passes with 0 failures.
- [ ] ISC-140: Anti: `tests/` never reference `embeddings/index.db`; every test sets `AI_MEMORY_HOME` to a temp dir.
- [ ] ISC-141: Every script prints usage and exits non-zero when called with no arguments (or `--help`).
- [ ] ISC-142: `package.json` has no `dependencies` or `devDependencies` keys.
- [ ] ISC-143: Anti: grep finds no `/Users/taboost` in tracked files.
- [ ] ISC-144: `ingest.ts --dry` on the real Claude export reports 116 conversations.
- [ ] ISC-145: The real Claude export is ingested into the encrypted store and `query.ts` returns a hit from it.
- [ ] ISC-146: `manifest.json` stats include conversations and messages counts; Obsidian `NEXT.md` carries the ai-memory state line.

## Test Strategy

| isc | type | check | threshold | tool |
|---|---|---|---|---|
| 1–14 | file/git | grep headings, wc -l, git log order, git status -sb | exact | Bash |
| 15–30 | unit | open temp store with/without key, schema pragma table_info | exact | bun test |
| 31–44 | unit + live | temp-store migrate/rekey; header bytes; real index counts | 905,205 / 54,612 | bun test, Bash |
| 45–63 | unit | ingest fixtures via CLI in temp AI_MEMORY_HOME, count rows | exact counts | bun test |
| 64–110 | unit | per-parser assertions on fixture rows | exact | bun test |
| 111–118 | live | query CLI output on temp store and on real index with timing | ≤1000 ms | Bash |
| 119–127 | unit | collect/forget CLI on temp store | exact | bun test |
| 128–138 | unit | push to temp target dir; plaintext refusal; manifest grep | exit codes | bun test |
| 139–146 | live | bun test summary; greps; real export dry + ingest; NEXT.md grep | 0 failures | Bash |

## Features

| name | description | satisfies | depends_on | parallelizable |
|---|---|---|---|---|
| constraints-doc | CONSTRAINTS.md + README + .gitignore, first commit | 1–14 | — | no (must land first) |
| store-lib | lib/db.ts openStore, key sourcing, schema, AI_MEMORY_HOME | 15–30 | constraints-doc | no |
| encryption | encrypt.ts migrate/rekey/check, status.ts, crypto tests | 31–44 | store-lib | yes (Forge) |
| ingester-core | ingest.ts CLI, archive reading, detection, upsert, summary | 45–63 | store-lib | yes (main) |
| parser-chatgpt | tree walk, main path, content types, fixture | 64–80 | ingester-core | yes |
| parser-claude | parts, thinking flag, attachments, fixture | 81–96 | ingester-core | yes |
| parser-gemini | Takeout locate, HTML strip, gap threading, fixture | 97–110 | ingester-core | yes |
| query-collect | port query.ts and collect.ts to openStore, unified search | 111–122 | store-lib | yes (Forge) |
| forget | forget.ts with --dry | 123–127 | store-lib | yes (Forge) |
| push | push.ts plaintext refusal, keyed verify, --dry, manifest pushes | 128–138 | store-lib | yes (Forge) |
| real-data | migrate the 2 GB index, ingest real Claude export, NEXT.md | 139–146 | all | no |

## Decisions

- 2026-09-13T23:49Z — SQLCipher over encrypted volume: cross-platform, per-file, and push.ts can verify by reopening with the key. Volume approach is macOS-only and unverifiable from bun.
- 2026-09-13T23:49Z — Recovery: passphrase-only, no escrow, no recovery key. Losing every copy or the passphrase loses everything; mitigation is multiple verified pushes. Simpler construction, nothing to get wrong.
- 2026-09-13T23:49Z — The encrypted database is the corpus; `corpus/` is an inbox the system never writes and never pushes. Resolves the "nothing writes to corpus/ unencrypted" rule without a second encryption layer.
- 2026-09-13T23:49Z — Zip entries stream via `unzip -p`; no plaintext temp extraction.
- 2026-09-13T23:49Z — Gemini thread boundaries are inferred (30-minute gap) and flagged; Takeout has no thread id.
- 2026-09-13T23:49Z — Claude `thinking` excluded from bodies by default (`--include-thinking` to keep); tool parts summarized as markers so provenance survives without FTS noise.
- 2026-09-13T23:49Z — Account identity files (users.json/user.json) are never read. Added `forget.ts` so the third-party policy in CONSTRAINTS.md is backed by a real deletion path.
- 2026-09-13T23:49Z — Work happens in `~/ai-memory` (where code and index live); the cwd `~/-ai-memory` is an empty stray repo, left untouched.
- 2026-09-13T23:49Z — Delegation: Forge takes encryption/query-collect/forget/push slice after store-lib lands; main thread writes the ingester (the product). Cato audits at VERIFY.

## Changelog

- 2026-09-13T23:49Z — conjectured: `corpus/` must itself be encrypted to satisfy the hard rule. refuted_by: FirstPrinciples challenge — the rule forbids the *system* writing plaintext there; documents can live inside the encrypted DB. learned: name the corpus correctly and the second encryption layer disappears. criterion_now: ISC-44 (no script writes under corpus/) and ISC-129 (push excludes corpus/).

## Verification

_(populated at VERIFY)_
