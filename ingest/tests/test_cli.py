import hashlib
from pathlib import Path

import pytest
"""End-to-end CLI: scan idempotency + extract dispatch through the ledger."""

from typer.testing import CliRunner

from brain_ingest.cli import app

runner = CliRunner()


def test_scan_extract_flow(brain_home, tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "nota.md").write_text("# Nota\n\nHola", encoding="utf-8")
    (docs / "script.py").write_text("print('x')", encoding="utf-8")

    r = runner.invoke(app, ["scan", str(docs)])
    assert r.exit_code == 0, r.output
    assert "2 new" in r.output

    # Rescan: idempotent.
    r = runner.invoke(app, ["scan", str(docs)])
    assert "0 new" in r.output and "2 unchanged" in r.output

    r = runner.invoke(app, ["extract"])
    assert r.exit_code == 0, r.output
    assert "1 extracted" in r.output and "1 skipped" in r.output

    # Modify the note -> new version detected.
    (docs / "nota.md").write_text("# Nota\n\nCambiada", encoding="utf-8")
    r = runner.invoke(app, ["scan", str(docs)])
    assert "1 changed" in r.output

    r = runner.invoke(app, ["status"])
    assert r.exit_code == 0, r.output


def test_chunk_writes_files(brain_home, tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "nota.md").write_text("# Nota\n\n" + "parrafo largo " * 50, encoding="utf-8")
    assert runner.invoke(app, ["scan", str(docs)]).exit_code == 0
    assert runner.invoke(app, ["extract"]).exit_code == 0
    r = runner.invoke(app, ["chunk"])
    assert r.exit_code == 0, r.output
    chunk_files = list((brain_home / "jpreyest" / "chunks").glob("*.json"))
    assert len(chunk_files) == 1


def test_chunk_json_extractions_produce_valid_json_chunks(brain_home, tmp_path):
    """Fix 4: csv/xlsx docs are chunked as standalone valid JSON."""
    import json

    docs = tmp_path / "docs"
    docs.mkdir()
    rows = "\n".join(f"2024-01-01,cliente-{i},{1000 + i}" for i in range(300))
    (docs / "ventas.csv").write_text("fecha,cliente,monto\n" + rows, encoding="utf-8")
    assert runner.invoke(app, ["scan", str(docs)]).exit_code == 0
    assert runner.invoke(app, ["extract"]).exit_code == 0
    r = runner.invoke(app, ["chunk"])
    assert r.exit_code == 0, r.output
    [chunk_file] = (brain_home / "jpreyest" / "chunks").glob("*.json")
    chunks = json.loads(chunk_file.read_text(encoding="utf-8"))
    assert len(chunks) > 1  # 300 rows are no longer one giant block
    for c in chunks:
        data = json.loads(c["text"])  # each chunk is valid standalone JSON
        assert data["sheet"] == "ventas"
        assert data["headers"] == ["fecha", "cliente", "monto"]
        assert data["rows"]


def test_scan_survives_file_vanishing_mid_walk(brain_home, tmp_path, monkeypatch):
    """Fix 9: an OSError on one file must not abort the whole scan."""
    import brain_ingest.cli as cli_mod

    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "estable.md").write_text("hola", encoding="utf-8")
    (docs / "fugaz.md").write_text("chao", encoding="utf-8")

    real = cli_mod.sha256_file

    def flaky(path):
        if path.name == "fugaz.md":
            raise FileNotFoundError(f"vanished: {path}")
        return real(path)

    monkeypatch.setattr(cli_mod, "sha256_file", flaky)
    r = runner.invoke(app, ["scan", str(docs)])
    assert r.exit_code == 0, r.output
    assert "1 new" in r.output  # the stable file was still processed


