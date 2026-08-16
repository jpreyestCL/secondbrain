"""Pruebas del parche de escritura al grafo (`factories.py`).

`add_episode` termina en `add_nodes_and_edges_bulk`, cuya funcion de
transaccion genera los embeddings que falten en un bucle SECUENCIAL: una ida y
vuelta HTTP por nodo y otra por arista. Medido en produccion: 34 llamadas por
episodio, mediana 0,43 s entre ellas.

El parche los pre-genera en lotes para que ese bucle no encuentre nada que
hacer. Lo que hay que garantizar es que agrupa, que respeta el ORDEN (un
embedding en el nodo equivocado es peor que uno lento) y que si el lote falla
la ingesta sigue.

`factories.py` importa `config.schema` y `graphiti_core`, que no estan
disponibles fuera del servidor, asi que aqui se prueba la logica cargando solo
las funciones del parche desde el archivo.
"""

import asyncio
import importlib.util
import sys
import types
from pathlib import Path

import pytest

RUTA = Path(__file__).resolve().parents[1] / "patches" / "factories.py"


def _cargar_parche():
    """Carga solo el bloque del parche, sin el resto del modulo.

    Se extrae el texto desde el marcador y se ejecuta en un modulo vacio: asi
    la prueba no arrastra `config.schema` ni los clientes de graphiti.
    """
    texto = RUTA.read_text(encoding="utf-8")
    marca = "# PATCH (secondbrain): escritura al grafo serializada"
    assert marca in texto, "el parche de lotes desaparecio de factories.py"
    cuerpo = texto[texto.index(marca) :]
    # La instalacion real necesita graphiti; aqui solo interesan las funciones.
    cuerpo = cuerpo.replace("instalar_parche_escritura()", "")
    mod = types.ModuleType("parche_lote")
    mod.__dict__["__name__"] = "parche_lote"
    exec(compile(cuerpo, str(RUTA), "exec"), mod.__dict__)
    return mod


parche = _cargar_parche()


@pytest.fixture(autouse=True)
def _aisla_modulos():
    """Las pruebas sustituyen `graphiti_core` por dobles.

    Sin restaurarlo, el modulo falso se queda en `sys.modules` y el siguiente
    archivo de pruebas —que importa el graphiti_core de verdad— falla con
    "'graphiti_core' is not a package". Paso.
    """
    nombres = [n for n in sys.modules if n == "graphiti_core" or n.startswith("graphiti_core.")]
    guardado = {n: sys.modules[n] for n in nombres}
    yield
    for n in [n for n in sys.modules if n == "graphiti_core" or n.startswith("graphiti_core.")]:
        del sys.modules[n]
    sys.modules.update(guardado)


def _montar_graphiti_falso(original):
    """Deja `graphiti_core` sustituido por dobles y devuelve el modulo bulk.

    Cada prueba monta el suyo: la fixture `_aisla_modulos` los retira al
    terminar, asi que ninguna puede apoyarse en lo que dejo la anterior.
    """
    bulk = types.ModuleType("bulk")
    bulk.add_nodes_and_edges_bulk = original
    grafo = types.ModuleType("graphiti")
    grafo.add_nodes_and_edges_bulk = original
    raiz = types.ModuleType("graphiti_core")
    utils = types.ModuleType("graphiti_core.utils")
    raiz.graphiti = grafo
    utils.bulk_utils = bulk
    sys.modules["graphiti_core"] = raiz
    sys.modules["graphiti_core.graphiti"] = grafo
    sys.modules["graphiti_core.utils"] = utils
    sys.modules["graphiti_core.utils.bulk_utils"] = bulk
    return bulk


class EmbedderFalso:
    """Cuenta peticiones y devuelve un vector reconocible por texto."""

    def __init__(self, falla=False):
        self.peticiones: list[list[str]] = []
        self.falla = falla

    async def create_batch(self, textos):
        if self.falla:
            raise RuntimeError("el proveedor dijo que no")
        self.peticiones.append(list(textos))
        return [[float(len(t)), float(sum(map(ord, t)) % 97)] for t in textos]


