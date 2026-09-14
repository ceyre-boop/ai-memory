# What is on this drive

This folder is a copy of one person's **ai-memory** store: their own AI conversation history,
exported from the providers and kept as a single encrypted database.

```
ai-memory/
  embeddings/index.db          the store — SQLCipher-encrypted SQLite (ciphertext; opaque without the passphrase)
  embeddings/index.db.meta.json  cipher parameters only (no secrets) so the file stays openable years from now
  scripts/                     the tools: ingest, query, ask, collect, encrypt, forget, status, push, serve
  ui/                          the local display served by scripts/serve.ts
  tests/                       bun test; fixtures are synthetic
  manifest.json                row counts and the log of verified pushes (no secrets)
  CONSTRAINTS.md               the contract — read it before anything else
  README.md · ISA.md · docs/   how to run it, and the system of record for how it was built
```

**Nothing on this drive can open the store.** The passphrase is not here and there is no recovery key.
Whoever holds this drive without the passphrase holds ciphertext.

Never on this drive, by construction (`push` uses an allowlist and scans the copy):
`.env`, `*.key`, `corpus/` (the plaintext inbox), `wip/`, `.git/`, the original export archives.

## To open it on another machine

```sh
brew install sqlcipher                      # or: apt install libsqlcipher0
cd /Volumes/<this drive>/ai-memory
bun scripts/status.ts                       # prompts for the passphrase; prints counts
bun scripts/query.ts "a phrase you remember"
bun scripts/ask.ts "a question about your own history"   # needs the claude CLI signed in, or an API key
```

`bun scripts/push.ts /Volumes/<this drive> --pull` copies the store back to a machine — after
verifying the copy opens with the passphrase, never before.
