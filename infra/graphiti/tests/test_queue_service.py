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
        async def nada():
            return None

        # Bucle cerrado, sin await que ceda: es lo que hace la recuperacion.
        for _ in range(50):
            await servicio.add_episode_task("jpreyest", nada)

        assert creados == qs.BRAIN_WORKERS, (
            f"se crearon {creados} workers; el tope es {qs.BRAIN_WORKERS}"
        )
    finally:
        qs.asyncio.create_task = original


@pytest.mark.asyncio
async def test_la_cola_se_procesa_de_a_uno():
    """Con un solo worker, dos episodios no pueden solaparse."""
    servicio = qs.QueueService()
    en_vuelo = 0
    maximo = 0

    async def tarea():
        nonlocal en_vuelo, maximo
        en_vuelo += 1
        maximo = max(maximo, en_vuelo)
        await asyncio.sleep(0)
        en_vuelo -= 1

    for _ in range(10):
        await servicio.add_episode_task("jpreyest", tarea)

    for _ in range(50):  # deja correr al worker
        await asyncio.sleep(0)

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
