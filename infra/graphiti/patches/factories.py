"""Factory classes for creating LLM, Embedder, and Database clients."""

from config.schema import (
    DatabaseConfig,
    EmbedderConfig,
    LLMConfig,
)

# Try to import FalkorDriver if available
try:
    from graphiti_core.driver.falkordb_driver import FalkorDriver  # noqa: F401

    HAS_FALKOR = True
except ImportError:
    HAS_FALKOR = False

# Kuzu support removed - FalkorDB is now the default
from graphiti_core.embedder import EmbedderClient, OpenAIEmbedder
from graphiti_core.llm_client import LLMClient, OpenAIClient
from graphiti_core.llm_client.config import LLMConfig as GraphitiLLMConfig

# Try to import additional providers if available
try:
    from graphiti_core.embedder.azure_openai import AzureOpenAIEmbedderClient

    HAS_AZURE_EMBEDDER = True
except ImportError:
    HAS_AZURE_EMBEDDER = False

try:
    from graphiti_core.embedder.gemini import GeminiEmbedder

    HAS_GEMINI_EMBEDDER = True
except ImportError:
    HAS_GEMINI_EMBEDDER = False

try:
    from graphiti_core.embedder.voyage import VoyageAIEmbedder

    HAS_VOYAGE_EMBEDDER = True
except ImportError:
    HAS_VOYAGE_EMBEDDER = False

try:
    from graphiti_core.llm_client.azure_openai_client import AzureOpenAILLMClient

    HAS_AZURE_LLM = True
except ImportError:
    HAS_AZURE_LLM = False

try:
    from graphiti_core.llm_client.anthropic_client import AnthropicClient

    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

try:
    from graphiti_core.llm_client.gemini_client import GeminiClient

    HAS_GEMINI = True
except ImportError:
    HAS_GEMINI = False

try:
    from graphiti_core.llm_client.groq_client import GroqClient

    HAS_GROQ = True
except ImportError:
    HAS_GROQ = False


def _validate_api_key(provider_name: str, api_key: str | None, logger) -> str:
    """Validate API key is present.

    Args:
        provider_name: Name of the provider (e.g., 'OpenAI', 'Anthropic')
        api_key: The API key to validate
        logger: Logger instance for output

    Returns:
        The validated API key

    Raises:
        ValueError: If API key is None or empty
    """
    if not api_key:
        raise ValueError(
            f'{provider_name} API key is not configured. Please set the appropriate environment variable.'
        )

    logger.info(f'Creating {provider_name} client')

    return api_key


# PATCH (secondbrain): contabilidad de tokens y costo.
# graphiti no expone el uso de tokens, asi que se envuelve el cliente OpenAI para
# registrar cada llamada en un JSONL. scripts/llm-cost.py lo resume.
def _wrap_usage_logging(client, model: str):
    import json as _json
    import logging as _logging
    import os as _os
    import time as _time
    from pathlib import Path as _Path

    log_path = _os.environ.get('LLM_USAGE_LOG')
    if not log_path:
        return client
    _log = _logging.getLogger(__name__)

    def _mk(inner, kind):
        async def _create(*args, **kwargs):
            t0 = _time.time()
            resp = await inner(*args, **kwargs)
            _record(resp, kwargs, t0, kind)
            return resp

        return _create

    def _record(resp, kwargs, t0, kind):
        try:
            u = getattr(resp, 'usage', None)
            # /v1/responses usa input_tokens/output_tokens; chat.completions usa
            # prompt_tokens/completion_tokens. Graphiti llama al primero cuando el
            # proveedor es OpenAI oficial.
            rec = {
                'ts': _time.strftime('%Y-%m-%dT%H:%M:%SZ', _time.gmtime()),
                'api': kind,
                'model': kwargs.get('model') or model,
                'prompt_tokens': getattr(u, 'prompt_tokens', None) or getattr(u, 'input_tokens', None),
                'completion_tokens': getattr(u, 'completion_tokens', None) or getattr(u, 'output_tokens', None),
                'total_tokens': getattr(u, 'total_tokens', None),
                'seconds': round(_time.time() - t0, 2),
            }
            _Path(log_path).parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, 'a', encoding='utf-8') as fh:
                fh.write(_json.dumps(rec) + '\n')
        except Exception as exc:  # nunca romper la ingesta por la contabilidad
            _log.warning(f'PATCH: no se pudo registrar uso de tokens: {exc!r}')

    inner_api = client.client
    # graphiti llama a DISTINTOS metodos segun el cliente y si pide salida
    # estructurada: OpenAI oficial usa `responses.parse()` (verificado leyendo
    # openai_client.py), el generico usa `chat.completions.create()`. Envolver
    # solo uno deja el contador en cero sin ningun error visible.
    envueltos = []
    for ruta, kind in (
        ('responses.parse', 'responses.parse'),
        ('responses.create', 'responses.create'),
        ('chat.completions.parse', 'chat.parse'),
        ('chat.completions.create', 'chat.create'),
    ):
        try:
            partes = ruta.split('.')
            obj = inner_api
            for parte in partes[:-1]:
                obj = getattr(obj, parte)
            metodo = getattr(obj, partes[-1], None)
            if metodo is None:
                continue
            setattr(obj, partes[-1], _mk(metodo, kind))
            envueltos.append(ruta)
        except Exception:
            continue
    _log.info(
        f'PATCH: contabilidad de tokens -> {log_path} '
        f'(cliente {type(inner_api).__name__}; envueltos: {", ".join(envueltos) or "ninguno"})'
    )
    return client


