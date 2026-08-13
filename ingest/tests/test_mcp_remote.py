"""Ingesta por el conector MCP (--via mcp): la vía que no requiere SSH."""

import asyncio
import json

import pytest

import brain_ingest.graph as graph_mod
from brain_ingest.graph import ingest_chunks
from brain_ingest.mcp_remote import ClienteMCP, McpRemoteError, _parse_sse


class _ClienteFalso:
    """Registra cada add_memory en vez de hablar con la red."""

    def __init__(self, fallar=None, no_confirmar=()):
        self.llamadas = []
        self.fallar = fallar
        #: Nombres que el servidor NO confirmara, para probar la verificacion.
        self.no_confirmar = set(no_confirmar)

    def llamar(self, nombre, argumentos, timeout=None):
        if nombre == "get_episodes":
            # El servidor real devuelve los episodios YA procesados; asi es como
            # el CLI confirma que lo enviado llego de verdad.
            episodios = [
                {"name": a["name"], "uuid": f"uuid-de-{a['name']}"}
                for n, a in self.llamadas
                if n == "add_memory" and a["name"] not in self.no_confirmar
            ]
            return json.dumps({"result": episodios})
        self.llamadas.append((nombre, argumentos))
        if self.fallar is not None:
            exc = self.fallar(len(self.llamadas))
            if exc is not None:
                raise exc
        return '{"message": "episodio encolado"}'


def _prep_doc(cfg, ledger, chunks, path="/docs/escritura.pdf"):
    _, doc_id = ledger.upsert_file(path, "sha-" + path, 10, 1e9)
    ledger.set_classification(doc_id, "finanzas", "escritura", "2022-10-31", ["financial"])
    (cfg.chunks_dir / f"{doc_id}.json").write_text(json.dumps(chunks), encoding="utf-8")
    return doc_id


def test_via_mcp_no_construye_cliente_de_falkordb(cfg, ledger, monkeypatch):
    """Con --via mcp no debe tocarse FalkorDB ni pedirse claves de LLM.

    Ese es el punto de la vía remota: quien no administra el servidor no tiene
    ni acceso a la base ni por que configurar modelos.
    """
    def _explota(_tenant):
        raise AssertionError("build_graphiti no debe llamarse en la via MCP")

    monkeypatch.setattr(graph_mod, "build_graphiti", _explota)
    doc_id = _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}])

    falso = _ClienteFalso()
    counts = asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    assert counts["docs"] == 1 and counts["episodes"] == 1 and counts["errors"] == 0
    assert ledger.get(doc_id).status == "ingested"


def test_el_cliente_nunca_manda_group_id(cfg, ledger, monkeypatch):
    """El group_id lo fuerza el servidor; mandarlo desde el cliente romperia
    el aislamiento entre personas (regla 6 de CLAUDE.md)."""
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}])

    falso = _ClienteFalso()
    asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    [(nombre, args)] = falso.llamadas
    assert nombre == "add_memory"
    assert "group_id" not in args


def test_metadatos_del_episodio_viajan_completos(cfg, ledger, monkeypatch):
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    doc_id = _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 2, "text": "hola"}])

    falso = _ClienteFalso()
    asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))
    _, args = falso.llamadas[0]

    assert args["name"].startswith("[finanzas] escritura.pdf [1/2]")
    assert args["source_description"].startswith("dominio: finanzas | tipo: escritura")
    assert f"doc_id={doc_id}" in args["source_description"]
    # La fecha real del documento, no la de hoy (regla de oro 1).
    assert args["reference_time"].startswith("2022-10-31")
    assert args["source"] == "text"


def test_nunca_se_manda_un_uuid_propio(cfg, ledger, monkeypatch):
    """Mandar un uuid generado por el cliente rompio la ingesta entera.

    graphiti interpreta un uuid explicito como "actualiza el episodio que ya
    existe con ese id". El servidor rechazo los 41 episodios de una carpeta,
    uno por uno, con `node <uuid> not found`, mientras el CLI reportaba
    "41 episodes, 0 errors".
    """
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}])

    falso = _ClienteFalso()
    asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    _, args = falso.llamadas[0]
    assert "uuid" not in args


def test_el_uuid_real_se_reconcilia_contra_el_servidor(cfg, ledger, monkeypatch):
    """El uuid se resuelve preguntando que llego, no inventandolo.

    Es lo que permite que `brain expire` pueda borrar ese episodio despues.
    """
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    doc_id = _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}])

    falso = _ClienteFalso()
    counts = asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    [ep] = ledger.episodes_for_doc(doc_id)
    assert ep["episode_uuid"].startswith("uuid-de-")  # el que dio el servidor
    assert not ep["episode_uuid"].startswith(graph_mod.PENDIENTE_PREFIJO)
    assert ep["group_id"] == cfg.tenant
    assert counts["confirmados"] == 1 and counts["no_confirmados"] == 0


def test_si_el_servidor_no_confirma_el_documento_queda_en_error(cfg, ledger, monkeypatch):
    """Dar por ingerido algo que no esta en el grafo es peor que fallar.

    add_memory responde al ENCOLAR, asi que sin verificar, una falla del lado
    del servidor se ve identica a un envio exitoso — y el usuario se entera
    recien al preguntarle a Claude y no encontrar nada.
    """
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    # Sin esto el test espera los 120 s reales que el CLI le da al servidor.
    monkeypatch.setenv("BRAIN_VERIFY_SECONDS", "0")
    doc_id = _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}])

    falso = _ClienteFalso(no_confirmar=["[finanzas] escritura.pdf [1/1]"])
    counts = asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    assert counts["no_confirmados"] == 1
    assert ledger.get(doc_id).status == "error"
    # Sin registro del episodio, un reintento vuelve a enviarlo.
    assert ledger.episodes_for_doc(doc_id) == []


