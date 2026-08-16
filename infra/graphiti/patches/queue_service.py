"""Queue service for managing episode processing."""

import asyncio
import json
import logging
import os
import re
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

#: Episodios en paralelo por tenant. POR DEFECTO 1, y no es una timidez.
#:
#: Graphiti resuelve entidades LEYENDO el grafo antes de escribir: busca si
#: "Inversiones Linets SpA" ya existe y, si no, la crea. Dos episodios
#: simultaneos que mencionan la misma entidad buscan los dos, ninguno ve al
#: otro (todavia no esta escrita) y ambos crean un nodo. El resultado es la
#: entidad DUPLICADA y el grafo fragmentado que CLAUDE.md documenta como el
#: error caro — el mismo dano que hacian los modelos chicos, pero por
#: concurrencia. El contrato esta escrito en la propia tool `add_memory`:
#: "Episodes for the same group_id are processed sequentially to avoid race
#: conditions".
#:
#: El candado de `factories.py` NO lo arregla: serializa la escritura, no la
#: lectura+resolucion que la precede. Los dos episodios entran ordenados y cada
#: uno con su nodo nuevo.
#:
#: Subirlo cambia velocidad por integridad del grafo, y el grafo no se arregla
#: reingiriendo. Se deja configurable solo para medir, con el pool ACOTADO: la
#: version anterior tenia paralelismo accidental e ILIMITADO —un worker por
#: episodio encolado— y con 337 pendientes fueron ~124 episodios simultaneos,
#: 12 peticiones por segundo y cero avance.
def _entero_env(nombre: str, defecto: int, minimo: int = 1) -> int:
    """Lee un entero del entorno sin poder tumbar el arranque.

    `int('abc')` en el cuerpo del modulo revienta al importar, con una traza
    criptica en el arranque de un servicio. Un valor mal escrito debe degradar
    al defecto y decirlo, no impedir que el MCP levante.
    """
    crudo = (os.environ.get(nombre) or '').strip()
    if not crudo:
        return defecto
    try:
        return max(minimo, int(crudo))
    except ValueError:
        logger.warning(f'{nombre}={crudo!r} no es un entero; se usa {defecto}')
        return defecto


BRAIN_WORKERS = _entero_env('BRAIN_WORKERS', 1)

#: Cuanto puede tardar UN episodio antes de considerarlo atascado, en segundos.
#: Generoso: los grandes tardan ~140 s medidos. Llegar aqui significa que algo
#: no va a terminar nunca.
BRAIN_TOPE_EPISODIO = _entero_env('BRAIN_TOPE_EPISODIO', 900, minimo=60)

#: Todo lo que no sea esto se sustituye antes de usarse como nombre de archivo
#: o de directorio. El `uuid` de un episodio lo elige el CLIENTE (es un
#: parametro publico de la tool `add_memory`), asi que llega sin garantia
#: ninguna.
_NOMBRE_SEGURO = re.compile(r'[^A-Za-z0-9_.-]')

_SENALES_RATE_LIMIT = ("rate limit", "429", "too many requests", "quota")

#: Cuota/saldo agotado. OpenAI lo devuelve con el MISMO codigo 429 que un rate
#: limit, asi que sin esta lista el reintento espera 20+40+80+160s y se rinde,
#: episodio tras episodio, ante algo que no se arregla esperando. Paso: la cola
#: entera quedo parada y el log solo decia "Rate limit; esperando 40s", que
#: manda a diagnosticar el ritmo en vez de la facturacion.
_SENALES_SIN_SALDO = (
    "insufficient_quota",
    "credit_balance_exhausted",
    "no credits remaining",
    "exceeded your current quota",
    "billing",
)


class SinSaldoError(RuntimeError):
    """El proveedor rechaza por saldo/cuota, no por ritmo. No se reintenta."""


def _cadena(exc: BaseException):
    """La excepcion y todo lo que la envuelve.

    Graphiti hace `raise RateLimitError from e` SIN pasar el mensaje, y su
    `RateLimitError` trae uno por defecto ("Rate limit exceeded. Please try
    again later."). O sea que mirar solo `str(exc)` pierde el motivo real: el
    cuerpo de OpenAI con `insufficient_quota` vive en `__cause__`. Comprobarlo
    solo en el nivel de arriba fue el fallo de la primera version de esto — el
    test lo tapaba porque construia la excepcion a mano, de una forma que
    produccion no genera nunca.
    """
    visto = set()
    actual: BaseException | None = exc
    while actual is not None and id(actual) not in visto:
        visto.add(id(actual))
        yield actual
        actual = actual.__cause__ or actual.__context__


