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