def test_status_lists_pending_expiry_docs_and_expire_all(brain_home, tmp_path, monkeypatch):
    """Improvement: status names the docs pending expiry; expire --all batches."""
    from brain_ingest.config import load_config
    from brain_ingest.ledger import Ledger
    import brain_ingest.graph as graph_mod

    cfg = load_config()
    with Ledger(cfg.ledger_path) as lg:
        _, old1 = lg.upsert_file("/a/uno.md", "aaa", 10, 1.0)
        lg.record_episode("ep-1", old1, 0, "jpreyest")
        _, old2 = lg.upsert_file("/a/dos.md", "ccc", 10, 1.0)
        lg.record_episode("ep-2", old2, 0, "jpreyest")
        lg.upsert_file("/a/uno.md", "bbb", 11, 2.0)  # supersede both
        lg.upsert_file("/a/dos.md", "ddd", 11, 2.0)

    r = runner.invoke(app, ["status"])
    assert r.exit_code == 0, r.output
    assert "pending expiry" in r.output
    assert old1 in r.output and old2 in r.output
    assert "--all" in r.output  # points at the batch mode

    class _FakeGraphiti:
        removed = []

        async def remove_episode(self, uuid):
            self.removed.append(uuid)

        async def close(self):
            pass

    fake = _FakeGraphiti()
    monkeypatch.setattr(graph_mod, "build_graphiti", lambda tenant: fake)

    # Exactly one of DOC_ID / --all is required.
    assert runner.invoke(app, ["expire"]).exit_code == 2

    r = runner.invoke(app, ["expire", "--all"])
    assert r.exit_code == 0, r.output
    assert sorted(fake.removed) == ["ep-1", "ep-2"]
    assert "2 episodes across 2 docs" in r.output

    with Ledger(cfg.ledger_path) as lg:
        assert lg.docs_pending_expiry() == []

    r = runner.invoke(app, ["expire", "--all"])
    assert "nothing to expire" in r.output


def test_tenant_flag_isolates_ledgers(brain_home, tmp_path):
    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "nota.md").write_text("# Nota\n\nHola", encoding="utf-8")

    r = runner.invoke(app, ["--tenant", "alice", "scan", str(docs)])
    assert r.exit_code == 0, r.output
    assert "1 new" in r.output

    # Bob sees an empty ledger: the same scan is "new" again for him.
    r = runner.invoke(app, ["--tenant", "bob", "scan", str(docs)])
    assert "1 new" in r.output

    assert (brain_home / "alice" / "ledger.sqlite").exists()
    assert (brain_home / "bob" / "ledger.sqlite").exists()


def test_add_sobre_carpeta_ya_ingerida_lo_dice(cfg, ledger, tmp_path, monkeypatch, capsys):
    """Un no-op silencioso se ve igual que un exito.

    `add` es idempotente a proposito: relanzarlo sobre inbox/ debe procesar
    solo lo nuevo, no repagar la extraccion de lo anterior ni duplicar
    episodios. Pero si no queda NADA por hacer tiene que decirlo y explicar
    cual es el comando que el usuario probablemente busca.
    """
    from typer.testing import CliRunner

    from brain_ingest.cli import app

    carpeta = tmp_path / "docs"
    carpeta.mkdir()
    (carpeta / "uno.md").write_text("contenido", encoding="utf-8")

    monkeypatch.setenv("BRAIN_HOME", str(cfg.home))
    runner = CliRunner()
    runner.invoke(app, ["--tenant", cfg.tenant, "scan", str(carpeta)])
    with ledger:
        for fila in ledger.all_files():
            ledger.set_status(fila.doc_id, "ingested")

    res = runner.invoke(app, ["--tenant", cfg.tenant, "add", str(carpeta)])
    assert "already in your memory" in res.stdout
    assert "--redo" in res.stdout


def test_reintenta_al_leer_un_archivo_que_baja_de_la_nube(tmp_path, monkeypatch):
    """El primer intento de leer un archivo de iCloud solo DISPARA la descarga.

    Sin reintento, `scan` lo descartaba con "vanished or unreadable" y el
    documento no llegaba nunca al grafo, sin dejar rastro de que faltaba.
    """
    from brain_ingest.cli import sha256_file

    p = tmp_path / "escritura.pdf"
    p.write_bytes(b"contenido real")
    intentos = {"n": 0}
    abrir_real = Path.open

    def abrir(self, *a, **k):
        if self == p:
            intentos["n"] += 1
            if intentos["n"] == 1:
                raise OSError(60, "Operation timed out")
        return abrir_real(self, *a, **k)

    monkeypatch.setattr(Path, "open", abrir)
    monkeypatch.setattr("brain_ingest.cli.time.sleep", lambda *_: None)

    assert sha256_file(p) == hashlib.sha256(b"contenido real").hexdigest()
    assert intentos["n"] == 2  # fallo el primero, acerto el segundo


