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
import time
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


#: Segundos que se espera una respuesta del proveedor antes de abortar la
#: llamada. Sin esto, una ingesta larga se cuelga indefinidamente: graphiti no
#: fija timeout, el SDK de OpenAI aplica su default de 600 s por intento y una
#: conexion que queda a medias (proveedor caido, red que se corta) deja el
#: proceso esperando sin escribir nada al log. Ya paso dos veces con lotes de
#: cientos de documentos. Ajustable con LLM_TIMEOUT_SECONDS.
LLM_TIMEOUT_SECONDS = 120.0
LLM_MAX_RETRIES = 3


def _openai_client(config):
    """AsyncOpenAI con timeout y reintentos explicitos.

    graphiti construye su propio cliente sin timeout; aqui se le pasa uno
    propio para que una llamada colgada falle rapido y el ledger pueda
    reanudar, en vez de bloquear el lote completo.
    """
    from openai import AsyncOpenAI

    try:
        timeout = float(os.environ.get("LLM_TIMEOUT_SECONDS", LLM_TIMEOUT_SECONDS))
    except ValueError:
        timeout = LLM_TIMEOUT_SECONDS
    return AsyncOpenAI(
        api_key=config.api_key,
        base_url=config.base_url,
        timeout=timeout,
        max_retries=LLM_MAX_RETRIES,
    )


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
        llm_client = OpenAIGenericClient(config=llm_config, client=_openai_client(llm_config))
    else:
        # Modelos "reasoning" (o1/o3/gpt-5) requieren los parámetros de
        # reasoning/verbosity; el resto debe recibirlos explícitamente en None.
        _cli = _openai_client(llm_config)
        if model.startswith(("o1", "o3", "gpt-5")):
            llm_client = OpenAIClient(
                config=llm_config, client=_cli, reasoning="minimal", verbosity="low"
            )
        else:
            llm_client = OpenAIClient(
                config=llm_config, client=_cli, reasoning=None, verbosity=None
            )

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
    _embed_config = OpenAIEmbedderConfig(**_embed_kwargs)
    embedder = OpenAIEmbedder(config=_embed_config, client=_openai_client(_embed_config))

    # Cross-encoder (reranker). Dejarlo en None NO significa "no usar reranker":
    # graphiti construye entonces uno propio contra api.openai.com, con su
    # cliente por defecto y SIN timeout. Eso dejo la ingesta colgada 13 h con un
    # socket en CLOSE_WAIT y cero episodios, porque el timeout que se le pone al
    # LLM y al embedder no alcanza a ese tercer cliente.
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient

    cross_encoder = OpenAIRerankerClient(
        config=llm_config, client=_openai_client(llm_config)
    )

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


#: Marca de los episodios enviados por MCP cuyo uuid real todavia no se conoce.
#: add_memory encola y responde de inmediato, sin devolver el uuid; se resuelve
#: al final del lote consultando al servidor que llego realmente.
PENDIENTE_PREFIJO = "pendiente:"

#: Reintentos ante fallos PASAJEROS del servidor (504 de Cloudflare cuando el
#: origen esta saturado, 502/503, rate limit). Un fallo real —401, 400— no se
#: reintenta: repetirlo no lo va a arreglar.
MCP_MAX_INTENTOS = 4
MCP_ESPERA_BASE = 5.0
#: Pausa entre episodios. Sin ella el CLI encola mas rapido de lo que el
#: servidor drena (~15 s por episodio) y termina provocando los 504 que luego
#: hay que reintentar. Ajustable con BRAIN_RITMO.
PAUSA_ENTRE_EPISODIOS = 1.0

_PASAJEROS = ("HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504", "timeout")


def _es_pasajero(exc: Exception) -> bool:
    return any(p.lower() in str(exc).lower() for p in _PASAJEROS)


#: Cuanto se espera a que el servidor procese la cola antes de dar por perdido
#: un episodio. La cola del MCP es asincrona: enviar y consultar de inmediato
#: siempre da vacio. Ajustable con BRAIN_VERIFY_SECONDS (0 = no verificar).
VERIFY_SECONDS = 120.0
VERIFY_POLL = 5.0


