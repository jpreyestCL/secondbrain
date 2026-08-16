"""Pruebas de la ingesta directa (sin LLM en el servidor).

Lo que hay que garantizar es lo que el LLM hacía antes: deduplicar entidades,
invalidar lo que quedó viejo y no inventarse fechas. Si esto se equivoca, el
grafo miente en silencio — que es peor que ser lento.
"""

import importlib.util
from datetime import datetime, timezone
from pathlib import Path

import pytest

RUTA = Path(__file__).resolve().parents[1] / "patches" / "hechos.py"
_spec = importlib.util.spec_from_file_location("hechos_parche", RUTA)
hechos = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hechos)


# --------------------------------------------------------------------------
# Normalizacion: la deduplicacion se apoya entera en esto
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "a,b",
    [
        ("Inversiones Linets SpA", "INVERSIONES LINETS SPA"),
        ("Inversiones Linets S.p.A.", "inversiones linets spa"),
        ("Banco de Chile", "BANCO  DE   CHILE"),
        ("Juan Pablo Reyes", "juan pablo reyes"),
        ("Clínica Alemana", "Clinica Alemana"),  # tildes
    ],
)
def test_variantes_del_mismo_nombre_colapsan(a, b):
    assert hechos.normalizar(a) == hechos.normalizar(b)


@pytest.mark.parametrize(
    "a,b",
    [
        ("Banco de Chile", "Banco Estado"),
        ("Inversiones Linets SpA", "Inversiones Linets Dos SpA"),
    ],
)
def test_nombres_distintos_no_colapsan(a, b):
    assert hechos.normalizar(a) != hechos.normalizar(b)


def test_no_intenta_adivinar_abreviaturas():
    """Deliberadamente estricto.

    "Banco Chile" y "Banco de Chile" NO se juntan: adivinarlo es justo lo que
    hacia el LLM cuando invento "Inversion Linets SpA" y fragmento el grafo.
    Normalizar de mas fusiona entidades distintas, que es irreversible.
    """
    assert hechos.normalizar("Banco Chile") != hechos.normalizar("Banco de Chile")


# --------------------------------------------------------------------------
# Fechas: regla de oro 1
# --------------------------------------------------------------------------


def test_sin_fecha_no_se_inventa_hoy():
    """Un grafo temporal con fechas de ingesta es un grafo inutil."""
    assert hechos._fecha(None) is None
    assert hechos._fecha("") is None
    assert hechos._fecha("no es una fecha") is None


def test_fechas_iso_con_y_sin_zona():
    assert hechos._fecha("2022-04-06").year == 2022
    assert hechos._fecha("2022-04-06T10:00:00Z").tzinfo is not None
    assert hechos._fecha("2022-04-06T10:00:00+00:00").month == 4


# --------------------------------------------------------------------------
# Validacion de la entrada
# --------------------------------------------------------------------------


def test_un_hecho_sobre_una_entidad_no_declarada_se_rechaza():
    """Si no, el grafo queda con nodos huerfanos sin tipo ni resumen."""
    problemas = hechos.validar(
        entidades=[{"nombre": "Juan Pablo", "tipo": "Persona"}],
        hechos=[{"sujeto": "Juan Pablo", "relacion": "es dueño de", "objeto": "Linets SpA"}],
    )
    assert any("Linets SpA" in p for p in problemas)


def test_se_devuelven_todos_los_problemas_de_una_vez():
    """Cada ida y vuelta le cuesta al usuario una llamada de su suscripcion."""
    problemas = hechos.validar(
        entidades=[{"nombre": "", "tipo": ""}, {"nombre": "X"}],
        hechos=[{"sujeto": "", "relacion": "", "objeto": ""}],
    )
    assert len(problemas) >= 5