def test_un_error_real_de_lectura_no_se_reintenta(tmp_path, monkeypatch):
    """Solo se reintentan los errores de descarga; un permiso denegado es real."""
    from brain_ingest.cli import sha256_file

    p = tmp_path / "x.pdf"
    p.write_bytes(b"x")

    def abrir(self, *a, **k):
        raise OSError(13, "Permission denied")

    monkeypatch.setattr(Path, "open", abrir)
    with pytest.raises(OSError) as exc:
        sha256_file(p)
    assert exc.value.errno == 13


def test_no_dice_que_esta_todo_si_algun_archivo_no_se_pudo_leer(
    cfg, ledger, tmp_path, monkeypatch
):
    """Con archivos atascados en iCloud, la carpeta NO está completa.

    El que falla no queda en el ledger, asi que el resto sale "todo ingerido" y
    `add` afirmaria que no falta nada — sobre documentos que no estan en ningun
    lado. Es la misma afirmacion falsa que el resto de la sesion.
    """
    from typer.testing import CliRunner

    from brain_ingest.cli import app

    carpeta = tmp_path / "docs"
    carpeta.mkdir()
    (carpeta / "bueno.md").write_text("contenido", encoding="utf-8")
    (carpeta / "en-la-nube.pdf").write_bytes(b"x" * 10)

    monkeypatch.setenv("BRAIN_HOME", str(cfg.home))
    monkeypatch.setattr("brain_ingest.cli.time.sleep", lambda *_: None)
    abrir_real = Path.open

    def abrir(self, *a, **k):
        if self.name == "en-la-nube.pdf":
            raise OSError(60, "Operation timed out")
        return abrir_real(self, *a, **k)

    monkeypatch.setattr(Path, "open", abrir)
    runner = CliRunner()
    runner.invoke(app, ["--tenant", cfg.tenant, "scan", str(carpeta)])
    with ledger:
        for fila in ledger.all_files():
            ledger.set_status(fila.doc_id, "ingested")

    res = runner.invoke(app, ["--tenant", cfg.tenant, "add", str(carpeta)])
    assert "NOT complete" in res.stdout
    assert "nothing new to send" not in res.stdout


def test_excluir_salta_carpetas_completas(cfg, tmp_path, monkeypatch):
    """Duplicados y borradores no deben entrar al grafo.

    Un borrador contradice a su version firmada y el grafo no tiene como saber
    cual manda; los duplicados inflan el costo sin aportar nada.
    """
    from typer.testing import CliRunner

    from brain_ingest.cli import app

    raiz = tmp_path / "Sociedades"
    (raiz / "Venta Final").mkdir(parents=True)
    (raiz / "Venta Final" / "_Duplicados").mkdir()
    (raiz / "oferta venta").mkdir()
    (raiz / "Venta Final" / "firmado.md").write_text("firmado", encoding="utf-8")
    (raiz / "Venta Final" / "_Duplicados" / "copia.md").write_text("copia", encoding="utf-8")
    (raiz / "oferta venta" / "borrador.md").write_text("borrador", encoding="utf-8")

    monkeypatch.setenv("BRAIN_HOME", str(cfg.home))
    res = CliRunner().invoke(
        app,
        ["--tenant", cfg.tenant, "scan", str(raiz),
         "--excluir", "_Duplicados", "--excluir", "oferta venta"],
    )
    assert "1 new" in res.stdout
    assert "2 file(s) skipped by --exclude" in res.stdout


def test_un_archivo_vacio_no_es_un_error(tmp_path):
    """0 bytes no es corrupcion: PyMuPDF decia "failed to open as type pdf"."""
    from brain_ingest.extract import SkipFile, extract_file

    p = tmp_path / "vacio.pdf"
    p.touch()
    with pytest.raises(SkipFile) as exc:
        extract_file(p)
    assert "empty" in str(exc.value)


# -- next-batch / mark-done: el camino rapido (Claude extrae, add_facts guarda) --


def _json_de(salida: str):
    """El JSON de la salida, ignorando lineas de log previas.

    La primera invocacion en un BRAIN_HOME nuevo imprime "created default
    config at ..." antes del JSON.
    """
    import json as _json

    return _json.loads(salida[salida.index("{") :])


