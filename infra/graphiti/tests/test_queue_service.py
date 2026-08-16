"""Pruebas del parche `queue_service.py`.

Cubren los dos fallos que dejaron la cola parada en produccion (2026-08-16),
ambos invisibles en el log: uno se disfrazaba de rate limit del proveedor y el
otro convertia una cola secuencial en cientos de workers paralelos.

El modulo se carga por ruta porque vive en `patches/`, fuera de cualquier
paquete: en el servidor se copia encima de las fuentes del MCP.
"""

import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

RUTA = Path(__file__).resolve().parents[1] / "patches" / "queue_service.py"
_spec = importlib.util.spec_from_file_location("queue_service_parche", RUTA)
qs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(qs)


# --------------------------------------------------------------------------
# Sin saldo NO es rate limit
# --------------------------------------------------------------------------

MENSAJE_SIN_SALDO = (
    "Error code: 429 - {'error': {'message': 'You have no credits remaining. "
    "Add credits to continue using the API at https://platform.openai.com/"
    "settings/organization/billing/.', 'type': 'insufficient_quota', "
    "'code': 'credit_balance_exhausted'}}"
)

MENSAJE_RITMO = "Error code: 429 - {'error': {'message': 'Rate limit reached'}}"


def test_sin_saldo_no_se_confunde_con_ritmo():
    """El mensaje real de OpenAI: 429 y la palabra 'quota' en el mismo texto.

    `_SENALES_RATE_LIMIT` contiene "quota" y "429", asi que sin la comprobacion
    de saldo este mensaje se clasificaba como ritmo y se reintentaba.
    """
    err = RuntimeError(MENSAJE_SIN_SALDO)
    assert qs._es_sin_saldo(err) is True
    assert qs._es_rate_limit(err) is False


def test_un_rate_limit_de_verdad_sigue_siendo_reintentable():
    err = RuntimeError(MENSAJE_RITMO)
    assert qs._es_sin_saldo(err) is False
    assert qs._es_rate_limit(err) is True


def test_un_error_cualquiera_no_es_ninguno_de_los_dos():
    err = ValueError("el documento no tiene texto")
    assert qs._es_sin_saldo(err) is False
    assert qs._es_rate_limit(err) is False


@pytest.mark.asyncio
async def test_sin_saldo_falla_rapido_y_sin_esperar(monkeypatch):
    """Lo caro no era el reintento: era esperar 300s por episodio para nada."""
    dormido = []
    real_sleep = asyncio.sleep  # `qs.asyncio` ES el modulo global: sin esto el
    # parche se llama a si mismo y revienta por recursion.

    async def falso_sleep(segundos):
        dormido.append(segundos)
        await real_sleep(0)

    monkeypatch.setattr(qs.asyncio, "sleep", falso_sleep)

    intentos = 0

    async def hacer():
        nonlocal intentos
        intentos += 1
        raise RuntimeError(MENSAJE_SIN_SALDO)

    servicio = qs.QueueService()
    with pytest.raises(qs.SinSaldoError):
        await servicio._con_reintento_rate_limit(hacer, "episodio de prueba")

    assert intentos == 1, "no debe reintentarse algo que no se arregla esperando"
    assert dormido == [], "no debe dormir ni un segundo"


@pytest.mark.asyncio
async def test_un_rate_limit_si_reintenta(monkeypatch):
    real_sleep = asyncio.sleep

    async def falso_sleep(_segundos):
        await real_sleep(0)

    monkeypatch.setattr(qs.asyncio, "sleep", falso_sleep)
    intentos = 0

    async def hacer():
        nonlocal intentos
        intentos += 1
        if intentos < 3:
            raise RuntimeError(MENSAJE_RITMO)
        return "ok"

    servicio = qs.QueueService()
    assert await servicio._con_reintento_rate_limit(hacer, "ep") == "ok"
    assert intentos == 3