def test_una_entrada_correcta_no_da_problemas():
    problemas = hechos.validar(
        entidades=[
            {"nombre": "Juan Pablo Reyes", "tipo": "Persona"},
            {"nombre": "Inversiones Linets SpA", "tipo": "Organizacion"},
        ],
        hechos=[{
            "sujeto": "Juan Pablo Reyes",
            "relacion": "es dueño de",
            "objeto": "Inversiones Linets SpA",
            "hecho": "Juan Pablo Reyes es dueño de Inversiones Linets SpA",
        }],
    )
    assert problemas == []


def test_el_sujeto_se_reconoce_aunque_venga_escrito_distinto():
    """El cliente puede escribir 'INVERSIONES LINETS SPA' en el hecho y
    'Inversiones Linets SpA' en la entidad: es la misma."""
    problemas = hechos.validar(
        entidades=[{"nombre": "Inversiones Linets SpA", "tipo": "Organizacion"},
                   {"nombre": "Banco de Chile", "tipo": "Organizacion"}],
        hechos=[{"sujeto": "INVERSIONES LINETS SPA", "relacion": "tiene cuenta en",
                 "objeto": "banco de chile"}],
    )
    assert problemas == []


# --------------------------------------------------------------------------
# Escritura: dedup, invalidacion y un solo lote de embeddings
# --------------------------------------------------------------------------


class DriverFalso:
    """Registra las consultas y responde a la de entidades existentes."""

    def __init__(self, existentes=None):
        self.consultas: list[tuple[str, dict]] = []
        self.existentes = existentes or []

    async def execute_query(self, consulta, **params):
        self.consultas.append((consulta, params))
        if "RETURN n.uuid AS uuid, n.name AS name" in consulta:
            return self.existentes, None, None
        if "SET r.invalid_at" in consulta:
            return [{"n": 1}], None, None
        return [], None, None


class EmbedderFalso:
    def __init__(self):
        self.llamadas = 0

    async def create_batch(self, textos):
        self.llamadas += 1
        return [[float(len(t))] for t in textos]


ENTIDADES = [
    {"nombre": "Juan Pablo Reyes", "tipo": "Persona"},
    {"nombre": "Inversiones Linets SpA", "tipo": "Organizacion"},
]
HECHOS = [{
    "sujeto": "Juan Pablo Reyes",
    "relacion": "es dueño de",
    "objeto": "Inversiones Linets SpA",
    "hecho": "Juan Pablo Reyes es dueño de Inversiones Linets SpA",
}]


@pytest.mark.asyncio
async def test_los_embeddings_van_en_UNA_sola_llamada():
    """El camino anterior hacia ~22 por episodio, secuenciales: ~14 s."""
    emb = EmbedderFalso()
    ing = hechos.IngestaDirecta(DriverFalso(), emb, "jpreyest")

    await ing.ingerir("escritura.pdf", ENTIDADES, HECHOS, fecha_documento="2022-04-06")

    assert emb.llamadas == 1


@pytest.mark.asyncio
async def test_una_entidad_que_ya_existe_se_reusa_y_no_se_duplica():
    driver = DriverFalso(existentes=[
        {"uuid": "uuid-linets", "name": "INVERSIONES LINETS S.P.A."},
    ])
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    r = await ing.ingerir("escritura.pdf", ENTIDADES, HECHOS, fecha_documento="2022-04-06")

    assert r["entidades_nuevas"] == 1, "solo la persona es nueva"
    assert r["entidades_reusadas"] == 1, "la sociedad ya existia, con otra grafia"


@pytest.mark.asyncio
async def test_un_hecho_nuevo_invalida_al_anterior_de_la_misma_relacion():
    """Es lo que permite responder '¿cual es mi cuenta?' y '¿y antes?'."""
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    r = await ing.ingerir("cartola.pdf", ENTIDADES, HECHOS, fecha_documento="2024-01-01")

    invalidacion = [c for c, _ in driver.consultas if "SET r.invalid_at" in c]
    assert invalidacion, "no se intento invalidar el hecho anterior"
    assert r["hechos_invalidados"] == 1