class LLMClientFactory:
    """Factory for creating LLM clients based on configuration."""

    @staticmethod
    def create(config: LLMConfig) -> LLMClient:
        """Create an LLM client based on the configured provider."""
        import logging

        logger = logging.getLogger(__name__)

        provider = config.provider.lower()

        match provider:
            case 'openai':
                if not config.providers.openai:
                    raise ValueError('OpenAI provider configuration not found')

                api_key = config.providers.openai.api_key
                _validate_api_key('OpenAI', api_key, logger)

                from graphiti_core.llm_client.config import LLMConfig as CoreLLMConfig

                # Use the same model for both main and small model slots
                small_model = config.model

                # PATCH (secondbrain): respetar api_url para endpoints OpenAI-compatibles
                # (Ollama, vLLM, LM Studio). Backport del fix de upstream main que la
                # rama 'openai' de esta version (imagen 1.0.2 / graphiti 0.28.2) omite:
                # ignoraba providers.openai.api_url y siempre iba a api.openai.com.
                api_url = getattr(config.providers.openai, 'api_url', None)

                llm_config = CoreLLMConfig(
                    api_key=api_key,
                    model=config.model,
                    small_model=small_model,
                    base_url=api_url,
                    temperature=config.temperature,
                    max_tokens=config.max_tokens,
                )

                if api_url and 'api.openai.com' not in api_url:
                    from graphiti_core.llm_client.openai_generic_client import (
                        OpenAIGenericClient,
                    )

                    logger.info(f'PATCH: usando OpenAIGenericClient contra {api_url}')
                    return _wrap_usage_logging(OpenAIGenericClient(config=llm_config), config.model)

                # Check if this is a reasoning model (o1, o3, gpt-5 family)
                reasoning_prefixes = ('o1', 'o3', 'gpt-5')
                is_reasoning_model = config.model.startswith(reasoning_prefixes)

                # Only pass reasoning/verbosity parameters for reasoning models (gpt-5 family)
                if is_reasoning_model:
                    return _wrap_usage_logging(
                        OpenAIClient(config=llm_config, reasoning='minimal', verbosity='low'),
                        config.model,
                    )
                else:
                    # For non-reasoning models, explicitly pass None to disable these parameters
                    return _wrap_usage_logging(
                        OpenAIClient(config=llm_config, reasoning=None, verbosity=None),
                        config.model,
                    )

            case 'azure_openai':
                if not HAS_AZURE_LLM:
                    raise ValueError(
                        'Azure OpenAI LLM client not available in current graphiti-core version'
                    )
                if not config.providers.azure_openai:
                    raise ValueError('Azure OpenAI provider configuration not found')
                azure_config = config.providers.azure_openai

                if not azure_config.api_url:
                    raise ValueError('Azure OpenAI API URL is required')

                # Currently using API key authentication
                # TODO: Add Azure AD authentication support for v1 API compatibility
                api_key = azure_config.api_key
                _validate_api_key('Azure OpenAI', api_key, logger)

                # Azure OpenAI should use the standard AsyncOpenAI client with v1 compatibility endpoint
                # See: https://github.com/getzep/graphiti README Azure OpenAI section
                from openai import AsyncOpenAI

                # Ensure the base_url ends with /openai/v1/ for Azure v1 compatibility
                base_url = azure_config.api_url
                if not base_url.endswith('/'):
                    base_url += '/'
                if not base_url.endswith('openai/v1/'):
                    base_url += 'openai/v1/'

                azure_client = AsyncOpenAI(
                    base_url=base_url,
                    api_key=api_key,
                )

                # Then create the LLMConfig
                from graphiti_core.llm_client.config import LLMConfig as CoreLLMConfig

                llm_config = CoreLLMConfig(
                    api_key=api_key,
                    base_url=base_url,
                    model=config.model,
                    temperature=config.temperature,
                    max_tokens=config.max_tokens,
                )

                return AzureOpenAILLMClient(
                    azure_client=azure_client,
                    config=llm_config,
                    max_tokens=config.max_tokens,
                )

            case 'anthropic':
                if not HAS_ANTHROPIC:
                    raise ValueError(
                        'Anthropic client not available in current graphiti-core version'
                    )
                if not config.providers.anthropic:
                    raise ValueError('Anthropic provider configuration not found')

                api_key = config.providers.anthropic.api_key
                _validate_api_key('Anthropic', api_key, logger)

                llm_config = GraphitiLLMConfig(
                    api_key=api_key,
                    model=config.model,
                    temperature=config.temperature,
                    max_tokens=config.max_tokens,
                )
                return AnthropicClient(config=llm_config)

            case 'gemini':
                if not HAS_GEMINI:
                    raise ValueError('Gemini client not available in current graphiti-core version')
                if not config.providers.gemini:
                    raise ValueError('Gemini provider configuration not found')

                api_key = config.providers.gemini.api_key
                _validate_api_key('Gemini', api_key, logger)

                llm_config = GraphitiLLMConfig(
                    api_key=api_key,
                    model=config.model,
                    temperature=config.temperature,
                    max_tokens=config.max_tokens,
                )
                return GeminiClient(config=llm_config)

            case 'groq':
                if not HAS_GROQ:
                    raise ValueError('Groq client not available in current graphiti-core version')
                if not config.providers.groq:
                    raise ValueError('Groq provider configuration not found')

                api_key = config.providers.groq.api_key
                _validate_api_key('Groq', api_key, logger)

                llm_config = GraphitiLLMConfig(
                    api_key=api_key,
                    base_url=config.providers.groq.api_url,
                    model=config.model,
                    temperature=config.temperature,
                    max_tokens=config.max_tokens,
                )
                return GroqClient(config=llm_config)

            case _:
                raise ValueError(f'Unsupported LLM provider: {provider}')


