# brain_ingest

Ingestion pipeline for a personal second brain backed by
[Graphiti](https://github.com/getzep/graphiti) (temporal knowledge graph) +
FalkorDB. Pinned to `graphiti-core[falkordb]==0.29.3` (plus `redis<8.1` —
falkordb 1.6.2 is incompatible with redis 8.1's client kwargs).

```
uv sync --all-extras     # --all-extras pulls in ocrmac (macOS Vision OCR)
uv run brain --help
```

## Pipeline

```
uv run brain scan <folder>       # hash files, upsert into the ledger (idempotent)
uv run brain extract             # pending -> extracted (~/.brain/<tenant>/extracted/)
uv run brain classify            # emit work manifest (NO LLM calls happen here)
#   ... fill the manifest in with Claude Code ...
uv run brain classify --apply ~/.brain/<tenant>/work/classify-<batch>.json
uv run brain chunk               # structural chunking (~1200 tokens, 150 overlap)
uv run brain ingest-graph        # push chunks as Graphiti episodes to FalkorDB
uv run brain status              # ledger summary
uv run brain expire <doc_id>     # remove a doc's episodes from the graph
```

Global flags: `--tenant <name>` (overrides config), `-v/--verbose`.

## Multi-tenancy

Hard isolation per tenant:

* State: `~/.brain/<tenant>/{ledger.sqlite, extracted/, chunks/, work/}`.
* Graph: FalkorDB graph named `brain_<tenant>` (FalkorDriver `database=`).
* Active tenant comes from `tenant` in `~/.brain/config.toml`
  (default `jpreyest`), overridden by `brain --tenant <name> ...`.
* `group_id` inside a tenant's graph is the document domain
  (`personal`, `salud`, `finanzas`, `trabajo`, `proyectos`).

## Configuration

`~/.brain/config.toml` (created with defaults on first run): `tenant`,
`archive_dir`, `domains`. `BRAIN_HOME` env var relocates `~/.brain` (used by
tests).

Environment for `ingest-graph` / `expire`:

| Variable | Meaning |
|---|---|
| `FALKORDB_HOST` / `FALKORDB_PORT` | FalkorDB address (default `localhost:6379`) |
| `FALKORDB_USERNAME` / `FALKORDB_PASSWORD` | optional auth |
| `OPENAI_API_KEY` | use OpenAI for LLM + embeddings (graphiti defaults) |
| `OLLAMA_BASE_URL` | use local Ollama (OpenAI-compatible endpoint) instead |
| `OLLAMA_LLM_MODEL` / `OLLAMA_EMBED_MODEL` | Ollama model names |

An LLM client is only configured when one of `OPENAI_API_KEY` /
`OLLAMA_BASE_URL` is present; otherwise `ingest-graph` exits with a config
error.

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
