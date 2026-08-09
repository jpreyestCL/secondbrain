import json

from brain_ingest.classify import apply_manifest, emit_manifest


def _prep_doc(cfg, ledger, path="/a/factura.md", text="Factura electronica marzo"):
    _, doc_id = ledger.upsert_file(path, "sha-" + path, 10, 1.0)
    (cfg.extracted_dir / f"{doc_id}.txt").write_text(text, encoding="utf-8")
    ledger.set_status(doc_id, "extracted")
    return doc_id


def test_emit_and_apply_roundtrip(cfg, ledger):
    doc_id = _prep_doc(cfg, ledger)
    out = emit_manifest(cfg, ledger)
    assert out is not None and out.name.startswith("classify-")

    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["schema_version"] == 1
    assert data["domains"] == cfg.domains
    [doc] = data["documents"]
    assert doc["doc_id"] == doc_id
    assert "Factura" in doc["excerpt"]
    assert doc["domain"] is None

    # Simulate Claude Code filling it in.
    doc["domain"] = "finanzas"
    doc["doc_type"] = "factura"
    doc["doc_date"] = "2024-03-15"
    doc["sensitivity_flags"] = ["financial"]
    out.write_text(json.dumps(data), encoding="utf-8")

    counts = apply_manifest(cfg, ledger, out)
    assert counts == {"applied": 1, "skipped": 0, "errors": 0}
    row = ledger.get(doc_id)
    assert row.status == "classified"
    assert (row.domain, row.doc_type, row.doc_date) == ("finanzas", "factura", "2024-03-15")
    assert row.sensitivity == ["financial"]


def test_apply_skips_unfilled_and_bad_dates(cfg, ledger):
    d1 = _prep_doc(cfg, ledger, "/a/uno.md")
    d2 = _prep_doc(cfg, ledger, "/a/dos.md")
    out = emit_manifest(cfg, ledger)
    data = json.loads(out.read_text(encoding="utf-8"))
    by_id = {d["doc_id"]: d for d in data["documents"]}
    by_id[d1]["domain"] = "personal"
    by_id[d1]["doc_date"] = "no-es-fecha"
    # d2 left unfilled
    out.write_text(json.dumps(data), encoding="utf-8")

    counts = apply_manifest(cfg, ledger, out)
    assert counts == {"applied": 0, "skipped": 1, "errors": 1}
    assert ledger.get(d1).status == "extracted"
    assert ledger.get(d2).status == "extracted"


def test_emit_none_when_nothing_extracted(cfg, ledger):
    assert emit_manifest(cfg, ledger) is None