# --------------------------------------------------------------------------
# Un solo worker por group_id
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_encolar_en_bucle_cerrado_crea_UN_solo_worker():
    """La reproduccion exacta del incidente.

    `recuperar_pendientes` encola cientos de episodios seguidos sin ceder el
    control al bucle de eventos. Con la bandera marcada dentro del worker,
    ninguna tarea alcanzaba a arrancar y cada iteracion creaba otro worker:
    336 workers consumiendo la misma cola convirtieron una cola secuencial en
    ~124 episodios simultaneos contra el proveedor.
    """
    servicio = qs.QueueService()
    creados = 0
    original = qs.asyncio.create_task

    def contar(coro, *a, **k):
        nonlocal creados
        creados += 1
        return original(coro, *a, **k)

    qs.asyncio.create_task = contar
    try:
        procesados = 0

        async def contar_uno():
            nonlocal procesados
            procesados += 1

        # Bucle cerrado, sin await que ceda: es lo que hace la recuperacion.
        for _ in range(50):
            await servicio.add_episode_task("jpreyest", contar_uno)

        assert creados == qs.BRAIN_WORKERS, (
            f"se crearon {creados} workers; el tope es {qs.BRAIN_WORKERS}"
        )
        assert creados <= 8, "tope absoluto: comparar solo contra la propia variable"
        assert qs.BRAIN_WORKERS <= 8, "un default alto seria el bug de vuelta"

        for _ in range(200):  # deja correr a los workers
            await asyncio.sleep(0)
        assert procesados == 50, (
            f"solo se procesaron {procesados}/50: con el worker vacio este test "
            f"pasaba igual y no probaba nada"
        )
    finally:
        qs.asyncio.create_task = original


@pytest.mark.asyncio
async def test_la_cola_se_procesa_de_a_uno():
    """Con un solo worker, dos episodios no pueden solaparse."""
    servicio = qs.QueueService()
    en_vuelo = 0
    maximo = 0
    hechos = 0

    async def tarea():
        nonlocal en_vuelo, maximo, hechos
        en_vuelo += 1
        maximo = max(maximo, en_vuelo)
        await asyncio.sleep(0)
        en_vuelo -= 1
        hechos += 1

    for _ in range(10):
        await servicio.add_episode_task("jpreyest", tarea)

    for _ in range(200):  # deja correr a los workers
        await asyncio.sleep(0)

    assert hechos == 10, f"solo se procesaron {hechos}/10; el worker no esta trabajando"
    assert maximo >= 1, "no llego a ejecutarse nada"
    assert maximo <= qs.BRAIN_WORKERS, (
        f"hubo {maximo} episodios a la vez; el tope es {qs.BRAIN_WORKERS}"
    )


# --------------------------------------------------------------------------
# El diario es por tenant
# --------------------------------------------------------------------------


