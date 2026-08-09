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