def _preparar(tmp_path, n=3):
    """Deja n documentos en estado `classified`, listos para entregar."""
    import json as _json

    docs = tmp_path / "docs"
    docs.mkdir()
    for i in range(n):
        (docs / f"doc{i}.md").write_text(f"# Doc {i}\n\nContenido {i}", encoding="utf-8")
    runner.invoke(app, ["scan", str(docs)])
    runner.invoke(app, ["extract"])
    runner.invoke(app, ["classify", "--auto"])
    return docs


def test_next_batch_entrega_el_texto_ya_extraido(brain_home, tmp_path):
    """El punto entero: Claude lee el .txt, no el PDF.

    Sin OCR y sin volver a abrir el original, que es lo caro.
    """
    import json as _json

    _preparar(tmp_path, 3)

    r = runner.invoke(app, ["next-batch", "--limit", "2"])
    assert r.exit_code == 0, r.output
    datos = _json.loads(r.output)

    assert datos["entregados"] == 2
    assert datos["pendientes_totales"] == 3
    d = datos["documentos"][0]
    for campo in ("doc_id", "documento", "fecha_detectada", "dominio", "texto"):
        assert campo in d, f"falta {campo}"
    assert "Contenido" in d["texto"], "no llego el texto extraido"


def test_next_batch_no_marca_nada(brain_home, tmp_path):
    """Marcar al entregar perderia documentos cada vez que una tanda se corta,
    y un documento perdido es silencioso."""
    import json as _json

    _preparar(tmp_path, 2)

    runner.invoke(app, ["next-batch", "--limit", "2"])
    otra = _json_de(runner.invoke(app, ["next-batch", "--limit", "2"]).output)

    assert otra["entregados"] == 2, "la tanda no debe consumirse al entregarla"


def test_mark_done_saca_el_documento_de_la_cola(brain_home, tmp_path):
    import json as _json

    _preparar(tmp_path, 2)
    primera = _json_de(runner.invoke(app, ["next-batch", "--limit", "2"]).output)
    doc = primera["documentos"][0]

    r = runner.invoke(app, ["mark-done", doc["doc_id"], "--episode", "ep-uuid-1"])
    assert r.exit_code == 0, r.output

    despues = _json_de(runner.invoke(app, ["next-batch", "--limit", "5"]).output)
    ids = [d["doc_id"] for d in despues["documentos"]]
    assert doc["doc_id"] not in ids, "el documento marcado sigue en la cola"
    assert despues["pendientes_totales"] == 1


def test_mark_done_guarda_el_episodio_para_poder_rastrearlo(brain_home, tmp_path):
    import json as _json

    from brain_ingest.cli import _open

    _preparar(tmp_path, 1)
    doc = _json_de(runner.invoke(app, ["next-batch"]).output)["documentos"][0]

    runner.invoke(app, ["mark-done", doc["doc_id"], "--episode", "ep-abc"])

    _, ledger = _open()
    with ledger:
        episodios = ledger.episodes_for_doc(doc["doc_id"])
    assert [e["episode_uuid"] for e in episodios] == ["ep-abc"]


def test_mark_done_con_doc_id_inventado_falla(brain_home, tmp_path):
    """Fallar fuerte: un doc_id que no existe significa que quien llama perdio
    el hilo, y seguir en silencio deja el ledger mintiendo."""
    _preparar(tmp_path, 1)
    r = runner.invoke(app, ["mark-done", "no-existe", "--episode", "ep-x"])
    assert r.exit_code == 1


def test_next_batch_filtra_por_carpeta(brain_home, tmp_path):
    import json as _json

    _preparar(tmp_path, 2)
    otra = tmp_path / "otra"
    otra.mkdir()
    (otra / "z.md").write_text("# Z\n\notro", encoding="utf-8")
    runner.invoke(app, ["scan", str(otra)])
    runner.invoke(app, ["extract"])
    runner.invoke(app, ["classify", "--auto"])

    datos = _json.loads(
        runner.invoke(app, ["next-batch", "--folder", str(otra), "--limit", "10"]).output
    )
    assert datos["entregados"] == 1
    assert datos["documentos"][0]["documento"] == "z.md"


