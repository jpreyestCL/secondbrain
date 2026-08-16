<!-- English version. Spanish original: README.md -->

**English** · [Español](README.md)

# 🧠 secondbrain

Your **second brain**, conversational: a **temporal** knowledge graph where you keep
everything you need to remember — personal life, health, finances, work, projects — and
query it in **plain language from Claude** (web, desktop or mobile) through an MCP
connector. No new apps, no forms: you just talk to Claude.

What makes it different:

- **Temporal memory, with history.** Facts are never deleted. If your bank account
  changes, the system marks the previous one as valid up to that date and records the new
  one. Ask "what's my account?" → you get the current one. Ask "and before?" → you get the
  history with dates.
- **Remote document ingestion over MCP.** Attach a PDF, image, spreadsheet or text in a
  Claude chat and it reads, classifies and stores it in your graph. **No SSH, nothing
  uploaded to a server.**
- **You own your data.** Open-source engine ([Graphiti](https://github.com/getzep/graphiti)
  on [FalkorDB](https://www.falkordb.com/)). Use the public instance or self-host the
  whole thing.
- **Multi-user with hard isolation.** Each person gets their own graph, their own database
  user and their own process; nobody can see anyone else's data.

---

## 🌐 Public instance: `mybrain.rlz.cl`

There's an instance running at **`https://mybrain.rlz.cl`**. To use it:

1. In **claude.ai** (or Claude Desktop / mobile) → **Settings → Connectors → Add custom
   connector**.
2. Connector URL: **`https://mybrain.rlz.cl/mcp`**
3. An OAuth login opens; sign in with your account and your second brain is available in
   any conversation.

### How to use it (once connected)

**Saving** — just talk:
> "Remember that my Banco de Chile checking account is 123-456."
> "Note that in today's meeting we decided to use Postgres on project X."

**Ingesting a document** — attach it in the chat and ask it to be saved:
> *(you attach a PDF)* "Add this contract to my second brain."

Claude extracts the text (even from scanned PDFs and images, using its vision),
classifies it by domain, detects the document's real date and stores it section by
section.

**Querying**:
> "What's my bank account?" · "What do I know about project X?"
> "Who do I have an NDA with?" · "Give me the history of my accounts."

**Good practice:** state **explicit relationships** and **real dates** when saving; never
paste passwords or tokens verbatim (the system redacts them, but better not to).

---

## 🔌 Remote ingestion over MCP (no SSH, no uploads)

Ingestion never needs access to the server, in either of its two forms.

**Single documents, nothing to install.** When you connect through the connector, the MCP
server itself hands Claude the instructions for ingesting: Claude **reads the attachment**,
splits it, works out the domain and the real date, redacts secrets and calls the
`add_memory` tool once per section. All from your device.

**Whole folders, with the `brain` CLI.** One command to install, and it asks for no API
key:

```bash
curl -fsSL https://mybrain.rlz.cl/install.sh | sh
brain login https://mybrain.rlz.cl        # opens the browser once

brain add ~/Documents/inbox               # reads, classifies and sends
```

**Why it needs no keys**: of the six pipeline steps, five run locally and none uses a
language model — reading files, OCR, chunking. Entity extraction, which does need an LLM,
happens **on the server** with its models. That also removes the irreversible mistake of
ingesting with an embedding dimension different from the graph's: there is nothing to
match.

Under the hood it's five stages, each recording its result in a ledger. That matters at
volume: if OCR over hundreds of PDFs dies halfway, or the send fails, the retry resumes at
the failed document instead of redoing — and re-paying for — all of it.

```bash
brain scan <folder>      # register the files
brain extract            # text, OCR for images and scanned PDFs
brain classify --auto    # domain, type and the REAL date (no LLM)
brain chunk              # split
brain ingest-graph       # send to the server over the MCP connector
brain status             # which stage each document is in
```

Useful flags: `--exclude <folder>` skips duplicates or drafts; `--distill <folder>` has
Claude condense bulky, repetitive documents into facts instead of sending the raw text
(see **ADR-008**); `--redo` puts already-sent documents back in the queue after the
graph has been wiped.

> `--via falkordb` also exists, writing straight to the database. It's faster for very
> large batches, but FalkorDB only listens on the server's localhost: it requires admin
> access, an SSH tunnel and configuring the models by hand. See **ADR-007** in
> `docs/decisiones.md`.

---

## 🏗️ Architecture

```
  claude.ai (web/desktop/mobile)
        │  remote MCP connector (OAuth 2.1)
        ▼
  nginx ── gateway/ (:8787) ──►  Graphiti MCP (:8021 per tenant)
   TLS     OAuth + per-user         │ extraction + embeddings
           routing                  ▼
                             FalkorDB (temporal graph per tenant)
                                    ▲
                             LLM + embeddings (OpenAI / NVIDIA NIM / Ollama)
```

| Component | What it does |
|---|---|
| `gateway/` | OAuth 2.1 gateway (Better Auth). Authenticates and routes each user to **their** MCP. Self-service signup with tenant provisioning. |
| `infra/` | FalkorDB + one Graphiti MCP service per tenant. Docker Compose **or** native systemd deployment (`infra/deploy/native/`). Per-tenant FalkorDB ACLs. |
| `ingest/` | The `brain` CLI for bulk local ingestion: `scan → extract → classify → chunk → ingest-graph`, with a resumable ledger, OCR and secret redaction. |
| `.claude/skills/` | `/guardar`, `/ingest`, `/consultar` skills for using the brain from Claude Code. |
| `SCHEMA.md` | Ontology: domains, entities, edges, date and sensitivity rules. |
| `docs/decisiones.md` | Decision record (ADRs). |

**Bi-temporal model:** every fact records when it happened (`valid_at`/`invalid_at`) and
when it became known. When a value changes, the previous one is invalidated — not deleted
— so queries return the current state by default and the history when you ask for it.

**Isolation between users:** a separate graph per tenant (the graph name *is* the tenant)
+ its own FalkorDB ACL user + its own MCP process + gateway routing. A forgotten filter
cannot leak someone else's data, because they are separate processes and separate graphs.

---

## 🚀 Self-hosting

Requirements: Docker (or a Linux box for native mode), and an OpenAI-compatible API for
extraction + embeddings (cheap/free options: **NVIDIA NIM**, **OpenAI gpt-4o-mini**, or
local **Ollama** with a non-reasoning model).

⚠️ **DeepSeek does not work** for extraction (no `response_format: json_schema` support).

⚠️ **A local LLM on CPU is not viable for volume.** Measured on 8 cores without a GPU:
`gpt-4o-mini` ~15 s per episode, `qwen2.5:3b` 301 s (and it hallucinates), `phi4-mini`
702 s. Eleven models were tested; details in `CLAUDE.md`.

### With Docker Compose

```bash
git clone https://github.com/jpreyestCL/secondbrain && cd secondbrain

# 1) Root config: LLM + embeddings provider and FalkorDB admin password
cp .env.example .env
sed -i '' "s/^FALKORDB_PASSWORD=.*/FALKORDB_PASSWORD=$(openssl rand -hex 24)/" .env

# 2) Create your tenant and bring up FalkorDB + its MCP
make add-tenant NAME=yourname PORT=9021
make up

# 3) OAuth gateway
cd gateway && cp .env.example .env
#   set AUTH_SECRET (openssl rand -hex 32) and
#   GRAPHITI_MCP_URL=http://127.0.0.1:9021/mcp
npm ci && npm run build
npm run create-owner -- you@email.com 'your-password'
npm start                        # OAuth gateway on :8787
```

Expose the gateway over TLS (nginx/Cloudflare/tunnel) and add the
`https://your-domain/mcp` connector in claude.ai.

### Native, via systemd

For servers where you don't want Docker (reusing nginx, a separate redis, etc.), see
**`infra/deploy/native/README.md`**: native FalkorDB (redis 8 + module), MCP and gateway
under systemd, backups on a timer.

---

## 📄 Licence

Apache-2.0, like Graphiti.
