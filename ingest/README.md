# brain_ingest

Ingestion pipeline for a personal second brain backed by
[Graphiti](https://github.com/getzep/graphiti) (temporal knowledge graph) +
FalkorDB. Pinned to `graphiti-core[falkordb]==0.29.3` (plus `redis<8.1` —
falkordb 1.6.2 is incompatible with redis 8.1's client kwargs).

```
uv sync --all-extras     # --all-extras pulls in ocrmac (macOS Vision OCR)
uv run brain --help
```

### Running `brain` from anywhere

Configuration lives in `~/.brain/env` (`KEY=value`, one per line, mode 600),
**not** in the repo's `.env`. That matters more than it looks: `graphiti_core`
calls `load_dotenv()`, which walks up from the *current directory*, so a CLI
that reads the repo `.env` works inside the repo and breaks outside it — and it
breaks silently, falling back to defaults instead of stopping. Variables already
present in the environment win, so you can override one without editing the file.

Then drop a launcher on your `PATH`:

```bash
cat > ~/.local/bin/brain <<'SH'
#!/usr/bin/env bash
set -euo pipefail
exec uv run --quiet --project "${BRAIN_REPO:-$HOME/work/secondbrain}/ingest" \
     --all-extras brain "$@"
SH
chmod +x ~/.local/bin/brain
```

Prefer this over `uv tool install`: `uv tool` resolves dependencies on its own
and ignores `uv.lock`, which pulled `openai 3.0.0` where this project pins
`2.53.0` — a different LLM client than the one everything was verified against.

## Pipeline

One command does the whole thing:

```
brain login https://<host>        # once: authenticate against the server
brain add <folder>                # read, classify, chunk and send
brain add <folder> --revisar      # ...but stop before sending, so you can check
```

Underneath it is five stages, each recording its result in the ledger. You rarely
run them by hand, but they exist because **that's what makes failure cheap**: when
OCR over hundreds of PDFs dies halfway, or the server hangs mid-send, the retry
resumes at the failed document instead of redoing — and re-paying for — all of it.
They also let you fix the pipeline mid-flight: patch the extractor, re-run
`extract` on just the affected files, and carry on.

```
brain scan <folder>       # hash files, upsert into the ledger (idempotent)
brain extract             # pending -> extracted (~/.brain/<tenant>/extracted/)
brain classify --auto     # domain, doc_type and the REAL date — no LLM involved
brain chunk               # structural chunking (~1200 tokens, 150 overlap)
brain ingest-graph        # push chunks as episodes (via MCP by default)
brain status              # ledger summary
brain expire <doc_id>     # remove a doc's episodes from the graph
```

`classify` without `--auto` writes the manifest for a human (or Claude Code) to
fill in; `--apply` reads it back. That path is still there for documents whose
date or domain you want to set yourself.

Global flags: `--tenant <name>` (overrides config), `-v/--verbose`.

## Multi-tenancy

Hard isolation per tenant:

* State: `~/.brain/<tenant>/{ledger.sqlite, extracted/, chunks/, work/}`.
* Graph: the FalkorDB graph is named after the tenant (`jpreyest`), passed as
  the FalkorDriver `database=`.
* Active tenant comes from `tenant` in `~/.brain/config.toml`
  (default `jpreyest`), overridden by `brain --tenant <name> ...`.
* **`group_id` is the tenant, never the domain.** The FalkorDB driver uses
  `group_id` as the graph name, so a domain there would make every tenant's
  `salud` documents land in one shared graph — the exact leak the per-tenant
  graph exists to prevent. The domain travels as metadata: `[<dominio>]`
  prefixing the episode name, and a structured `source_description`
  (`dominio: <d> | tipo: <t> | origen: <o>`). See rule 6 in `CLAUDE.md`.

## Configuration

`~/.brain/config.toml` (created with defaults on first run): `tenant`,
`archive_dir`, `domains`. `BRAIN_HOME` env var relocates `~/.brain` (used by
tests).

Environment for `ingest-graph` / `expire`:

| Variable | Meaning |
|---|---|
| `FALKORDB_HOST` / `FALKORDB_PORT` | FalkorDB address (default `localhost:6379`) |
| `FALKORDB_USERNAME` / `FALKORDB_PASSWORD` | optional auth |
| `LLM_API_KEY` / `LLM_API_URL` / `LLM_MODEL` | chat model used to extract entities |
| `EMBEDDER_API_KEY` / `EMBEDDER_API_URL` / `EMBEDDER_MODEL` / `EMBEDDER_DIMENSIONS` | embeddings, configured **separately** |
| `LLM_TIMEOUT_SECONDS` | per-request timeout for all three clients (default 120) |
| `OPENAI_API_KEY` / `OPENAI_API_URL` / `MODEL_NAME` | legacy fallback for both when the split vars are unset |
| `OLLAMA_BASE_URL` | use local Ollama (OpenAI-compatible endpoint) instead |
| `OLLAMA_LLM_MODEL` / `OLLAMA_EMBED_MODEL` | Ollama model names |

Chat and embeddings take **separate keys and URLs** on purpose: the working
setup is gpt-4o-mini for extraction plus NVIDIA `nv-embed-v1` (4096 dims) for
embeddings, and a single shared key sends one provider the other's credential
(a 401 on every embedding call). Changing the embedder's provider or dimension
corrupts semantic search on an existing graph — it cannot be undone by
re-ingesting.

An LLM client is only configured when one of `LLM_API_KEY` / `OPENAI_API_KEY` /
`OLLAMA_BASE_URL` is present; otherwise `ingest-graph` exits with a config
error.

### Which graph am I writing to?

`ingest-graph` writes **straight to FalkorDB**, so the destination is whatever
`FALKORDB_HOST:FALKORDB_PORT` resolves to — with no record of it in the ledger.
On a machine running the Docker stack, `127.0.0.1:6379` is the **local**
FalkorDB, not the server's (which listens on the server's `:6380` and needs an
explicit SSH tunnel on some *other* local port). Writing to the wrong one fails
silently: the run succeeds, the ledger is consistent, and the data is simply
absent from the graph anyone queries. Check with `docker ps` and
`lsof -nP -iTCP:6379 -sTCP:LISTEN` before starting a batch.

Use `--via mcp --url https://<host>/mcp` to push through the authenticated MCP
endpoint instead; that path needs no tunnel and no model configuration, because
the server supplies both.

## Classification manifest schema (schema_version 1)

`brain classify` writes `~/.brain/<tenant>/work/classify-<batch>.json`.
It performs **no LLM calls** — a Claude Code session fills it in.

```jsonc
{
  "schema_version": 1,
  "batch": "20260809-151233",             // UTC timestamp batch id
  "created_at": "2026-08-09T15:12:33+00:00",
  "instructions": "...",                  // how to fill this file in
  "domains": ["personal", "salud", "finanzas", "trabajo", "proyectos"],
  "documents": [
    {
      "doc_id":  "e6a7...",               // read-only, do not modify
      "path":    "/abs/source/path.pdf",  // read-only
      "excerpt": "first 2000 words ...",  // read-only
      // fill these in (start as null / []):
      "domain":   "finanzas",             // MUST be one of top-level `domains`
      "doc_type": "factura",              // short lowercase noun
      "doc_date": "2024-03-15",           // ISO 8601 date/datetime; null if unknown
      "sensitivity_flags": ["financial"]  // [] if none; suggested values:
                                          // medical, financial, legal,
                                          // credentials, pii
    }
  ]
}
```

`--apply` rules: unknown `doc_id` → error, skipped; `domain` not in `domains`
→ warning, still applied; invalid `doc_date` → error, skipped; `domain: null`
→ document left pending classification.

## Sensitivity

`redact.py` runs on every chunk before it reaches the graph: passwords
(`password:`/`contraseña=`...), API keys/tokens (OpenAI, AWS, GitHub, Slack,
Google, generic `api_key=`, bearer tokens, PEM private keys) and
Luhn-validated credit card numbers are replaced with
`[CREDENCIAL-REDACTADA ver archivo original]`. Chilean RUTs are flagged
(`rut`) but never redacted. Flags are recorded in the ledger.

## Ledger versioning

Each `(path, sha256)` is one row with its own `doc_id`. When a file changes,
the old row is marked `superseded` and its Graphiti episodes flagged
`pending_expiry`; the new content gets a fresh `doc_id` starting at `pending`.
`brain expire <doc_id>` calls `Graphiti.remove_episode(episode_uuid)` for each
recorded episode (graphiti-core 0.29.3 has no soft-invalidate API; the ledger
keeps the audit trail).

## Tests

```
uv run pytest
```

OCR tests are skipped automatically when neither ocrmac (macOS Vision) nor
tesseract is available.