@pytest.mark.asyncio
async def test_sin_fecha_no_se_invalida_nada():
    """Invalidar sin saber la fecha es adivinar cual es mas reciente."""
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    r = await ing.ingerir("sin-fecha.pdf", ENTIDADES, HECHOS, fecha_documento=None)

    assert [c for c, _ in driver.consultas if "SET r.invalid_at" in c] == []
    assert r["hechos_invalidados"] == 0


@pytest.mark.asyncio
async def test_un_documento_produce_UN_episodio():
    """La unidad pasa a ser el documento, no el trozo: ahi esta el ahorro."""
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    await ing.ingerir("escritura.pdf", ENTIDADES, HECHOS, fecha_documento="2022-04-06")

    episodios = [c for c, _ in driver.consultas if "CREATE (e:Episodic" in c]
    assert len(episodios) == 1


@pytest.mark.asyncio
async def test_el_group_id_es_SIEMPRE_el_tenant():
    """Regla de oro 6: el group_id nunca es el dominio."""
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    await ing.ingerir("x.pdf", ENTIDADES, HECHOS, dominio="finanzas", fecha_documento="2024-01-01")

    for consulta, params in driver.consultas:
        if "gid" in params:
            assert params["gid"] == "jpreyest", f"group_id contaminado: {params['gid']}"


@pytest.mark.asyncio
async def test_el_dominio_viaja_como_metadata_no_como_particion():
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    await ing.ingerir("x.pdf", ENTIDADES, HECHOS, dominio="salud", fecha_documento="2024-01-01")

    ep = [p for c, p in driver.consultas if "CREATE (e:Episodic" in c][0]
    assert "dominio: salud" in ep["desc"]
    assert ep["name"].startswith("[salud] ")


@pytest.mark.asyncio
async def test_un_dominio_inventado_cae_a_personal():
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    await ing.ingerir("x.pdf", ENTIDADES, HECHOS, dominio="criptomonedas")

    ep = [p for c, p in driver.consultas if "CREATE (e:Episodic" in c][0]
    assert "dominio: personal" in ep["desc"]


@pytest.mark.asyncio
async def test_una_entidad_repetida_en_el_mismo_documento_se_crea_una_vez():
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    r = await ing.ingerir(
        "x.pdf",
        ENTIDADES + [{"nombre": "JUAN PABLO REYES", "tipo": "Persona"}],
        HECHOS,
        fecha_documento="2024-01-01",
    )

    assert r["entidades_nuevas"] == 2


# --------------------------------------------------------------------------
# El tipo de la ontologia tiene que llegar al grafo
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_la_entidad_se_crea_con_su_tipo_de_la_ontologia():
    """La ontologia NO es decorativa.

    Con las entidades como `:Entity` a secas, las mas conectadas del grafo
    acabaron siendo "General Partner" y "Partnership" —vocabulario de los
    contratos— por delante de la sociedad real y del dueno.
    """
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    await ing.ingerir("x.pdf", ENTIDADES, HECHOS, fecha_documento="2024-01-01")

    creaciones = [c for c, _ in driver.consultas if "CREATE (n:Entity" in c]
    assert any(":Entity:Persona" in c for c in creaciones), "falta la etiqueta Persona"
    assert any(":Entity:Organizacion" in c for c in creaciones), "falta Organizacion"


@pytest.mark.asyncio
async def test_un_tipo_inventado_no_se_interpola_en_el_cypher():
    """La etiqueta va INTERPOLADA (Cypher no la acepta como parametro), asi
    que texto libre ahi seria inyeccion."""
    driver = DriverFalso()
    ing = hechos.IngestaDirecta(driver, EmbedderFalso(), "jpreyest")

    await ing.ingerir(
        "x.pdf",
        [{"nombre": "X", "tipo": "Persona) DELETE (n"}, {"nombre": "Y", "tipo": "Criptomoneda"}],
        [],
        fecha_documento="2024-01-01",
    )

    creaciones = [c for c, _ in driver.consultas if "CREATE (n:Entity" in c]
    assert all("DELETE" not in c for c in creaciones), "se colo Cypher por el tipo"
    assert any(":Entity:Entidad" in c for c in creaciones)