class EmbedderFactory:
    """Factory for creating Embedder clients based on configuration."""

    @staticmethod
    def create(config: EmbedderConfig) -> EmbedderClient:
        """Create an Embedder client based on the configured provider."""
        import logging

        logger = logging.getLogger(__name__)

        provider = config.provider.lower()

        match provider:
            case 'openai':
                if not config.providers.openai:
                    raise ValueError('OpenAI provider configuration not found')

                api_key = config.providers.openai.api_key
                _validate_api_key('OpenAI Embedder', api_key, logger)

                from graphiti_core.embedder.openai import OpenAIEmbedderConfig

                embedder_config = OpenAIEmbedderConfig(
                    api_key=api_key,
                    embedding_model=config.model,
                    base_url=config.providers.openai.api_url,  # Support custom endpoints like Ollama
                    embedding_dim=config.dimensions,  # Support custom embedding dimensions
                )
                return OpenAIEmbedder(config=embedder_config)

            case 'azure_openai':
                if not HAS_AZURE_EMBEDDER:
                    raise ValueError(
                        'Azure OpenAI embedder not available in current graphiti-core version'
                    )
                if not config.providers.azure_openai:
                    raise ValueError('Azure OpenAI provider configuration not found')
                azure_config = config.providers.azure_openai

                if not azure_config.api_url:
                    raise ValueError('Azure OpenAI API URL is required')

                # Currently using API key authentication
                # TODO: Add Azure AD authentication support for v1 API compatibility
                api_key = azure_config.api_key
                _validate_api_key('Azure OpenAI Embedder', api_key, logger)

                # Azure OpenAI should use the standard AsyncOpenAI client with v1 compatibility endpoint
                # See: https://github.com/getzep/graphiti README Azure OpenAI section
                from openai import AsyncOpenAI

                # Ensure the base_url ends with /openai/v1/ for Azure v1 compatibility
                base_url = azure_config.api_url
                if not base_url.endswith('/'):
                    base_url += '/'
                if not base_url.endswith('openai/v1/'):
                    base_url += 'openai/v1/'

                azure_client = AsyncOpenAI(
                    base_url=base_url,
                    api_key=api_key,
                )

                return AzureOpenAIEmbedderClient(
                    azure_client=azure_client,
                    model=config.model or 'text-embedding-3-small',
                )

            case 'gemini':
                if not HAS_GEMINI_EMBEDDER:
                    raise ValueError(
                        'Gemini embedder not available in current graphiti-core version'
                    )
                if not config.providers.gemini:
                    raise ValueError('Gemini provider configuration not found')

                api_key = config.providers.gemini.api_key
                _validate_api_key('Gemini Embedder', api_key, logger)

                from graphiti_core.embedder.gemini import GeminiEmbedderConfig

                gemini_config = GeminiEmbedderConfig(
                    api_key=api_key,
                    embedding_model=config.model or 'models/text-embedding-004',
                    embedding_dim=config.dimensions or 768,
                )
                return GeminiEmbedder(config=gemini_config)

            case 'voyage':
                if not HAS_VOYAGE_EMBEDDER:
                    raise ValueError(
                        'Voyage embedder not available in current graphiti-core version'
                    )
                if not config.providers.voyage:
                    raise ValueError('Voyage provider configuration not found')

                api_key = config.providers.voyage.api_key
                _validate_api_key('Voyage Embedder', api_key, logger)

                from graphiti_core.embedder.voyage import VoyageAIEmbedderConfig

                voyage_config = VoyageAIEmbedderConfig(
                    api_key=api_key,
                    embedding_model=config.model or 'voyage-3',
                    embedding_dim=config.dimensions or 1024,
                )
                return VoyageAIEmbedder(config=voyage_config)

            case _:
                raise ValueError(f'Unsupported Embedder provider: {provider}')


