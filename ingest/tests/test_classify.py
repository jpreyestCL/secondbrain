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


def test_manifest_excerpt_is_redacted(cfg, ledger):
    """Fix 5: secrets never reach the manifest excerpt."""
    from brain_ingest.redact import REDACTED

    doc_id = _prep_doc(
        cfg, ledger, "/a/notas.md",
        "credenciales del servidor\npassword: hunter2\nresto del texto",
    )
    out = emit_manifest(cfg, ledger)
    [doc] = json.loads(out.read_text(encoding="utf-8"))["documents"]
    assert "hunter2" not in doc["excerpt"]
    assert REDACTED in doc["excerpt"]
    # The detection is also persisted as a sensitivity flag.
    assert "password" in ledger.get(doc_id).sensitivity


def test_apply_skips_docs_not_in_extracted_status(cfg, ledger):
    """Fix 6: applying a stale manifest must not re-open processed docs."""
    doc_id = _prep_doc(cfg, ledger)
    out = emit_manifest(cfg, ledger)
    data = json.loads(out.read_text(encoding="utf-8"))
    data["documents"][0]["domain"] = "finanzas"
    out.write_text(json.dumps(data), encoding="utf-8")

    # Doc moved on (already ingested) before the manifest was applied.
    ledger.set_classification(doc_id, "finanzas", "factura", None, [])
    ledger.set_status(doc_id, "ingested")

    counts = apply_manifest(cfg, ledger, out)
    assert counts == {"applied": 0, "skipped": 1, "errors": 0}
    assert ledger.get(doc_id).status == "ingested"  # untouched
