# ai-memory

Portable, vendor-independent personal memory store. You export your conversation history from
ChatGPT, Claude, or Gemini; this ingests it into one encrypted, searchable SQLite file you can carry
on removable media. Read [CONSTRAINTS.md](CONSTRAINTS.md) first — it is the contract.

Zero dependencies: bun, `bun:sqlite`, and a SQLCipher library on the machine that opens the store.

## init (once per machine)

```sh
brew install sqlcipher            # macOS   (Debian/Ubuntu: apt install libsqlcipher0)
export AI_MEMORY_KEY='a long passphrase you will not forget'
```

The passphrase can also come from `--key-file <path>` or an interactive prompt. It is never
written anywhere by these scripts. There is no recovery if you lose it.

## commands

| command | what it does |
|---|---|
| `bun scripts/ingest.ts <export.zip\|dir\|file> [--provider chatgpt\|claude\|gemini] [--dry] [--include-thinking] [--gap-minutes 30]` | Parse a provider export into the store. Auto-detects the provider. |
| `bun scripts/query.ts "question" [--limit 5] [--source all\|conv\|files]` | Full-text search over conversations and collected files. |
| `bun scripts/collect.ts <dir...> [--max-mb 5] [--dry]` | Sweep local folders (notes, code) into the same store. |
| `bun scripts/encrypt.ts migrate\|rekey\|check [--dry]` | Migrate a plaintext index to SQLCipher, change the passphrase, or report the encryption state. |
| `bun scripts/forget.ts <conversation-id> \| --provider X [--dry]` | Delete conversations and their search entries. |
| `bun scripts/status.ts` | Encryption state, row counts, recorded pushes. |
| `bun scripts/push.ts /Volumes/CHIP [--dry] [--pull]` | Copy the store to media, then reopen and count it there. Refuses plaintext. |

`--dry` prints the plan and writes nothing. Every bulk or destructive command has it.

## getting your export

- **ChatGPT**: Settings → Data controls → Export data. You receive a zip with `conversations.json`.
- **Claude**: Settings → Privacy → Export data. You receive a zip with `conversations.json`.
- **Gemini**: takeout.google.com → select only "My Activity" → Gemini Apps → format **JSON**.
  Takeout has no thread ids; threads are inferred by time gap and flagged `thread_inferred`.

## layout

```
CONSTRAINTS.md        the contract
scripts/              ingest, query, collect, encrypt, forget, status, push
scripts/lib/          openStore(), key handling, schema, parsers
tests/                bun test; fixtures/ holds one synthetic export per provider
embeddings/index.db   the store (SQLCipher) — the corpus lives here
corpus/               your plaintext inbox; never written by the system, never pushed
manifest.json         stats and verified pushes; no secrets
```

## tests

```sh
bun test
```