def test_el_diario_vive_en_un_subdirectorio_por_tenant(tmp_path, monkeypatch):
    """Dos tenants compartiendo directorio fue el fallo mas caro de la noche.

    El MCP de `delivered-2` recuperaba al arrancar los 259 episodios de
    `jpreyest` — el glob no mira de quien son — y los reencolaba contra su
    propio grafo. FalkorDB lo freno con "No permissions to access a key", pero
    el proceso moria por eso y al reiniciar repetia el ciclo: el diario ajeno
    se reescribia entero cada ~100s y su cola no drenaba nunca.
    """
    monkeypatch.setenv("BRAIN_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("GRAPHITI_GROUP_ID", "jpreyest")
    a = qs.QueueService()._dir_diario

    monkeypatch.setenv("GRAPHITI_GROUP_ID", "delivered-2")
    b = qs.QueueService()._dir_diario

    assert a != b, "cada tenant necesita su propio diario"
    assert a.name == "jpreyest" and b.name == "delivered-2"


@pytest.mark.asyncio
async def test_no_se_toca_la_anotacion_de_otro_tenant(tmp_path, monkeypatch):
    """Ni procesarla ni borrarla: borrarla destruye trabajo de otra persona."""
    monkeypatch.setenv("BRAIN_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("GRAPHITI_GROUP_ID", "delivered-2")

    servicio = qs.QueueService()
    diario = servicio._dir_diario
    ajena = diario / "jpreyest-cafe.json"
    ajena.write_text(
        json.dumps({"group_id": "jpreyest", "name": "escritura", "content": "x"}),
        encoding="utf-8",
    )
    propia = diario / "delivered-2-beef.json"
    propia.write_text(
        json.dumps({"group_id": "delivered-2", "name": "mia", "content": "y"}),
        encoding="utf-8",
    )

    encolados = []

    async def espia(**kw):
        encolados.append(kw["group_id"])

    servicio.add_episode = espia
    assert await servicio.recuperar_pendientes() == 1

    assert encolados == ["delivered-2"], "solo se reencola lo propio"
    assert ajena.exists(), "la anotacion ajena NO se borra"


# --------------------------------------------------------------------------
# La excepcion que llega DE VERDAD desde graphiti
# --------------------------------------------------------------------------


class RateLimitError(Exception):
    """Reproduce la de graphiti: envuelve la de OpenAI y PIERDE su mensaje.

    `graphiti_core/llm_client/openai_base_client.py` hace `raise
    RateLimitError from e` sin argumentos, y su clase trae el texto por
    defecto. El motivo real —insufficient_quota— solo sobrevive en __cause__.
    """

    def __init__(self, message='Rate limit exceeded. Please try again later.'):
        super().__init__(message)


class ErrorOpenAI(Exception):
    """Doble del error del SDK: mensaje largo + campos estructurados."""

    def __init__(self, mensaje, code=None, body=None):
        super().__init__(mensaje)
        self.code = code
        self.body = body


def _como_en_produccion(interna: Exception) -> Exception:
    """Envuelve como lo hace graphiti: `raise X from interna`."""
    try:
        raise interna
    except Exception as e:
        try:
            raise RateLimitError from e
        except RateLimitError as envuelta:
            return envuelta


def test_sin_saldo_se_detecta_a_traves_de_la_envoltura_de_graphiti():
    """El bug que el primer arreglo NO arreglaba.

    Mirar solo `str(exc)` da "Rate limit exceeded. Please try again later.",
    asi que se clasificaba como ritmo y volvian los 300s de espera por
    episodio contra algo que no se arregla esperando. El test viejo pasaba
    porque construia la excepcion a mano, de una forma que produccion nunca
    genera.
    """
    envuelta = _como_en_produccion(ErrorOpenAI(MENSAJE_SIN_SALDO))

    assert str(envuelta) == 'Rate limit exceeded. Please try again later.'
    assert qs._es_sin_saldo(envuelta) is True, "no se miro dentro de __cause__"
    assert qs._es_rate_limit(envuelta) is False


def test_sin_saldo_se_detecta_por_los_campos_del_sdk():
    """Aunque el proveedor reescriba el texto, `code` sigue diciendo la verdad."""
    interna = ErrorOpenAI(
        'Error code: 429', code='insufficient_quota', body={'error': {'type': 'insufficient_quota'}}
    )
    envuelta = _como_en_produccion(interna)
    assert qs._es_sin_saldo(envuelta) is True


def test_un_rate_limit_envuelto_sigue_siendo_reintentable():
    """El caso bueno no se puede romper al arreglar el malo."""
    envuelta = _como_en_produccion(ErrorOpenAI(MENSAJE_RITMO))
    assert qs._es_sin_saldo(envuelta) is False
    assert qs._es_rate_limit(envuelta) is True


def test_una_rate_limit_pelada_de_graphiti_se_reintenta():
    """Sin causa legible, el tipo es lo unico que queda."""
    assert qs._es_rate_limit(RateLimitError()) is True


def test_una_cadena_circular_no_cuelga():
    a = RuntimeError("a")
    b = RuntimeError("b")
    a.__cause__ = b
    b.__cause__ = a
    assert qs._es_sin_saldo(a) is False  # y sobre todo: termina


# --------------------------------------------------------------------------
# El nombre del archivo del diario lo elige el CLIENTE
# --------------------------------------------------------------------------


def test_un_uuid_con_traversal_no_escribe_fuera_del_diario(tmp_path, monkeypatch):
    """`uuid` es un parametro publico de la tool `add_memory`.

    Sin sanear, `uuid="../jpreyest/EP-1"` desde el MCP de otro tenant pisa un
    episodio PENDIENTE de la victima; al reiniciar, su propia defensa lo ve
    "de otro tenant" y lo salta: trabajo perdido para siempre y en silencio.
    """
    monkeypatch.setenv("BRAIN_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("GRAPHITI_GROUP_ID", "delivered-2")

    victima = tmp_path / "jpreyest"
    victima.mkdir()
    pendiente = victima / "EP-1.json"
    pendiente.write_text(json.dumps({"group_id": "jpreyest", "name": "escritura"}), encoding="utf-8")

    servicio = qs.QueueService()
    destino = servicio._anotar_pendiente(
        "delivered-2", "n", "c", "d", "text", "../jpreyest/EP-1", None
    )

    assert destino is not None
    assert destino.parent == (tmp_path / "delivered-2"), "escribio fuera de su diario"
    assert json.loads(pendiente.read_text(encoding="utf-8"))["group_id"] == "jpreyest", (
        "se piso el pendiente del otro tenant"
    )


def test_un_uuid_absoluto_tampoco_escapa(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("GRAPHITI_GROUP_ID", "jpreyest")
    servicio = qs.QueueService()

    destino = servicio._anotar_pendiente("jpreyest", "n", "c", "d", "text", "/etc/cron.d/x", None)

    assert destino.parent == (tmp_path / "jpreyest")


def test_un_group_id_vacio_no_usa_la_base_compartida(tmp_path, monkeypatch):
    """Con el valor vacio, el diario volvia a ser comun a todos los tenants Y
    la defensa de recuperar_pendientes se apagaba: el incidente entero."""
    monkeypatch.setenv("BRAIN_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("GRAPHITI_GROUP_ID", "")

    diario = qs.QueueService()._dir_diario

    assert diario != tmp_path, "el diario no puede ser la base compartida"
    assert diario.parent == tmp_path


def test_un_group_id_con_traversal_se_sanea(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("GRAPHITI_GROUP_ID", "../otro")

    diario = qs.QueueService()._dir_diario

    assert diario.parent == tmp_path, f"el diario salio de la base: {diario}"


def test_la_anotacion_se_escribe_de_forma_atomica(tmp_path, monkeypatch):
    """Un JSON truncado lo borra `recuperar_pendientes` por ilegible, o sea
    que una escritura a medias PIERDE el episodio."""
    monkeypatch.setenv("BRAIN_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("GRAPHITI_GROUP_ID", "jpreyest")
    servicio = qs.QueueService()

    destino = servicio._anotar_pendiente("jpreyest", "n", "contenido", "d", "text", "EP-9", None)

    assert json.loads(destino.read_text(encoding="utf-8"))["content"] == "contenido"
    assert list(destino.parent.glob("*.tmp")) == [], "quedo un temporal sin limpiar"


@pytest.mark.asyncio
async def test_un_json_sin_group_id_no_aborta_la_recuperacion(tmp_path, monkeypatch):
    """Antes `d['group_id']` lanzaba KeyError FUERA del try y se llevaba por
    delante la recuperacion entera: el resto de episodios no se reencolaba."""
    monkeypatch.setenv("BRAIN_QUEUE_DIR", str(tmp_path))
    monkeypatch.setenv("GRAPHITI_GROUP_ID", "jpreyest")
    servicio = qs.QueueService()
    diario = servicio._dir_diario

    (diario / "malo.json").write_text(json.dumps({"name": "sin grupo"}), encoding="utf-8")
    (diario / "bueno.json").write_text(
        json.dumps({"group_id": "jpreyest", "name": "bueno", "content": "x"}), encoding="utf-8"
    )

    encolados = []

    async def espia(**kw):
        encolados.append(kw["name"])

    servicio.add_episode = espia
    await servicio.recuperar_pendientes()

    assert "bueno" in encolados, "un archivo raro no puede parar la recuperacion"