class Nodo:
    def __init__(self, name, emb=None):
        self.name, self.name_embedding = name, emb


class Arista:
    def __init__(self, fact, emb=None):
        self.fact, self.fact_embedding = fact, emb


@pytest.fixture(autouse=True)
def _config_por_defecto(monkeypatch):
    monkeypatch.setattr(parche, "BRAIN_EMBED_LOTE", 64)
    monkeypatch.setattr(parche, "BRAIN_ESCRITURA_SERIAL", True)
    monkeypatch.setattr(parche, "_candado_escritura", None)


@pytest.mark.asyncio
async def test_una_sola_peticion_para_muchos_textos():
    emb = EmbedderFalso()
    textos = [f"entidad {i}" for i in range(10)]
    vectores = await parche._en_lotes(emb, textos)

    assert len(emb.peticiones) == 1, "10 textos deben ir en UNA peticion"
    assert len(vectores) == 10


@pytest.mark.asyncio
async def test_se_trocea_en_lotes_del_tamano_configurado(monkeypatch):
    monkeypatch.setattr(parche, "BRAIN_EMBED_LOTE", 4)
    emb = EmbedderFalso()
    textos = [f"t{i}" for i in range(10)]
    vectores = await parche._en_lotes(emb, textos)

    assert [len(p) for p in emb.peticiones] == [4, 4, 2]
    # El orden global se conserva pese al troceo.
    assert vectores == [[float(len(t)), float(sum(map(ord, t)) % 97)] for t in textos]


@pytest.mark.asyncio
async def test_cada_vector_va_a_su_nodo():
    """Un embedding en el nodo equivocado es peor que uno lento: no falla,
    miente. La busqueda devolveria la entidad que no es."""
    emb = EmbedderFalso()
    nodos = [Nodo("Banco de Chile"), Nodo("Inversiones Linets SpA"), Nodo("Juan Pablo")]
    vectores = await parche._en_lotes(emb, [n.name for n in nodos])
    for nodo, v in zip(nodos, vectores, strict=True):
        nodo.name_embedding = v

    for nodo in nodos:
        esperado = [float(len(nodo.name)), float(sum(map(ord, nodo.name)) % 97)]
        assert nodo.name_embedding == esperado, f"vector cruzado en {nodo.name}"


@pytest.mark.asyncio
async def test_no_se_repiten_los_que_ya_tienen_embedding():
    """El bucle original solo genera si falta; el lote debe filtrar igual."""
    emb = EmbedderFalso()
    nodos = [Nodo("nuevo"), Nodo("viejo", emb=[1.0, 2.0]), Nodo("otro nuevo")]
    faltan = [n for n in nodos if n.name and n.name_embedding is None]

    await parche._en_lotes(emb, [n.name for n in faltan])

    assert emb.peticiones == [["nuevo", "otro nuevo"]]