def test_el_texto_se_trunca_y_se_avisa(brain_home, tmp_path):
    """Un documento enorme no puede reventar el contexto sin avisar."""
    import json as _json

    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "largo.md").write_text("# L\n\n" + ("palabra " * 50000), encoding="utf-8")
    runner.invoke(app, ["scan", str(docs)])
    runner.invoke(app, ["extract"])
    runner.invoke(app, ["classify", "--auto"])

    d = _json_de(runner.invoke(app, ["next-batch", "--max-chars", "500"]).output)["documentos"][0]
    assert len(d["texto"]) == 500
    assert d["truncado"] is True


def test_una_carpeta_sin_escanear_avisa_en_vez_de_parecer_terminada(brain_home, tmp_path):
    """El fallo silencioso mas facil de cometer.

    Sin `brain add --review` previo, una carpeta nunca escaneada devolvia
    exactamente lo mismo que una ya terminada: `entregados: 0, pendientes: 0`.
    Quien llame reporta "no queda nada pendiente" habiendo ingerido CERO.
    """
    import json as _json

    nueva = tmp_path / "sin-escanear"
    nueva.mkdir()
    (nueva / "x.md").write_text("# X", encoding="utf-8")

    datos = _json_de(runner.invoke(app, ["next-batch", "--folder", str(nueva)]).output)

    assert datos["pendientes_totales"] == 0
    assert "aviso" in datos, "0 pendientes sin aviso es indistinguible de 'ya esta todo'"
    assert "--review" in datos["aviso"], "el aviso debe decir COMO arreglarlo"


def test_una_carpeta_ya_terminada_no_avisa(brain_home, tmp_path):
    """El aviso solo debe salir cuando de verdad falta preparar."""
    import json as _json

    _preparar(tmp_path, 1)
    doc = _json_de(runner.invoke(app, ["next-batch"]).output)["documentos"][0]
    runner.invoke(app, ["mark-done", doc["doc_id"], "--episode", "ep-1"])

    datos = _json_de(runner.invoke(app, ["next-batch", "--folder", str(tmp_path / "docs")]).output)

    assert datos["pendientes_totales"] == 0
    assert "aviso" not in datos
    assert datos["resumen_ledger"] == {"ingested": 1}, "el resumen explica el cero"


# -- reconcile: el ledger dice error pero el grafo tiene el contenido ----------


class _ClienteFalso:
    """Devuelve lo que get_episodes devolveria, ya envuelto como el real."""

    def __init__(self, episodios):
        self._episodios = episodios
        self.llamadas = []

    def llamar(self, nombre, argumentos, timeout=None):
        import json as _json

        self.llamadas.append((nombre, argumentos))
        return _json.dumps({"result": {"episodes": self._episodios}})


def _ep(doc_id, idx, total, uuid=None):
    """Un episodio del camino lento, con su procedencia y su numeracion."""
    return {
        "uuid": uuid or f"ep-{doc_id}-{idx}",
        "name": f"[personal] documento.pdf [{idx}/{total}]",
        "source_description": f"dominio: personal | tipo: documento | origen: /x/y.pdf (doc_id={doc_id})",
    }


D1 = "11111111-1111-1111-1111-111111111111"
D2 = "22222222-2222-2222-2222-222222222222"


def test_episodios_por_doc_agrupa_y_sabe_cuantos_faltan():
    from brain_ingest.mcp_remote import episodios_por_doc

    cliente = _ClienteFalso([_ep(D1, 1, 3), _ep(D1, 2, 3), _ep(D2, 1, 1)])

    r = episodios_por_doc(cliente)

    assert r[D1]["total"] == 3
    assert len(r[D1]["episodios"]) == 2, "solo llegaron 2 de los 3 trozos"
    assert r[D2]["total"] == 1 and len(r[D2]["episodios"]) == 1


def test_episodios_de_add_facts_no_entran():
    """No llevan doc_id: el documento entero es UN episodio y ya se marco."""
    from brain_ingest.mcp_remote import episodios_por_doc

    cliente = _ClienteFalso(
        [
            {
                "uuid": "ep-facts",
                "name": "[personal] cedula.png",
                "source_description": "dominio: personal | tipo: cedula | sensibilidad: pii",
            }
        ]
    )

    assert episodios_por_doc(cliente) == {}