class DatabaseDriverFactory:
    """Factory for creating Database drivers based on configuration.

    Note: This returns configuration dictionaries that can be passed to Graphiti(),
    not driver instances directly, as the drivers require complex initialization.
    """

    @staticmethod
    def create_config(config: DatabaseConfig) -> dict:
        """Create database configuration dictionary based on the configured provider."""
        provider = config.provider.lower()

        match provider:
            case 'neo4j':
                # Use Neo4j config if provided, otherwise use defaults
                if config.providers.neo4j:
                    neo4j_config = config.providers.neo4j
                else:
                    # Create default Neo4j configuration
                    from config.schema import Neo4jProviderConfig

                    neo4j_config = Neo4jProviderConfig()

                # Check for environment variable overrides (for CI/CD compatibility)
                import os

                uri = os.environ.get('NEO4J_URI', neo4j_config.uri)
                username = os.environ.get('NEO4J_USER', neo4j_config.username)
                password = os.environ.get('NEO4J_PASSWORD', neo4j_config.password)

                return {
                    'uri': uri,
                    'user': username,
                    'password': password,
                    # Note: database and use_parallel_runtime would need to be passed
                    # to the driver after initialization if supported
                }

            case 'falkordb':
                if not HAS_FALKOR:
                    raise ValueError(
                        'FalkorDB driver not available in current graphiti-core version'
                    )

                # Use FalkorDB config if provided, otherwise use defaults
                if config.providers.falkordb:
                    falkor_config = config.providers.falkordb
                else:
                    # Create default FalkorDB configuration
                    from config.schema import FalkorDBProviderConfig

                    falkor_config = FalkorDBProviderConfig()

                # Check for environment variable overrides (for CI/CD compatibility)
                import os
                from urllib.parse import urlparse

                uri = os.environ.get('FALKORDB_URI', falkor_config.uri)
                password = os.environ.get('FALKORDB_PASSWORD', falkor_config.password)

                # Parse the URI to extract host and port
                parsed = urlparse(uri)
                host = parsed.hostname or 'localhost'
                port = parsed.port or 6379

                # PATCH (secondbrain): honrar credenciales embebidas en la URI
                # (redis://tenant_<n>:<pass>@falkordb:6379). La imagen 1.0.2
                # descarta username/password de la URI; los necesitamos para el
                # aislamiento por ACL de FalkorDB (usuario por tenant).
                username = parsed.username or os.environ.get('FALKORDB_USERNAME') or None
                if parsed.password:
                    password = parsed.password

                return {
                    'driver': 'falkordb',
                    'host': host,
                    'port': port,
                    'username': username,
                    'password': password,
                    'database': falkor_config.database,
                }

            case _:
                raise ValueError(f'Unsupported Database provider: {provider}')


