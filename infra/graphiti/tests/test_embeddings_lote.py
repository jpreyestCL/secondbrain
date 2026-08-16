"""Pruebas del parche de embeddings por lote (`factories.py`).

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
    marca = "# PATCH (secondbrain): embeddings por lote"
    assert marca in texto, "el parche de lotes desaparecio de factories.py"
    cuerpo = texto[texto.index(marca) :]
    # La instalacion real necesita graphiti; aqui solo interesan las funciones.
    cuerpo = cuerpo.replace("instalar_embeddings_por_lote()", "")
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
def _enciende_el_lote(monkeypatch):
    """En produccion viene APAGADO (ver el comentario en factories.py); las
    pruebas lo encienden para poder verificar la logica."""
    monkeypatch.setattr(parche, "BRAIN_EMBED_LOTE", 64)


@pytest.mark.asyncio
async def test_apagado_por_defecto_no_instala_nada():
    """El valor por defecto es 0: sin tocar el entorno, no se envuelve nada."""
    async def original(driver, ep_n, ep_e, ent_n, ent_e, embedder):
        return "ok"

    bulk = _montar_graphiti_falso(original)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(parche, "BRAIN_EMBED_LOTE", 0)
        assert parche.instalar_embeddings_por_lote() is False
    assert bulk.add_nodes_and_edges_bulk is original


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

    assert parche.instalar_embeddings_por_lote() is True
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

    parche.instalar_embeddings_por_lote()
    primera = bulk.add_nodes_and_edges_bulk
    parche.instalar_embeddings_por_lote()

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
    parche.instalar_embeddings_por_lote()

    emb = EmbedderFalso()
    await bulk.add_nodes_and_edges_bulk(
        None, [], [], [Nodo("Banco"), Nodo("Linets")], [Arista("es dueño de")], emb
    )

    assert all(v is not None for v in vistos["nodos"]), "quedo un nodo sin embedding"
    assert all(v is not None for v in vistos["aristas"]), "quedo una arista sin embedding"
    # Dos peticiones: una de nodos y otra de aristas. Antes eran 3 llamadas.
    assert len(emb.peticiones) == 2
    assert emb.peticiones[0] == ["Banco", "Linets"]