def _texto_completo(exc: BaseException) -> str:
    """Todo lo que se pueda leer de la cadena: mensajes y campos del SDK."""
    partes: list[str] = []
    for e in _cadena(exc):
        partes.append(str(e))
        # El SDK de OpenAI trae el motivo estructurado; es mas fiable que el
        # texto, que cambia con cada redaccion del proveedor.
        for campo in ('code', 'type'):
            valor = getattr(e, campo, None)
            if isinstance(valor, str):
                partes.append(valor)
        cuerpo = getattr(e, 'body', None)
        if isinstance(cuerpo, dict):
            partes.append(str(cuerpo))
    return ' '.join(partes).lower()


def _es_sin_saldo(exc: Exception) -> bool:
    return any(s in _texto_completo(exc) for s in _SENALES_SIN_SALDO)


def _es_rate_limit(exc: Exception) -> bool:
    # El orden importa: "quota" aparece en ambas familias de mensaje, y sin
    # saldo NO es un rate limit por mucho que el codigo HTTP coincida.
    if _es_sin_saldo(exc):
        return False
    # Basta con el nombre del tipo: graphiti envuelve en su propia
    # `RateLimitError`, que puede llegar sin ningun texto reconocible.
    if any(type(e).__name__ == 'RateLimitError' for e in _cadena(exc)):
        return True
    return any(s in _texto_completo(exc) for s in _SENALES_RATE_LIMIT)


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
        # PATCH (secondbrain): cuantos workers hay vivos por group_id. Antes era
        # un bool ("hay o no hay"), que no permite un pool acotado.
        self._queue_workers: dict[str, int] = {}
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

        # Start a worker for this queue if one isn't already running.
        #
        # PATCH (secondbrain): la bandera se marca AQUI, antes de crear la
        # tarea, y no dentro del worker. Marcarla dentro deja una ventana en la
        # que la tarea existe pero todavia no corre: `recuperar_pendientes`
        # encola cientos de episodios en un bucle cerrado sin ceder el control,
        # asi que la bandera seguia en False y se creaba UN WORKER POR EPISODIO.
        # Los 336 workers consumian la misma cola a la vez y convertian una cola
        # secuencial en ~124 episodios simultaneos: 12 peticiones por segundo
        # contra el proveedor, 2.000 rechazos en tres minutos y CERO episodios
        # procesados. El sintoma parecia "el proveedor nos limita"; la causa era
        # nuestra.
        # El contador sube ANTES de crear la tarea y nunca pasa de BRAIN_WORKERS.
        vivos = self._queue_workers.get(group_id, 0)
        if vivos < BRAIN_WORKERS:
            self._queue_workers[group_id] = vivos + 1
            asyncio.create_task(self._process_episode_queue(group_id))

        return self._episode_queues[group_id].qsize()

    async def _process_episode_queue(self, group_id: str) -> None:
        """Process episodes for a specific group_id sequentially.

        This function runs as a long-lived task that processes episodes
        from the queue one at a time.
        """
        logger.info(
            f'Starting episode queue worker for group_id: {group_id} '
            f'({self._queue_workers.get(group_id, 1)}/{BRAIN_WORKERS})'
        )

        try:
            while True:
                # Get the next episode processing function from the queue
                # This will wait if the queue is empty
                process_func = await self._episode_queues[group_id].get()

                try:
                    # PATCH (secondbrain): con tope de tiempo. Sin el, un
                    # episodio que se cuelga (una consulta a FalkorDB que no
                    # vuelve, una conexion a medias) para la cola ENTERA y sin
                    # una sola linea en el log. Paso: la ingesta estuvo OCHO
                    # HORAS detenida, el servidor seguia respondiendo al
                    # conector, y solo se descubrio al mirar a mano. Un
                    # episodio perdido se reintenta desde el diario; una cola
                    # muerta no se recupera sola.
                    await asyncio.wait_for(process_func(), timeout=BRAIN_TOPE_EPISODIO)
                except asyncio.TimeoutError:
                    logger.error(
                        f'ATASCO: un episodio de {group_id} lleva mas de '
                        f'{BRAIN_TOPE_EPISODIO}s sin terminar; se abandona y se '
                        f'sigue con el siguiente. Queda en el diario para el '
                        f'proximo arranque.'
                    )
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
            self._queue_workers[group_id] = max(0, self._queue_workers.get(group_id, 1) - 1)
            logger.info(f'Stopped episode queue worker for group_id: {group_id}')

    def get_queue_size(self, group_id: str) -> int:
        """Get the current queue size for a group_id."""
        if group_id not in self._episode_queues:
            return 0
        return self._episode_queues[group_id].qsize()

    def is_worker_running(self, group_id: str) -> bool:
        """Check if a worker is running for a group_id."""
        return self._queue_workers.get(group_id, 0) > 0

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
        # PATCH (secondbrain): el diario es POR TENANT. Cuando dos tenants
        # compartian BRAIN_QUEUE_DIR, el MCP de uno recuperaba al arrancar los
        # episodios del otro (el glob no mira de quien son), los borraba y los
        # reencolaba contra SU grafo. Lo salvo el ACL de FalkorDB — "No
        # permissions to access a key" — pero el proceso moria por eso, y al
        # reiniciar repetia el ciclo: el diario del primer tenant se reescribia
        # entero cada ~100s y su cola no drenaba nunca.
        base = Path(os.environ.get('BRAIN_QUEUE_DIR', '/tmp/brain-queue'))
        # NUNCA la base pelada. Con GRAPHITI_GROUP_ID vacio el diario volvia a
        # ser compartido Y la defensa de `recuperar_pendientes` se apagaba
        # (comprueba `if self._tenant and ...`), o sea que un proceso mal
        # configurado barria los pendientes de todos los demas tenants: el
        # incidente entero, reintroducido por la ruta del valor vacio.
        ruta = base / self._tenant
        ruta.mkdir(parents=True, exist_ok=True)
        return ruta

    @property
    def _tenant(self) -> str:
        """Nombre del tenant, saneado para poder usarse como directorio.

        `GRAPHITI_GROUP_ID` sale del entorno y acaba en una ruta: sin sanear,
        un valor como `../otro` deja el diario fuera de la base.
        """
        crudo = (os.environ.get('GRAPHITI_GROUP_ID') or '').strip()
        seguro = _NOMBRE_SEGURO.sub('_', crudo)[:64]
        return seguro or '_sin_tenant'

    def _anotar_pendiente(
        self, group_id, name, content, source_description, episode_type, uuid, reference_time
    ) -> 'Path | None':
        """Deja el episodio anotado en disco antes de procesarlo."""
        try:
            # El `uuid` lo elige el CLIENTE. Sin sanear, `uuid="../otro/EP-1"`
            # escribe en el diario de OTRO tenant: le pisa un episodio
            # pendiente que, al reiniciar, su propia defensa descarta por
            # "ajeno" — trabajo perdido para siempre y en silencio. Y con
            # `../../..` es escritura arbitraria de .json en cualquier ruta del
            # usuario del servicio.
            crudo = uuid or f'{group_id}-{abs(hash((name, content))):x}'
            clave = _NOMBRE_SEGURO.sub('_', str(crudo))[:120] or 'episodio'
            diario = self._dir_diario
            destino = diario / f'{clave}.json'
            # Cinturon y tirantes: aunque el saneado ya impide salir, se
            # comprueba que el destino cae DENTRO del diario del tenant.
            if destino.resolve().parent != diario.resolve():
                logger.warning(f'Anotacion fuera del diario ({destino}); se descarta el nombre')
                destino = diario / 'episodio.json'
            texto = json.dumps(
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
            )
            # Escritura ATOMICA. Con `write_text` directo, un corte a media
            # escritura (disco lleno, SIGKILL) deja un JSON truncado, y al
            # arrancar `recuperar_pendientes` lo ve ilegible y lo BORRA: el
            # episodio se pierde en silencio, que es justo lo que el diario
            # existe para impedir. Con tmp+replace el archivo final o esta
            # entero o no esta.
            tmp = destino.with_suffix('.json.tmp')
            tmp.write_text(texto, encoding='utf-8')
            os.replace(tmp, destino)
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
            if archivo.name.endswith('.json.tmp'):
                continue
            try:
                d = json.loads(archivo.read_text(encoding='utf-8'))
            except Exception:
                archivo.unlink(missing_ok=True)
                continue
            # Defensa en profundidad: aunque el diario ya es por tenant, jamas
            # tocar una anotacion ajena. Ni procesarla ni BORRARLA: borrarla
            # seria destruir el trabajo pendiente de otra persona.
            ajeno = d.get('group_id')
            if ajeno and ajeno != self._tenant:
                logger.warning(
                    f'Anotacion de otro tenant en {archivo.name} '
                    f'(group_id={ajeno}, soy {self._tenant}); se ignora'
                )
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
                # `.get`, no `d['group_id']`: era la unica clave sin defecto, y
                # un JSON valido sin ella lanzaba KeyError FUERA del try,
                # abortando la recuperacion ENTERA — el resto de episodios se
                # quedaba sin reencolar.
                group_id=ajeno or self._tenant,
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
                if _es_sin_saldo(e):
                    # Fallar rapido y con el motivo verdadero: reintentar esto
                    # solo retrasa el diagnostico y castiga al proveedor.
                    logger.error(
                        f'Sin saldo/cuota en el proveedor de LLM ({etiqueta}): {e}. '
                        f'No se reintenta; el episodio queda en el diario y se '
                        f'reencola al reiniciar cuando haya saldo.'
                    )
                    raise SinSaldoError(str(e)) from e
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