# ---------------------------------------------------------------------------
# PATCH (secondbrain): escritura al grafo serializada + embeddings por lote
# ---------------------------------------------------------------------------
#
# Los dos viven aqui porque son el mismo punto del codigo —
# `add_nodes_and_edges_bulk`, donde `add_episode` acaba escribiendo— y porque
# el segundo NO es seguro sin el primero.
#
# EL PROBLEMA. Varios workers extraen en paralelo y escriben en el MISMO grafo
# a la vez. FalkorDB tiene THREAD_COUNT=8 compartido entre todos los tenants de
# la maquina y venia con TIMEOUT=0: una consulta atascada retenia un hilo para
# siempre. Con el grafo creciendo, las consultas se ralentizaron de 292ms a
# 759ms de media, la contencion subio sola y el grafo termino trabandose —
# `PING` respondia, `GRAPH.QUERY` se colgaba, y la ingesta se paraba en seco
# sin un solo error en el log. Paso tres veces la noche del 2026-08-16.
#
# LA SOLUCION. Extraer con varios workers (que es donde se gana: son minutos
# de LLM y de red por episodio) pero escribir de a uno. La escritura es la
# parte corta —decimas de segundo— asi que serializarla casi no cuesta
# rendimiento, y a cambio elimina la contencion que tumbaba el servicio.
#
# El `TIMEOUT` de FalkorDB queda igualmente puesto en falkordb.conf, pero como
# red de seguridad: esto evita el atasco, aquello lo desatasca si aparece por
# otro camino.

import asyncio as _asyncio
import logging as _logging
import os as _os

_log_parche = _logging.getLogger(__name__)

#: Serializar la escritura al grafo. Se puede apagar (=0) para medir, pero
#: apagarlo es volver al estado que trababa el grafo.
BRAIN_ESCRITURA_SERIAL = (_os.environ.get('BRAIN_ESCRITURA_SERIAL', '1') or '1') != '0'

#: Textos por peticion de embeddings; 0 = apagado.
#:
#: `add_episode` genera los embeddings que faltan en un bucle SECUENCIAL: una
#: ida y vuelta HTTP por nodo y otra por arista. Medido: 20 llamadas por
#: episodio, mediana 0,43s entre ellas — unos 15s por episodio esperando a la
#: red, con el chat consumiendo solo el 13% del tiempo de los workers.
#:
#: Verificado contra `nv-embed-v1` antes de usarlo: un lote devuelve los
#: vectores en orden y BIT A BIT identicos a pedirlos sueltos (diferencia
#: 0,00e+00). Importa, porque cambiar el valor de los embeddings corromperia la
#: busqueda del grafo existente.
#:
#: Requiere BRAIN_ESCRITURA_SERIAL. Sin el candado esos ~15s de espera por
#: episodio actuaban de freno accidental, escalonando a los workers; al
#: quitarlos, los cinco escribian a la vez y el grafo se trababa en 35s.
BRAIN_EMBED_LOTE = max(0, int(_os.environ.get('BRAIN_EMBED_LOTE', '64') or 0))

#: Presupuesto de tokens POR PETICION. `nv-embed-v1` corta en 4096 y el limite
#: es del lote entero, no de cada texto: agrupar de a 64 sin mirar el tamano
#: reventaba con "Input length 4286 exceeds maximum allowed token size 4096" y
#: el episodio entero fallaba. Se deja margen porque la estimacion es eso, una
#: estimacion.
BRAIN_EMBED_TOKENS = max(256, int(_os.environ.get('BRAIN_EMBED_TOKENS', '3500') or 3500))