def reconciliar_uuids(cliente, ledger: Ledger, espera: float | None = None) -> dict[str, int]:
    """Confirma contra el servidor que los episodios enviados existen.

    Sin esto, una falla del lado del servidor se ve igual que un envio exitoso:
    add_memory responde al ENCOLAR, no al terminar. Paso de verdad — 41
    episodios rechazados uno por uno y el CLI reportando "0 errors".

    Espera a que el servidor procese la cola, cambia los ids provisionales por
    los uuid reales y devuelve cuantos se confirmaron y cuantos no llegaron.
    """
    import time

    from .mcp_remote import McpRemoteError, episodios_por_nombre

    if espera is None:
        try:
            espera = float(os.environ.get("BRAIN_VERIFY_SECONDS", VERIFY_SECONDS))
        except ValueError:
            espera = VERIFY_SECONDS

    filas = ledger.episodes_pendientes(PENDIENTE_PREFIJO)
    pendientes: dict[str, object] = {}
    ambiguos: set[str] = set()
    for e in filas:
        nombre = e["episode_uuid"][len(PENDIENTE_PREFIJO) :]
        if nombre in pendientes:
            # Dos documentos distintos con el mismo nombre de episodio: no hay
            # forma de saber cual uuid corresponde a cual. Se prefiere no
            # confirmar ninguno antes que asignarlos al azar.
            ambiguos.add(nombre)
        pendientes[nombre] = e
    for nombre in ambiguos:
        log.warning("nombre de episodio repetido, no se puede verificar: %s", nombre)
        pendientes.pop(nombre, None)
    if not pendientes:
        return {"confirmados": 0, "faltantes": 0}

    log.info("verificando en el servidor %d episodio(s) enviado(s)...", len(pendientes))
    limite = time.monotonic() + max(espera, 0.0)
    encontrados: dict[str, str] = {}
    # Se consulta SIEMPRE al menos una vez, incluso con espera=0: el objetivo es
    # verificar, y no verificar nunca es justamente el fallo que esto corrige.
    while True:
        try:
            vistos = episodios_por_nombre(cliente, maximo=max(200, len(pendientes) * 2))
        except McpRemoteError as exc:
            log.warning("no se pudo consultar el servidor: %s", exc)
            break
        for nombre in pendientes:
            if nombre in vistos and nombre not in encontrados:
                encontrados[nombre] = vistos[nombre]
        if len(encontrados) >= len(pendientes) or time.monotonic() >= limite:
            break
        time.sleep(min(VERIFY_POLL, max(limite - time.monotonic(), 0)))

    for nombre, uuid_real in encontrados.items():
        ledger.actualizar_uuid_episodio(f"{PENDIENTE_PREFIJO}{nombre}", uuid_real)
    faltan = [n for n in pendientes if n not in encontrados]
    for nombre in faltan:
        # Se borra el registro para que un reintento vuelva a enviar ese chunk,
        # y el documento queda en error: dar por ingerido algo que no esta en el
        # grafo es peor que fallar.
        ledger.borrar_episodio(f"{PENDIENTE_PREFIJO}{nombre}")
        doc = pendientes[nombre]["doc_id"]
        ledger.set_status(doc, "error", error="el servidor no confirmó el episodio")
    return {"confirmados": len(encontrados), "faltantes": len(faltan)}


