"""Graphiti + FalkorDB integration.

Verified against graphiti-core 0.29.3:

* ``FalkorDriver(host, port, username, password, database)``
  (graphiti_core.driver.falkordb_driver)
* ``Graphiti(graph_driver=..., llm_client=..., embedder=...)``
* ``Graphiti.add_episode(name, episode_body, source_description,
  reference_time, source=EpisodeType..., group_id=...) -> AddEpisodeResults``
  (results carry ``.episode.uuid`` which we record in the ledger)
* ``Graphiti.remove_episode(episode_uuid)`` — used by ``brain expire``.

Tenancy model (empirically verified): the FalkorDB graph name IS the episode
``group_id`` — FalkorDriver ignores its ``database`` parameter for data
operations. Therefore ``group_id == tenant`` ALWAYS (one graph per tenant),
and the DOMAIN (personal, salud, ...) travels as metadata only: in the
``source_description`` (``dominio: <dominio> | tipo: <doc_type> |
origen: <descripcion>``) and as a ``[<dominio>]`` prefix in the episode name.

Connection environment / credentials:

* ``FALKORDB_HOST`` / ``FALKORDB_PORT`` (default localhost:6379).
* Per-tenant ACL credentials, resolved in this precedence order:
  1. env ``FALKORDB_TENANT_USER`` / ``FALKORDB_TENANT_PASSWORD``
  2. ``~/.brain/config.toml`` keys ``falkordb_tenant_user`` /
     ``falkordb_tenant_password``
  3. legacy ``FALKORDB_USERNAME`` / ``FALKORDB_PASSWORD`` env vars
  If a password is found without a username, the username defaults to
  ``tenant_<tenant>`` (the ACL naming convention in ``infra/tenants/``).
* Embedder/LLM: ``OPENAI_API_KEY`` (OpenAI) or ``OLLAMA_BASE_URL`` (local
  Ollama; models via ``OLLAMA_LLM_MODEL`` / ``OLLAMA_EMBED_MODEL``).
  An LLM client is only configured when one of these is present.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from .config import Config
from .ledger import Ledger
from .redact import redact

log = logging.getLogger("brain")


class GraphConfigError(RuntimeError):
    pass


def graph_database(tenant: str) -> str:
    """FalkorDB graph name for a tenant (hard isolation: one graph per tenant).

    The graph name equals the tenant name because the FalkorDB driver uses the
    episode ``group_id`` as the graph name and we always send
    ``group_id == tenant``.
    """
    return tenant


def tenant_credentials(tenant: str) -> tuple[str | None, str | None]:
    """Resolve the per-tenant FalkorDB ACL credentials.

    Precedence: FALKORDB_TENANT_USER/FALKORDB_TENANT_PASSWORD env vars, then
    ``falkordb_tenant_user``/``falkordb_tenant_password`` in
    ``~/.brain/config.toml``, then the legacy FALKORDB_USERNAME/
    FALKORDB_PASSWORD env vars. Username defaults to ``tenant_<tenant>``
    when a password is available without an explicit username.
    """
    import tomllib

    from .config import brain_home

    user = os.environ.get("FALKORDB_TENANT_USER")
    password = os.environ.get("FALKORDB_TENANT_PASSWORD")

    if user is None or password is None:
        cfg_path = brain_home() / "config.toml"
        if cfg_path.exists():
            try:
                data = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
            except tomllib.TOMLDecodeError:
                data = {}
            if user is None:
                user = data.get("falkordb_tenant_user")
            if password is None:
                password = data.get("falkordb_tenant_password")

    if user is None:
        user = os.environ.get("FALKORDB_USERNAME")
    if password is None:
        password = os.environ.get("FALKORDB_PASSWORD")

    if password is not None and user is None:
        user = f"tenant_{tenant}"
    return user, password


def build_graphiti(tenant: str):
    """Construct a Graphiti instance for ``tenant`` from environment variables."""
    from graphiti_core import Graphiti
    from graphiti_core.driver.falkordb_driver import FalkorDriver

    llm_client = None
    embedder = None
    cross_encoder = None

    ollama_url = os.environ.get("OLLAMA_BASE_URL")
    if not ollama_url and not os.environ.get("OPENAI_API_KEY"):
        raise GraphConfigError(
            "No embedder/LLM configured: set OPENAI_API_KEY or OLLAMA_BASE_URL."
        )

    if ollama_url:
        from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
        from graphiti_core.llm_client.config import LLMConfig
        from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient

        llm_client = OpenAIGenericClient(
            config=LLMConfig(
                api_key="ollama",
                model=os.environ.get("OLLAMA_LLM_MODEL", "llama3.1:8b"),
                base_url=ollama_url,
            )
        )
        embedder = OpenAIEmbedder(
            config=OpenAIEmbedderConfig(
                api_key="ollama",
                embedding_model=os.environ.get("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
                base_url=ollama_url,
            )
        )
    # else: OPENAI_API_KEY is set — leaving clients as None lets graphiti
    # construct its OpenAI defaults.

    username, password = tenant_credentials(tenant)
    driver = FalkorDriver(
        host=os.environ.get("FALKORDB_HOST", "localhost"),
        port=int(os.environ.get("FALKORDB_PORT", "6379")),
        username=username,
        password=password,
        # Graph selection actually comes from group_id == tenant (the driver
        # uses group_id as the graph name); setting database to the same value
        # keeps the driver's init path consistent.
        database=graph_database(tenant),
    )

    return Graphiti(
        graph_driver=driver,
        llm_client=llm_client,
        embedder=embedder,
        cross_encoder=cross_encoder,
    )


def _reference_time(row) -> datetime:
    if row.doc_date:
        try:
            dt = datetime.fromisoformat(row.doc_date)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except ValueError:
            pass
    return datetime.fromtimestamp(row.mtime, tz=timezone.utc)


async def ingest_chunks(cfg: Config, ledger: Ledger, doc_ids: list[str] | None = None) -> dict[str, int]:
    """Push chunk files of classified docs to Graphiti as episodes."""
    from graphiti_core.nodes import EpisodeType

    graphiti = build_graphiti(cfg.tenant)
    counts = {"docs": 0, "episodes": 0, "errors": 0}
    try:
        await graphiti.build_indices_and_constraints()

        rows = (
            [r for r in (ledger.get(d) for d in doc_ids) if r]
            if doc_ids
            else list(ledger.by_status("classified"))
        )
        for row in rows:
            chunks_path = cfg.chunks_dir / f"{row.doc_id}.json"
            if not chunks_path.exists():
                log.warning("doc %s has no chunks file — run `brain chunk` first", row.doc_id)
                continue
            chunks = json.loads(chunks_path.read_text(encoding="utf-8"))
            is_json = (cfg.extracted_dir / f"{row.doc_id}.json").exists()
            name_stem = Path(row.path).name
            domain = row.domain or "personal"
            try:
                for chunk in chunks:
                    result = redact(chunk["text"])
                    if result.flags:
                        ledger.add_sensitivity_flags(row.doc_id, result.flags)
                    episode = await graphiti.add_episode(
                        name=(
                            f"[{domain}] {name_stem} "
                            f"[{chunk['chunk_idx'] + 1}/{chunk['total_chunks']}]"
                        ),
                        episode_body=result.text,
                        source_description=(
                            f"dominio: {domain} | tipo: {row.doc_type or 'documento'} | "
                            f"origen: documento {row.path} (doc_id={row.doc_id})"
                        ),
                        reference_time=_reference_time(row),
                        source=EpisodeType.json if is_json else EpisodeType.text,
                        # group_id is ALWAYS the tenant: the FalkorDB driver
                        # uses it as the graph name. The domain is metadata
                        # (name prefix + source_description), never a group_id.
                        group_id=cfg.tenant,
                    )
                    ledger.record_episode(
                        episode.episode.uuid, row.doc_id, chunk["chunk_idx"], row.domain
                    )
                    counts["episodes"] += 1
                ledger.set_status(row.doc_id, "ingested")
                counts["docs"] += 1
            except Exception as exc:  # noqa: BLE001 — record per-doc failures
                log.exception("ingest failed for %s", row.path)
                ledger.set_status(row.doc_id, "error", error=str(exc)[:500])
                counts["errors"] += 1
    finally:
        await graphiti.close()
    return counts


async def expire_doc(cfg: Config, ledger: Ledger, doc_id: str) -> int:
    """Remove all active Graphiti episodes of ``doc_id`` (supersession).

    graphiti-core 0.29.3 supports hard removal via
    ``Graphiti.remove_episode(episode_uuid)``; there is no soft "invalidate
    episode" API, so removal is the supported supersession mechanism. The
    ledger keeps the audit trail (episodes marked ``expired``).
    """
    episodes = ledger.episodes_for_doc(doc_id, only_active=True)
    if not episodes:
        log.info("no active episodes recorded for doc %s", doc_id)
        return 0
    graphiti = build_graphiti(cfg.tenant)
    removed = 0
    try:
        for ep in episodes:
            await graphiti.remove_episode(ep["episode_uuid"])
            ledger.mark_episode_expired(ep["episode_uuid"])
            removed += 1
    finally:
        await graphiti.close()
    return removed
