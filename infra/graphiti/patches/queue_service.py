"""Queue service for managing episode processing."""

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


#: Guia adicional para el extractor de entidades. Va al prompt de extraccion.
#: Reintentos ante rate limit del proveedor. Sin esto, un 429 pasajero daba el
#: episodio por FALLIDO y se quedaba en el diario hasta el siguiente reinicio:
#: 15 episodios perdidos en una hora durante una ingesta normal. La espera es
#: exponencial y larga a proposito — un rate limit por minuto se pasa esperando.
RATE_LIMIT_INTENTOS = 5
RATE_LIMIT_ESPERA_BASE = 20.0

_SENALES_RATE_LIMIT = ("rate limit", "429", "too many requests", "quota")


def _es_rate_limit(exc: Exception) -> bool:
    return any(s in str(exc).lower() for s in _SENALES_RATE_LIMIT)


INSTRUCCIONES_EXTRACCION = """
Este grafo guarda la vida de UNA persona: sus documentos, su dinero, su salud,
su trabajo y sus proyectos. Extrae solo cosas CONCRETAS e IDENTIFICABLES.

NO extraigas como entidad:
- Roles o partes de un contrato: "General Partner", "Limited Partners",
  "Receiving Party", "el comprador", "Third Party Purchaser", "el arrendatario".
  Si el documento dice que Juan Pablo es el General Partner de Invest Andes LP,
  la entidad es la PERSONA y la SOCIEDAD; "General Partner" es la relacion
  entre ambas, no un tercer nodo.
- Figuras juridicas o conceptos: "Partnership", "Agreement", "Notice",
  "Percentage Interest", "Extraordinary Resolution", "sociedad anonima".
- Terminos genericos que aparecen en cualquier documento del mismo tipo.

SI extrae:
- Personas con nombre y apellido.
- Empresas, bancos, clinicas e instituciones con su razon social.
- Lugares y direcciones concretas.
- Documentos identificables (con numero, fecha o partes).
- Cuentas, montos, activos y obligaciones con su identificador.

Ante la duda: si el nombre podria aparecer igual en el contrato de otra
persona, NO es una entidad de este grafo — es vocabulario del documento.
"""