def _mcp_add_memory(
    cliente,
    *,
    name: str,
    episode_body: str,
    source_description: str,
    reference_time,
    is_json: bool,
) -> str:
    """Empuja un episodio por el conector MCP. Devuelve un id provisional.

    NO se manda ``uuid``. Se probo pasar uno generado por el cliente para que el
    ledger registrara el mismo identificador que el grafo, y fue un error:
    graphiti interpreta un uuid explicito como "actualiza el episodio que ya
    existe con ese id", asi que el servidor rechazo los 41 episodios de una
    carpeta con ``node <uuid> not found`` mientras el CLI los daba por buenos.
    El uuid real se reconcilia despues con ``reconciliar_uuids``.

    Tampoco se manda group_id: el servidor MCP fuerza el del usuario
    autenticado, y mandarlo desde el cliente seria el atajo que rompe el
    aislamiento entre personas.
    """
    from .mcp_remote import McpRemoteError

    # El camino directo a FalkorDB reintentaba los fallos pasajeros; este no, y
    # un solo 504 de Cloudflare descartaba el documento completo. Con el
    # servidor cargado son frecuentes: la ingesta lo satura y el origen deja de
    # responder dentro del limite de Cloudflare (100 s).
    ultimo: Exception | None = None
    for intento in range(MCP_MAX_INTENTOS):
        try:
            cliente.llamar(
                "add_memory",
                {
                    "name": name,
                    "episode_body": episode_body,
                    "source": "json" if is_json else "text",
                    "source_description": source_description,
                    "reference_time": reference_time.isoformat(),
                },
            )
            return f"{PENDIENTE_PREFIJO}{name}"
        except McpRemoteError as exc:
            if not _es_pasajero(exc):
                raise
            ultimo = exc
            if intento < MCP_MAX_INTENTOS - 1:
                espera = MCP_ESPERA_BASE * (2**intento)
                log.warning(
                    "el servidor no respondio (%s); reintento en %.0fs [%d/%d]",
                    str(exc)[:60],
                    espera,
                    intento + 2,
                    MCP_MAX_INTENTOS,
                )
                time.sleep(espera)
    raise ultimo if ultimo else RuntimeError("add_memory fallo sin excepcion")


async def ingest_chunks(
    cfg: Config,
    ledger: Ledger,
    doc_ids: list[str] | None = None,
    force: bool = False,
    remoto=None,
) -> dict[str, int]:
    """Push chunk files of classified docs to Graphiti as episodes.

    Resumable: chunk indices already recorded in the ledger for a doc are
    skipped, so retrying a doc that failed mid-way resumes instead of
    duplicating episodes. Explicit ``doc_ids`` that are superseded or already
    ingested are rejected unless ``force`` is set.

    ``remoto`` es un ``mcp_remote.ClienteMCP`` ya conectado. Con el, los
    episodios se empujan por el conector MCP autenticado en vez de escribir
    directo a FalkorDB — la unica via disponible para quien no administra el
    servidor. El resto (ledger, reanudacion, redaccion) es identico.
    """
    from graphiti_core.nodes import EpisodeType

    graphiti = None if remoto is not None else build_graphiti(cfg.tenant)
    counts = {"docs": 0, "episodes": 0, "errors": 0, "skipped": 0}
    try:
        if graphiti is not None:
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
                    nombre = (
                        f"[{domain}] {name_stem} "
                        f"[{chunk['chunk_idx'] + 1}/{chunk['total_chunks']}]"
                    )
                    descripcion = (
                        f"dominio: {domain} | tipo: {row.doc_type or 'documento'} | "
                        f"origen: documento {row.path} (doc_id={row.doc_id})"
                    )
                    if remoto is not None:
                        episode_uuid = _mcp_add_memory(
                            remoto,
                            name=nombre,
                            episode_body=result.text,
                            source_description=descripcion,
                            reference_time=_reference_time(row),
                            is_json=is_json,
                        )
                    else:
                        episode = await _add_episode_with_retry(
                            graphiti,
                            name=nombre,
                            episode_body=result.text,
                            source_description=descripcion,
                            reference_time=_reference_time(row),
                            source=EpisodeType.json if is_json else EpisodeType.text,
                            # group_id is ALWAYS the tenant: the FalkorDB driver
                            # uses it as the graph name. The domain is metadata
                            # (name prefix + source_description + episodes.domain),
                            # never a group_id.
                            group_id=cfg.tenant,
                        )
                        episode_uuid = episode.episode.uuid
                    if remoto is not None:
                        try:
                            time.sleep(float(os.environ.get("BRAIN_RITMO", PAUSA_ENTRE_EPISODIOS)))
                        except ValueError:
                            time.sleep(PAUSA_ENTRE_EPISODIOS)
                    ledger.record_episode(
                        episode_uuid,
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
        if remoto is not None and counts["episodes"]:
            verificacion = reconciliar_uuids(remoto, ledger)
            counts["confirmados"] = verificacion["confirmados"]
            counts["no_confirmados"] = verificacion["faltantes"]
    finally:
        if graphiti is not None:
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
