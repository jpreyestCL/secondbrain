"""Ledger idempotency and versioning."""


def test_new_file(ledger):
    outcome, doc_id = ledger.upsert_file("/a/doc.md", "aaa", 10, 1.0)
    assert outcome == "new"
    row = ledger.get(doc_id)
    assert row.status == "pending" and not row.superseded


def test_unchanged_is_idempotent(ledger):
    _, doc_id1 = ledger.upsert_file("/a/doc.md", "aaa", 10, 1.0)
    outcome, doc_id2 = ledger.upsert_file("/a/doc.md", "aaa", 10, 2.0)
    assert outcome == "unchanged"
    assert doc_id1 == doc_id2
    assert len(list(ledger.all_rows())) == 1


def test_changed_hash_creates_new_version(ledger):
    _, old_id = ledger.upsert_file("/a/doc.md", "aaa", 10, 1.0)
    ledger.record_episode("ep-1", old_id, 0, "personal")

    outcome, new_id = ledger.upsert_file("/a/doc.md", "bbb", 12, 2.0)
    assert outcome == "changed"
    assert new_id != old_id

    old = ledger.get(old_id)
    new = ledger.get(new_id)
    assert old.superseded is True
    assert new.superseded is False and new.status == "pending"

    # Old episodes flagged for expiry.
    pend = ledger.pending_expiry_episodes()
    assert [e["episode_uuid"] for e in pend] == ["ep-1"]

    ledger.mark_episode_expired("ep-1")
    assert ledger.pending_expiry_episodes() == []
    assert ledger.episodes_for_doc(old_id, only_active=True) == []


def test_status_transitions_and_classification(ledger):
    _, doc_id = ledger.upsert_file("/a/doc.md", "aaa", 10, 1.0)
    ledger.set_status(doc_id, "extracted")
    ledger.set_classification(doc_id, "finanzas", "factura", "2024-03-15", ["financial"])
    row = ledger.get(doc_id)
    assert row.status == "classified"
    assert row.domain == "finanzas"
    assert row.doc_date == "2024-03-15"
    assert row.sensitivity == ["financial"]

    ledger.add_sensitivity_flags(doc_id, ["rut", "financial"])
    assert ledger.get(doc_id).sensitivity == ["financial", "rut"]


def test_invalid_status_rejected(ledger):
    _, doc_id = ledger.upsert_file("/a/doc.md", "aaa", 10, 1.0)
    import pytest

    with pytest.raises(ValueError):
        ledger.set_status(doc_id, "bogus")