def _ledger_con(tmp_path, n=1, status="error"):
    """Deja n filas en el ledger en estado `status`. Devuelve sus doc_id.

    `upsert_file` genera el doc_id, asi que las pruebas construyen los
    episodios falsos a partir de lo que devuelve, no al reves.
    """
    from brain_ingest.config import load_config
    from brain_ingest.ledger import Ledger

    docs = tmp_path / "docs"
    docs.mkdir(exist_ok=True)
    cfg = load_config()
    ruta = cfg.home / "config.toml"
    ruta.write_text(
        ruta.read_text(encoding="utf-8") + '\nmcp_url = "https://ejemplo.test/mcp"\n',
        encoding="utf-8",
    )
    ids = []
    lg = Ledger(cfg.ledger_path)
    with lg:
        for i in range(n):
            p = docs / f"doc{i}.pdf"
            p.write_text(f"x{i}", encoding="utf-8")
            _, doc_id = lg.upsert_file(path=str(p), sha256=f"sha{i}", size=2, mtime=0.0)
            lg.set_status(doc_id, status, "el servidor no confirmó el episodio")
            ids.append(doc_id)
    return ids


def _estado(doc_id):
    from brain_ingest.config import load_config
    from brain_ingest.ledger import Ledger

    lg = Ledger(load_config().ledger_path)
    with lg:
        return lg.get(doc_id).status, lg.episodes_for_doc(doc_id)


def _parchar(monkeypatch, episodios):
    import brain_ingest.mcp_remote as mr

    monkeypatch.setattr(mr, "conectar", lambda *a, **k: _ClienteFalso(episodios))


def test_reconcile_marca_los_completos(brain_home, tmp_path, monkeypatch):
    (d,) = _ledger_con(tmp_path)
    _parchar(monkeypatch, [_ep(d, 1, 2), _ep(d, 2, 2)])

    r = runner.invoke(app, ["reconcile", "--apply"])

    assert r.exit_code == 0, r.output
    estado, episodios = _estado(d)
    assert estado == "ingested"
    assert len(episodios) == 2, "deben quedar los DOS episodios, no uno"


def test_reconcile_NO_toca_los_parciales(brain_home, tmp_path, monkeypatch):
    """El caso peligroso: registrar 1 de 88 dejaria que `expire` huerfane 87."""
    (d,) = _ledger_con(tmp_path)
    _parchar(monkeypatch, [_ep(d, 1, 88)])

    r = runner.invoke(app, ["reconcile", "--apply"])

    assert r.exit_code == 0, r.output
    assert "INCOMPLETE" in r.output
    estado, episodios = _estado(d)
    assert estado == "error", "no debe marcarse ingested"
    assert episodios == [], "no debe registrar episodios sueltos"


def test_reconcile_sin_apply_no_escribe(brain_home, tmp_path, monkeypatch):
    (d,) = _ledger_con(tmp_path)
    _parchar(monkeypatch, [_ep(d, 1, 1)])

    r = runner.invoke(app, ["reconcile"])

    assert r.exit_code == 0, r.output
    assert "--apply" in r.output
    assert _estado(d)[0] == "error"


def test_reconcile_delata_los_que_de_verdad_faltan(brain_home, tmp_path, monkeypatch):
    """Sin episodios en el grafo, el error NO es falso: hay que reingerir."""
    (d,) = _ledger_con(tmp_path)
    _parchar(monkeypatch, [])

    r = runner.invoke(app, ["reconcile", "--apply"])

    assert r.exit_code == 0, r.output
    assert "not in the graph at all" in r.output
    assert "--redo" in r.output, "debe decir COMO arreglarlo"


def test_reconcile_no_pide_reingerir_lo_que_se_salto_a_proposito(
    brain_home, tmp_path, monkeypatch
):
    """Un `skipped` sin episodios es lo esperado, no una anomalia.

    Mezclarlo con los fallidos haria que el informe pidiera reingerir fotos y
    binarios que nunca debieron entrar.
    """
    (d,) = _ledger_con(tmp_path, status="skipped")
    _parchar(monkeypatch, [])

    r = runner.invoke(app, ["reconcile", "--apply"])

    assert r.exit_code == 0, r.output
    assert "expected, nothing to do" in r.output
    assert "DO need re-ingesting" not in r.output
    assert _estado(d)[0] == "skipped"