def test_reanuda_sin_duplicar_por_mcp(cfg, ledger, monkeypatch):
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    doc_id = _prep_doc(
        cfg,
        ledger,
        [
            {"chunk_idx": 0, "total_chunks": 2, "text": "uno"},
            {"chunk_idx": 1, "total_chunks": 2, "text": "dos"},
        ],
    )
    ledger.record_episode("ya-estaba", doc_id, 0, cfg.tenant, domain="finanzas")

    falso = _ClienteFalso()
    counts = asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    assert counts["episodes"] == 1
    assert len(falso.llamadas) == 1
    assert "dos" in falso.llamadas[0][1]["episode_body"]


def test_las_credenciales_se_redactan_tambien_por_mcp(cfg, ledger, monkeypatch):
    """El texto sale de la maquina hacia un servidor remoto: la redaccion debe
    ocurrir antes, igual que en la via directa."""
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    _prep_doc(
        cfg,
        ledger,
        [{"chunk_idx": 0, "total_chunks": 1, "text": "el password: hunter2 del banco"}],
    )

    falso = _ClienteFalso()
    asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    cuerpo = falso.llamadas[0][1]["episode_body"]
    assert "hunter2" not in cuerpo
    assert "REDACTADA" in cuerpo


def test_falla_de_un_documento_no_detiene_el_lote(cfg, ledger, monkeypatch):
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    monkeypatch.setattr(graph_mod, "RETRY_BASE_DELAY", 0)
    _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "a"}], "/docs/a.pdf")
    _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "b"}], "/docs/b.pdf")

    falso = _ClienteFalso(
        fallar=lambda n: McpRemoteError("401 del servidor MCP") if n == 1 else None
    )
    counts = asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    assert counts["errors"] == 1
    assert counts["docs"] == 1


def test_parse_sse_extrae_los_json():
    cuerpo = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'
    assert list(_parse_sse(cuerpo)) == [{"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}]


def test_structured_content_no_se_pierde(monkeypatch):
    """FastMCP envuelve la salida en structuredContent; leer solo `content`
    hacia ver vacias respuestas perfectamente validas."""
    cli = ClienteMCP("https://ejemplo.cl", "tok")
    monkeypatch.setattr(
        cli, "_rpc", lambda *a, **k: {"content": [], "structuredContent": {"result": [1, 2]}}
    )
    assert json.loads(cli.llamar("x", {}))["result"] == [1, 2]


def test_error_de_herramienta_se_propaga(monkeypatch):
    cli = ClienteMCP("https://ejemplo.cl", "tok")
    monkeypatch.setattr(
        cli,
        "_rpc",
        lambda *a, **k: {"content": [{"type": "text", "text": "no autorizado"}], "isError": True},
    )
    with pytest.raises(McpRemoteError, match="no autorizado"):
        cli.llamar("add_memory", {})


def test_nombres_repetidos_no_se_confirman_al_azar(cfg, ledger, monkeypatch):
    """Dos documentos con el mismo nombre de episodio son inverificables.

    Asignar el uuid al azar dejaria el ledger apuntando al episodio equivocado,
    y `brain expire` borraria el de otro documento.
    """
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    monkeypatch.setenv("BRAIN_VERIFY_SECONDS", "0")
    a = _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "a"}], "/x/dup.pdf")
    b = _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "b"}], "/y/dup.pdf")

    falso = _ClienteFalso()
    asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    # Ninguno queda con un uuid inventado del otro.
    for doc in (a, b):
        for ep in ledger.episodes_for_doc(doc):
            assert not ep["episode_uuid"].startswith(graph_mod.PENDIENTE_PREFIJO)


def test_reintenta_los_504_pasajeros(cfg, ledger, monkeypatch):
    """Un 504 de Cloudflare no es culpa del documento: es el servidor saturado.

    Sin reintento, un solo 504 descartaba el documento completo — y con el
    servidor cargado son frecuentes.
    """
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    monkeypatch.setattr(graph_mod, "MCP_ESPERA_BASE", 0)
    monkeypatch.setenv("BRAIN_RITMO", "0")
    monkeypatch.setenv("BRAIN_VERIFY_SECONDS", "0")
    doc = _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}])

    falso = _ClienteFalso(
        fallar=lambda n: McpRemoteError("MCP tools/call: HTTP 504 Gateway time-out")
        if n <= 2
        else None
    )
    counts = asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    assert counts["errors"] == 0
    assert ledger.get(doc).status == "ingested"


def test_no_reintenta_un_error_real(cfg, ledger, monkeypatch):
    """Un 401 no se arregla repitiendolo: gastar 4 intentos solo retrasa el aviso."""
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda t: None)
    monkeypatch.setattr(graph_mod, "MCP_ESPERA_BASE", 0)
    monkeypatch.setenv("BRAIN_RITMO", "0")
    monkeypatch.setenv("BRAIN_VERIFY_SECONDS", "0")
    doc = _prep_doc(cfg, ledger, [{"chunk_idx": 0, "total_chunks": 1, "text": "hola"}])

    falso = _ClienteFalso(fallar=lambda n: McpRemoteError("401 del servidor MCP"))
    asyncio.run(ingest_chunks(cfg, ledger, remoto=falso))

    assert ledger.get(doc).status == "error"
    assert len([c for c in falso.llamadas if c[0] == "add_memory"]) == 1
