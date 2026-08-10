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
  At least one of these must be present. The LLM client is ALWAYS built
  explicitly (never left to graphiti's default) so that ``MODEL_NAME`` is
  honoured, and the real API key is only withheld from local endpoints.
"""

from __future__ import annotations

import asyncio
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


#: Placeholder key for local OpenAI-compatible servers (Ollama, vLLM, LM Studio)
#: which require a non-empty Authorization header but ignore its value.
LOCAL_API_KEY_PLACEHOLDER = "ollama"


#: Hostnames considered "local" — a real API key is never sent to these.
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal", "ollama"}


def _is_local_endpoint(url: str) -> bool:
    from urllib.parse import urlparse

    host = (urlparse(url).hostname or "").lower()
    return host in _LOCAL_HOSTS or host.endswith(".local")


def _api_key_for(url: str | None, openai_key: str | None) -> str:
    """Pick the API key to send to ``url``.

    The real ``OPENAI_API_KEY`` is used whenever the endpoint is the official
    OpenAI API, some other remote OpenAI-compatible provider (DeepSeek, Groq,
    ...), *or* unset — an unset ``base_url`` means the SDK default, which IS
    api.openai.com. Only a *local* endpoint (Ollama, vLLM, LM Studio) gets the
    inert ``"ollama"`` placeholder, so a real key is never leaked to it.

    Bug this fixes: the previous expression sent the literal string ``"ollama"``
    whenever ``url`` was ``None``, so a user who configured only
    ``OPENAI_API_KEY`` got a 401 from api.openai.com on every embedding call.
    """
    if url is not None and _is_local_endpoint(url):
        return LOCAL_API_KEY_PLACEHOLDER
    return openai_key or LOCAL_API_KEY_PLACEHOLDER


def build_graphiti(tenant: str):
    """Construct a Graphiti instance for ``tenant`` from environment variables."""
    from graphiti_core import Graphiti
    from graphiti_core.driver.falkordb_driver import FalkorDriver

    llm_client = None
    embedder = None
    cross_encoder = None

    # Config espejo del MCP server (infra/graphiti/config.yaml): el LLM y el
    # embedder se configuran POR SEPARADO, para permitir LLM=DeepSeek (que no
    # ofrece embeddings) + embeddings=Ollama. Variables (mismas del .env raiz):
    #   LLM       -> LLM_API_KEY (o OPENAI_API_KEY), LLM_API_URL (u
    #                OPENAI_API_URL), LLM_MODEL (o MODEL_NAME)
    #   Embedder  -> EMBEDDER_API_KEY (o OPENAI_API_KEY), EMBEDDER_API_URL
    #                (o OPENAI_API_URL), EMBEDDER_MODEL, EMBEDDER_DIMENSIONS
    # Las claves van SEPARADAS (igual que en infra/graphiti/config.yaml) porque
    # el caso real es chat en OpenAI (gpt-4o-mini) + embeddings en NVIDIA
    # (nv-embed-v1, 4096 dims): con una sola clave compartida, el proveedor de
    # embeddings recibe la clave del otro y devuelve 401.
    # Compat: si solo hay OLLAMA_BASE_URL, se usa para ambos.
    ollama_url = os.environ.get("OLLAMA_BASE_URL")
    openai_key = os.environ.get("OPENAI_API_KEY")
    llm_key = os.environ.get("LLM_API_KEY") or openai_key
    embed_key = os.environ.get("EMBEDDER_API_KEY") or openai_key
    llm_url = os.environ.get("LLM_API_URL") or os.environ.get("OPENAI_API_URL") or ollama_url
    embed_url = os.environ.get("EMBEDDER_API_URL") or os.environ.get("OPENAI_API_URL") or ollama_url

    if not (llm_key or embed_key) and not ollama_url:
        raise GraphConfigError(
            "No embedder/LLM configured: set OPENAI_API_KEY (o LLM_API_KEY / "
            "EMBEDDER_API_KEY) + su *_API_URL, o bien OLLAMA_BASE_URL."
        )

    from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.llm_client.openai_client import OpenAIClient
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient

    model = (
        os.environ.get("LLM_MODEL")
        or os.environ.get("MODEL_NAME")
        or os.environ.get("OLLAMA_LLM_MODEL")
        or "gpt-4o-mini"
    )

    # LLM: OpenAIGenericClient cuando el endpoint es OpenAI-compatible pero NO
    # oficial (DeepSeek, Ollama, vLLM); el cliente OpenAI estándar para la API
    # oficial o cuando no hay base_url. En AMBOS casos construimos el cliente
    # explícitamente: dejar llm_client=None hacía que graphiti creara su propio
    # cliente por defecto e IGNORARA MODEL_NAME silenciosamente.
    llm_config = LLMConfig(
        api_key=_api_key_for(llm_url, llm_key),
        model=model,
        small_model=model,
        base_url=llm_url,
    )
    if llm_url and "api.openai.com" not in llm_url:
        llm_client = OpenAIGenericClient(config=llm_config)
    else:
        # Modelos "reasoning" (o1/o3/gpt-5) requieren los parámetros de
        # reasoning/verbosity; el resto debe recibirlos explícitamente en None.
        if model.startswith(("o1", "o3", "gpt-5")):
            llm_client = OpenAIClient(config=llm_config, reasoning="minimal", verbosity="low")
        else:
            llm_client = OpenAIClient(config=llm_config, reasoning=None, verbosity=None)

    # Embedder: endpoint propio (mxbai-embed-large en Ollama = 1024 dims). Debe
    # coincidir con el del server o la búsqueda semántica se corrompe.
    _embed_kwargs = dict(
        api_key=_api_key_for(embed_url, embed_key),
        embedding_model=os.environ.get("EMBEDDER_MODEL", "text-embedding-3-small"),
        base_url=embed_url,
    )
    _dims = os.environ.get("EMBEDDER_DIMENSIONS")
    if _dims:
        # embedding_dim es frozen: debe ir en el constructor.
        _embed_kwargs["embedding_dim"] = int(_dims)
    embedder = OpenAIEmbedder(config=OpenAIEmbedderConfig(**_embed_kwargs))

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


# Transient-failure retry policy for add_episode.
RETRY_ATTEMPTS = 3
RETRY_BASE_DELAY = 1.0  # seconds; doubles per attempt (tests patch this to 0)
TRANSIENT_EXCS: tuple[type[BaseException], ...] = (
    ConnectionError,
    TimeoutError,
    OSError,
    asyncio.TimeoutError,
)


async def _add_episode_with_retry(graphiti, **kwargs):
    """add_episode with exponential backoff on connection/timeout errors."""
    delay = RETRY_BASE_DELAY
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            return await graphiti.add_episode(**kwargs)
        except TRANSIENT_EXCS as exc:
            if attempt == RETRY_ATTEMPTS:
                raise
            log.warning(
                "add_episode transient failure (attempt %d/%d): %s — retrying in %.1fs",
                attempt,
                RETRY_ATTEMPTS,
                exc,
                delay,
            )
            await asyncio.sleep(delay)
            delay *= 2


async def ingest_chunks(
    cfg: Config,
    ledger: Ledger,
    doc_ids: list[str] | None = None,
    force: bool = False,
) -> dict[str, int]:
    """Push chunk files of classified docs to Graphiti as episodes.

    Resumable: chunk indices already recorded in the ledger for a doc are
    skipped, so retrying a doc that failed mid-way resumes instead of
    duplicating episodes. Explicit ``doc_ids`` that are superseded or already
    ingested are rejected unless ``force`` is set.
    """
    from graphiti_core.nodes import EpisodeType

    graphiti = build_graphiti(cfg.tenant)
    counts = {"docs": 0, "episodes": 0, "errors": 0, "skipped": 0}
    try:
        await graphiti.build_indices_and_constraints()

        if doc_ids:
            rows = []
            for d in doc_ids:
                r = ledger.get(d)
                if r is None:
                    log.error("unknown doc_id %s", d)
                    counts["errors"] += 1
                    continue
                if (r.superseded or r.status == "ingested") and not force:
                    log.warning(
                        "doc %s is %s — skipping (use --force to re-ingest)",
                        d,
                        "superseded" if r.superseded else "already ingested",
                    )
                    counts["skipped"] += 1
                    continue
                rows.append(r)
        else:
            rows = list(ledger.by_status("classified"))
        for row in rows:
            chunks_path = cfg.chunks_dir / f"{row.doc_id}.json"
            if not chunks_path.exists():
                log.warning("doc %s has no chunks file — run `brain chunk` first", row.doc_id)
                continue
            chunks = json.loads(chunks_path.read_text(encoding="utf-8"))
            if not chunks:
                ledger.set_status(row.doc_id, "skipped", error="sin contenido")
                counts["skipped"] += 1
                continue
            is_json = (cfg.extracted_dir / f"{row.doc_id}.json").exists()
            name_stem = Path(row.path).name
            domain = row.domain or "personal"
            # Resume support: skip chunks whose episode is already recorded
            # (a previous run may have failed mid-document).
            done = {
                e["chunk_idx"]
                for e in ledger.episodes_for_doc(row.doc_id, only_active=True)
            }
            try:
                for chunk in chunks:
                    if chunk["chunk_idx"] in done:
                        log.debug(
                            "doc %s chunk %d already ingested — skipping",
                            row.doc_id,
                            chunk["chunk_idx"],
                        )
                        continue
                    result = redact(chunk["text"])
                    if result.flags:
                        ledger.add_sensitivity_flags(row.doc_id, result.flags)
                    episode = await _add_episode_with_retry(
                        graphiti,
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
                        # (name prefix + source_description + episodes.domain),
                        # never a group_id.
                        group_id=cfg.tenant,
                    )
                    ledger.record_episode(
                        episode.episode.uuid,
                        row.doc_id,
                        chunk["chunk_idx"],
                        cfg.tenant,
                        domain=row.domain,
                    )
                    counts["episodes"] += 1
                ledger.set_status(row.doc_id, "ingested")
                counts["docs"] += 1
            except Exception as exc:  # noqa: BLE001 — record per-doc failures
                # Partial episodes stay recorded in the ledger so a retry
                # resumes at the failed chunk instead of duplicating.
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