class QueueService:
    """Service for managing sequential episode processing queues by group_id."""

    def __init__(self):
        """Initialize the queue service."""
        # Dictionary to store queues for each group_id
        self._episode_queues: dict[str, asyncio.Queue] = {}
        # Dictionary to track if a worker is running for each group_id
        self._queue_workers: dict[str, bool] = {}
        # Store the graphiti client after initialization
        self._graphiti_client: Any = None

    async def add_episode_task(
        self, group_id: str, process_func: Callable[[], Awaitable[None]]
    ) -> int:
        """Add an episode processing task to the queue.

        Args:
            group_id: The group ID for the episode
            process_func: The async function to process the episode

        Returns:
            The position in the queue
        """
        # Initialize queue for this group_id if it doesn't exist
        if group_id not in self._episode_queues:
            self._episode_queues[group_id] = asyncio.Queue()

        # Add the episode processing function to the queue
        await self._episode_queues[group_id].put(process_func)

        # Start a worker for this queue if one isn't already running
        if not self._queue_workers.get(group_id, False):
            asyncio.create_task(self._process_episode_queue(group_id))

        return self._episode_queues[group_id].qsize()

    async def _process_episode_queue(self, group_id: str) -> None:
        """Process episodes for a specific group_id sequentially.

        This function runs as a long-lived task that processes episodes
        from the queue one at a time.
        """
        logger.info(f'Starting episode queue worker for group_id: {group_id}')
        self._queue_workers[group_id] = True

        try:
            while True:
                # Get the next episode processing function from the queue
                # This will wait if the queue is empty
                process_func = await self._episode_queues[group_id].get()

                try:
                    # Process the episode
                    await process_func()
                except Exception as e:
                    logger.error(
                        f'Error processing queued episode for group_id {group_id}: {str(e)}'
                    )
                finally:
                    # Mark the task as done regardless of success/failure
                    self._episode_queues[group_id].task_done()
        except asyncio.CancelledError:
            logger.info(f'Episode queue worker for group_id {group_id} was cancelled')
        except Exception as e:
            logger.error(f'Unexpected error in queue worker for group_id {group_id}: {str(e)}')
        finally:
            self._queue_workers[group_id] = False
            logger.info(f'Stopped episode queue worker for group_id: {group_id}')

    def get_queue_size(self, group_id: str) -> int:
        """Get the current queue size for a group_id."""
        if group_id not in self._episode_queues:
            return 0
        return self._episode_queues[group_id].qsize()

    def is_worker_running(self, group_id: str) -> bool:
        """Check if a worker is running for a group_id."""
        return self._queue_workers.get(group_id, False)

    async def initialize(self, graphiti_client: Any) -> None:
        """Initialize the queue service with a graphiti client.

        Args:
            graphiti_client: The graphiti client instance to use for processing episodes
        """
        self._graphiti_client = graphiti_client
        logger.info('Queue service initialized with graphiti client')

    # ---- diario de pendientes (PATCH secondbrain) -------------------------

    @property
    def _dir_diario(self) -> 'Path':
        ruta = Path(os.environ.get('BRAIN_QUEUE_DIR', '/tmp/brain-queue'))
        ruta.mkdir(parents=True, exist_ok=True)
        return ruta

    def _anotar_pendiente(
        self, group_id, name, content, source_description, episode_type, uuid, reference_time
    ) -> 'Path | None':
        """Deja el episodio anotado en disco antes de procesarlo."""
        try:
            clave = uuid or f'{group_id}-{abs(hash((name, content))):x}'
            destino = self._dir_diario / f'{clave}.json'
            destino.write_text(
                json.dumps(
                    {
                        'group_id': group_id,
                        'name': name,
                        'content': content,
                        'source_description': source_description,
                        'episode_type': getattr(episode_type, 'value', str(episode_type)),
                        'uuid': uuid,
                        'reference_time': reference_time.isoformat() if reference_time else None,
                    },
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )
            return destino
        except Exception as e:  # anotar no debe impedir procesar
            logger.warning(f'No se pudo anotar el episodio pendiente: {e}')
            return None

    def _olvidar_pendiente(self, ruta: 'Path | None') -> None:
        if ruta is None:
            return
        try:
            ruta.unlink(missing_ok=True)
        except Exception as e:
            logger.warning(f'No se pudo borrar la anotacion {ruta}: {e}')

    async def recuperar_pendientes(self, entity_types: Any = None) -> int:
        """Reencola lo que quedo a medias en un reinicio anterior.

        Se llama al arrancar. Sin esto, un `systemctl restart` durante una
        ingesta pierde episodios que el cliente ya dio por aceptados.
        """
        from graphiti_core.nodes import EpisodeType

        recuperados = 0
        for archivo in sorted(self._dir_diario.glob('*.json')):
            try:
                d = json.loads(archivo.read_text(encoding='utf-8'))
            except Exception:
                archivo.unlink(missing_ok=True)
                continue
            archivo.unlink(missing_ok=True)  # se reescribe al reencolar
            try:
                tipo = EpisodeType(d.get('episode_type') or 'text')
            except ValueError:
                tipo = EpisodeType.text
            fecha = None
            if d.get('reference_time'):
                try:
                    fecha = datetime.fromisoformat(d['reference_time'])
                except ValueError:
                    fecha = None
            await self.add_episode(
                group_id=d['group_id'],
                name=d.get('name') or 'episodio recuperado',
                content=d.get('content') or '',
                source_description=d.get('source_description') or '',
                episode_type=tipo,
                entity_types=entity_types,
                uuid=d.get('uuid'),
                reference_time=fecha,
            )
            recuperados += 1
        if recuperados:
            logger.info(f'Recuperados {recuperados} episodio(s) de un reinicio anterior')
        return recuperados

    async def _con_reintento_rate_limit(self, hacer, etiqueta: str):
        """Ejecuta `hacer()` reintentando si el proveedor limita la tasa.

        Un 429 no es un fallo del documento: es "vuelve en un rato". Darlo por
        perdido obliga a reingerir el lote entero, que es justo lo que vuelve a
        disparar el limite.
        """
        ultimo = None
        for intento in range(RATE_LIMIT_INTENTOS):
            try:
                return await hacer()
            except Exception as e:
                if not _es_rate_limit(e):
                    raise
                ultimo = e
                if intento < RATE_LIMIT_INTENTOS - 1:
                    espera = RATE_LIMIT_ESPERA_BASE * (2**intento)
                    logger.warning(
                        f'Rate limit en {etiqueta}; esperando {espera:.0f}s '
                        f'[{intento + 2}/{RATE_LIMIT_INTENTOS}]'
                    )
                    await asyncio.sleep(espera)
        raise ultimo

    async def add_episode(
        self,
        group_id: str,
        name: str,
        content: str,
        source_description: str,
        episode_type: Any,
        entity_types: Any,
        uuid: str | None,
        # PATCH (secondbrain): fecha real del hecho; None = ahora.
        reference_time: 'datetime | None' = None,
    ) -> int:
        """Add an episode for processing.

        Args:
            group_id: The group ID for the episode
            name: Name of the episode
            content: Episode content
            source_description: Description of the episode source
            episode_type: Type of the episode
            entity_types: Entity types for extraction
            uuid: Episode UUID

        Returns:
            The position in the queue
        """
        if self._graphiti_client is None:
            raise RuntimeError('Queue service not initialized. Call initialize() first.')

        # PATCH (secondbrain): diario en disco. La cola vive en memoria, asi
        # que un reinicio con episodios en vuelo los perdia EN SILENCIO — el
        # cliente ya habia recibido "encolado". Paso dos veces. Cada episodio
        # se anota antes de procesarse y se borra al terminar; lo que quede en
        # el diario al arrancar se reencola.
        pendiente = self._anotar_pendiente(
            group_id, name, content, source_description, episode_type, uuid, reference_time
        )

        async def process_episode():
            """Process the episode using the graphiti client."""
            try:
                logger.info(f'Processing episode {uuid} for group {group_id}')

                await self._con_reintento_rate_limit(
                    lambda: self._graphiti_client.add_episode(
                        name=name,
                        episode_body=content,
                        source_description=source_description,
                        source=episode_type,
                        group_id=group_id,
                    # PATCH (secondbrain): respetar la fecha real si viene del tool.
                        reference_time=reference_time or datetime.now(timezone.utc),
                        entity_types=entity_types,
                    # PATCH (secondbrain): instrucciones negativas al extractor.
                    # La ontologia sola no basta: el articulado de un contrato
                    # define roles ("el General Partner podra...") y el modelo
                    # los lee como entidades con nombre propio. Medido: las tres
                    # entidades mas conectadas del grafo eran "General Partner",
                    # "Partnership" y "Limited Partners", por delante de la
                    # sociedad real y del dueño.
                        custom_extraction_instructions=INSTRUCCIONES_EXTRACCION,
                        uuid=uuid,
                    ),
                    etiqueta=f'episodio {uuid}',
                )

                logger.info(f'Successfully processed episode {uuid} for group {group_id}')
                self._olvidar_pendiente(pendiente)

            except Exception as e:
                logger.error(f'Failed to process episode {uuid} for group {group_id}: {str(e)}')
                raise

        # Use the existing add_episode_task method to queue the processing
        return await self.add_episode_task(group_id, process_episode)