@pytest.mark.asyncio
async def test_si_el_lote_falla_la_ingesta_sigue():
    """Una optimizacion jamas debe tumbar la ingesta.

    Si el lote revienta, la funcion original genera los embeddings de a uno,
    como siempre: mas lento, pero el episodio entra.
    """
    llamadas = {"original": 0}

    async def original(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        llamadas["original"] += 1
        return "escrito"

    bulk = _montar_graphiti_falso(original)

    assert parche.instalar_parche_escritura() is True
    envuelta = bulk.add_nodes_and_edges_bulk

    resultado = await envuelta(None, [], [], [Nodo("algo")], [Arista("un hecho")],
                               EmbedderFalso(falla=True))

    assert resultado == "escrito", "la escritura debe ocurrir igual"
    assert llamadas["original"] == 1
    assert envuelta is not original, "la envoltura debe estar instalada"


@pytest.mark.asyncio
async def test_instalar_dos_veces_no_anida_envolturas():
    """Importar el modulo dos veces no debe apilar wrappers (y duplicar lotes)."""
    llamadas = {"n": 0}

    async def original(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        llamadas["n"] += 1
        return "ok"

    bulk = _montar_graphiti_falso(original)

    parche.instalar_parche_escritura()
    primera = bulk.add_nodes_and_edges_bulk
    parche.instalar_parche_escritura()

    assert bulk.add_nodes_and_edges_bulk is primera, "se envolvio dos veces"


@pytest.mark.asyncio
async def test_los_embeddings_quedan_puestos_antes_de_escribir():
    """El objetivo real: que el bucle secuencial no encuentre nada pendiente."""
    vistos = {}

    async def original(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        vistos["nodos"] = [n.name_embedding for n in ent_n]
        vistos["aristas"] = [e.fact_embedding for e in ent_e]
        return "ok"

    bulk = _montar_graphiti_falso(original)
    parche.instalar_parche_escritura()

    emb = EmbedderFalso()
    await bulk.add_nodes_and_edges_bulk(
        None, [], [], [Nodo("Banco"), Nodo("Linets")], [Arista("es dueño de")], emb
    )

    assert all(v is not None for v in vistos["nodos"]), "quedo un nodo sin embedding"
    assert all(v is not None for v in vistos["aristas"]), "quedo una arista sin embedding"
    # Dos peticiones: una de nodos y otra de aristas. Antes eran 3 llamadas.
    assert len(emb.peticiones) == 2
    assert emb.peticiones[0] == ["Banco", "Linets"]


# --------------------------------------------------------------------------
# La escritura al grafo va de a una
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dos_escrituras_concurrentes_no_se_solapan():
    """El fallo que tumbo la ingesta tres veces el 2026-08-16.

    Varios workers escribiendo a la vez en el mismo grafo, con FalkorDB a 8
    hilos compartidos y TIMEOUT=0, terminaban trabandolo: PING respondia,
    GRAPH.QUERY se colgaba y la ingesta se paraba sin un solo error en el log.
    """
    dentro = 0
    maximo = 0

    async def original(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        nonlocal dentro, maximo
        dentro += 1
        maximo = max(maximo, dentro)
        await asyncio.sleep(0.01)  # simula la escritura
        dentro -= 1
        return "ok"

    bulk = _montar_graphiti_falso(original)
    parche.instalar_parche_escritura()
    escribir = bulk.add_nodes_and_edges_bulk

    await asyncio.gather(*[
        escribir(None, [], [], [Nodo(f"n{i}")], [], EmbedderFalso()) for i in range(8)
    ])

    assert maximo == 1, f"hubo {maximo} escrituras simultaneas; deben ser de a una"


@pytest.mark.asyncio
async def test_los_embeddings_si_se_solapan():
    """El candado protege la ESCRITURA, no la red.

    Si los embeddings quedaran dentro del candado se serializaria justo lo que
    conviene paralelizar, y el pool de workers no serviria de nada.
    """
    embeddings_a_la_vez = 0
    maximo = 0

    class EmbedderLento(EmbedderFalso):
        async def create_batch(self, textos):
            nonlocal embeddings_a_la_vez, maximo
            embeddings_a_la_vez += 1
            maximo = max(maximo, embeddings_a_la_vez)
            await asyncio.sleep(0.01)
            embeddings_a_la_vez -= 1
            return [[0.0] for _ in textos]

    async def original(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        return "ok"

    bulk = _montar_graphiti_falso(original)
    parche.instalar_parche_escritura()
    escribir = bulk.add_nodes_and_edges_bulk

    await asyncio.gather(*[
        escribir(None, [], [], [Nodo(f"n{i}")], [], EmbedderLento()) for i in range(5)
    ])

    assert maximo > 1, "los embeddings deben poder solaparse entre workers"


@pytest.mark.asyncio
async def test_una_escritura_que_falla_libera_el_candado():
    """Si la excepcion se llevara el candado puesto, la cola entera se cuelga:
    todos los demas workers quedarian esperando para siempre."""
    async def original(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        raise RuntimeError("FalkorDB dijo que no")

    bulk = _montar_graphiti_falso(original)
    parche.instalar_parche_escritura()
    escribir = bulk.add_nodes_and_edges_bulk

    with pytest.raises(RuntimeError):
        await escribir(None, [], [], [], [], EmbedderFalso())

    assert not parche._lock_escritura().locked(), "el candado quedo tomado"

    async def ok(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        return "ok"

    bulk.add_nodes_and_edges_bulk._secondbrain_parche = False
    _montar_graphiti_falso(ok)
    parche.instalar_parche_escritura()
    assert await sys.modules["graphiti_core.utils.bulk_utils"].add_nodes_and_edges_bulk(
        None, [], [], [], [], EmbedderFalso()
    ) == "ok"


@pytest.mark.asyncio
async def test_se_puede_apagar_la_serializacion(monkeypatch):
    """Apagarlo es volver al estado que trababa el grafo; existe para medir."""
    monkeypatch.setattr(parche, "BRAIN_ESCRITURA_SERIAL", False)
    dentro = 0
    maximo = 0

    async def original(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        nonlocal dentro, maximo
        dentro += 1
        maximo = max(maximo, dentro)
        await asyncio.sleep(0.01)
        dentro -= 1
        return "ok"

    bulk = _montar_graphiti_falso(original)
    parche.instalar_parche_escritura()
    escribir = bulk.add_nodes_and_edges_bulk

    await asyncio.gather(*[
        escribir(None, [], [], [], [], EmbedderFalso()) for _ in range(4)
    ])

    assert maximo > 1


# --------------------------------------------------------------------------
# El lote respeta el tope de tokens del proveedor
# --------------------------------------------------------------------------


def test_un_lote_no_supera_el_presupuesto_de_tokens(monkeypatch):
    """El fallo real: agrupar de a 64 sin mirar el tamano.

    `nv-embed-v1` corta en 4096 tokens POR PETICION, no por texto. Con lotes
    de 64 aparecio "Input length 4286 exceeds maximum allowed token size 4096"
    y el episodio entero fallaba.
    """
    monkeypatch.setattr(parche, "BRAIN_EMBED_TOKENS", 1000)
    monkeypatch.setattr(parche, "BRAIN_EMBED_LOTE", 64)

    textos = ["x" * 900 for _ in range(10)]  # ~301 tokens cada uno
    grupos = parche._agrupar(textos)

    for grupo in grupos:
        tokens = sum(parche._tokens_aprox(textos[i]) for i in grupo)
        assert tokens <= 1000, f"un lote se paso: {tokens} tokens"
    assert sum(len(g) for g in grupos) == 10, "no puede perderse ningun texto"


def test_un_texto_gigante_va_solo(monkeypatch):
    """Si no cabe ni el solo, va solo: el proveedor decide, igual que hacia el
    bucle original de a uno. Lo que no puede es arrastrar a otros al fallo."""
    monkeypatch.setattr(parche, "BRAIN_EMBED_TOKENS", 500)
    textos = ["corto", "y" * 9000, "otro corto"]

    grupos = parche._agrupar(textos)

    gigante = [g for g in grupos if 1 in g][0]
    assert gigante == [1], "el texto gigante debe ir solo"


def test_se_respeta_el_tope_de_cantidad(monkeypatch):
    monkeypatch.setattr(parche, "BRAIN_EMBED_TOKENS", 10**9)
    monkeypatch.setattr(parche, "BRAIN_EMBED_LOTE", 4)
    grupos = parche._agrupar(["t"] * 10)
    assert [len(g) for g in grupos] == [4, 4, 2]


@pytest.mark.asyncio
async def test_el_orden_sobrevive_al_troceo_por_tokens(monkeypatch):
    """Con lotes de tamano irregular es facil devolver los vectores cruzados,
    y un vector en el nodo equivocado no falla: miente."""
    monkeypatch.setattr(parche, "BRAIN_EMBED_TOKENS", 400)
    monkeypatch.setattr(parche, "BRAIN_EMBED_LOTE", 64)

    emb = EmbedderFalso()
    textos = ["a" * 600, "b", "c" * 900, "d", "e" * 300]
    vectores = await parche._en_lotes(emb, textos)

    assert len(emb.peticiones) > 1, "deberia haber troceado"
    assert vectores == [[float(len(t)), float(sum(map(ord, t)) % 97)] for t in textos]
    assert all(v is not None for v in vectores)