def _tokens_aprox(texto: str) -> int:
    """Estimacion barata y CONSERVADORA (por exceso) de tokens.

    Sin tokenizador del proveedor a mano, se cuenta 1 token cada 3 caracteres:
    en espanol con acentos y nombres propios la cuenta real suele ser mas baja,
    y equivocarse por exceso solo cuesta una peticion de mas — equivocarse por
    defecto cuesta un episodio fallido.
    """
    return max(1, len(texto) // 3 + 1)


def _agrupar(textos: list[str]) -> list[list[int]]:
    """Indices agrupados respetando el tope de textos Y el de tokens."""
    grupos: list[list[int]] = []
    actual: list[int] = []
    tokens = 0
    for i, texto in enumerate(textos):
        t = _tokens_aprox(texto)
        # Un texto que por si solo no cabe va igualmente solo: el proveedor
        # decide (lo mismo que hacia el bucle original de a uno).
        if actual and (len(actual) >= (BRAIN_EMBED_LOTE or 64) or tokens + t > BRAIN_EMBED_TOKENS):
            grupos.append(actual)
            actual, tokens = [], 0
        actual.append(i)
        tokens += t
    if actual:
        grupos.append(actual)
    return grupos

_candado_escritura: '_asyncio.Lock | None' = None


def _lock_escritura() -> '_asyncio.Lock':
    """Candado unico, creado al primer uso (ya dentro del bucle de eventos)."""
    global _candado_escritura
    if _candado_escritura is None:
        _candado_escritura = _asyncio.Lock()
    return _candado_escritura


async def _en_lotes(embedder, textos: list[str]) -> list[list[float]]:
    """`create_batch` troceado, conservando el orden de entrada."""
    salida: list[list[float]] = [None] * len(textos)  # type: ignore[list-item]
    for grupo in _agrupar(textos):
        vectores = await embedder.create_batch([textos[i] for i in grupo])
        for i, vector in zip(grupo, vectores, strict=True):
            salida[i] = vector
    return salida


async def _pre_embeddings(embedder, entity_nodes, entity_edges) -> None:
    """Genera por lotes lo que el bucle original pediria de a uno."""
    nodos = [n for n in entity_nodes if n.name and n.name_embedding is None]
    if nodos:
        for nodo, vector in zip(
            nodos, await _en_lotes(embedder, [n.name for n in nodos]), strict=True
        ):
            nodo.name_embedding = vector

    aristas = [e for e in entity_edges if e.fact and e.fact_embedding is None]
    if aristas:
        for arista, vector in zip(
            aristas, await _en_lotes(embedder, [e.fact for e in aristas]), strict=True
        ):
            arista.fact_embedding = vector


def instalar_parche_escritura(logger=_log_parche) -> bool:
    """Envuelve `add_nodes_and_edges_bulk`: embeddings por lote + candado."""
    if not (BRAIN_ESCRITURA_SERIAL or BRAIN_EMBED_LOTE):
        return False

    try:
        from graphiti_core import graphiti as _graphiti_mod
        from graphiti_core.utils import bulk_utils as _bulk
    except Exception:  # pragma: no cover - sin graphiti no hay nada que envolver
        return False

    if getattr(_bulk.add_nodes_and_edges_bulk, '_secondbrain_parche', False):
        return True  # idempotente: importar dos veces no debe anidar wrappers

    original = _bulk.add_nodes_and_edges_bulk

    async def add_nodes_and_edges_bulk(
        driver, episodic_nodes, episodic_edges, entity_nodes, entity_edges, embedder
    ):
        # Los embeddings van FUERA del candado: es trabajo de red que puede
        # solaparse entre workers sin tocar el grafo. Meterlo dentro seria
        # serializar justo lo que si conviene paralelizar.
        if BRAIN_EMBED_LOTE:
            try:
                await _pre_embeddings(embedder, entity_nodes, entity_edges)
            except Exception as e:
                # Nunca romper la ingesta por una optimizacion: si el lote
                # falla, la funcion original los genera de a uno, como siempre.
                if logger:
                    logger.warning(f'Embeddings por lote fallaron ({e}); se sigue de a uno')

        if not BRAIN_ESCRITURA_SERIAL:
            return await original(
                driver, episodic_nodes, episodic_edges, entity_nodes, entity_edges, embedder
            )

        async with _lock_escritura():
            return await original(
                driver, episodic_nodes, episodic_edges, entity_nodes, entity_edges, embedder
            )

    add_nodes_and_edges_bulk._secondbrain_parche = True
    # Hay que parchear AMBOS modulos: `graphiti.py` importo el nombre directo
    # (`from ...bulk_utils import add_nodes_and_edges_bulk`), asi que reescribir
    # solo `bulk_utils` dejaria a `add_episode` usando la version vieja.
    _bulk.add_nodes_and_edges_bulk = add_nodes_and_edges_bulk
    _graphiti_mod.add_nodes_and_edges_bulk = add_nodes_and_edges_bulk
    if logger:
        logger.info(
            f'PATCH: escritura serializada={BRAIN_ESCRITURA_SERIAL} '
            f'embeddings por lote={BRAIN_EMBED_LOTE or "off"}'
        )
    return True


instalar_parche_escritura()
