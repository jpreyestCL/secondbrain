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


def test_revert_to_previous_hash_reactivates_old_row(ledger):
    """Fix 1: a->b->a must not crash on UNIQUE(path, sha256); the old row is
    reactivated instead of re-inserted."""
    _, v1 = ledger.upsert_file("/a/doc.md", "aaa", 10, 1.0)
    ledger.set_status(v1, "ingested")
    ledger.record_episode("ep-1", v1, 0, "jpreyest", domain="personal")

    _, v2 = ledger.upsert_file("/a/doc.md", "bbb", 12, 2.0)
    assert ledger.get(v1).superseded
    assert ledger.docs_pending_expiry() == [v1]

    # Revert the file back to hash aaa: no IntegrityError, same doc_id back.
    outcome, v3 = ledger.upsert_file("/a/doc.md", "aaa", 10, 3.0)
    assert outcome == "changed"
    assert v3 == v1
    row = ledger.get(v1)
    assert row.superseded is False
    # Episodes are still live in the graph -> stays ingested, expiry unflagged.
    assert row.status == "ingested"
    assert v1 not in ledger.docs_pending_expiry()
    # The intermediate version is now the superseded one.
    assert ledger.get(v2).superseded is True
    assert len(list(ledger.all_rows())) == 2


def test_revert_without_live_episodes_resets_to_pending(ledger):
    _, v1 = ledger.upsert_file("/a/doc.md", "aaa", 10, 1.0)
    ledger.set_status(v1, "ingested")
    ledger.record_episode("ep-1", v1, 0, "jpreyest")
    _, v2 = ledger.upsert_file("/a/doc.md", "bbb", 12, 2.0)
    ledger.mark_episode_expired("ep-1")  # graph episodes were removed

    outcome, v3 = ledger.upsert_file("/a/doc.md", "aaa", 10, 3.0)
    assert v3 == v1
    row = ledger.get(v1)
    assert row.superseded is False
    assert row.status == "pending"  # must be re-ingested


def test_unchanged_error_doc_resets_to_pending(ledger):
    """Fix 9: an error doc rescanned unchanged retries (back to pending)."""
    _, doc_id = ledger.upsert_file("/a/doc.md", "aaa", 10, 1.0)
    ledger.set_status(doc_id, "error", error="boom")
    outcome, same = ledger.upsert_file("/a/doc.md", "aaa", 10, 2.0)
    assert outcome == "unchanged" and same == doc_id
    row = ledger.get(doc_id)
    assert row.status == "pending"
    assert row.error is None


def test_episode_domain_column_and_old_db_migration(tmp_path):
    """Fix 7: episodes carry a domain column; pre-migration DBs are tolerated."""
    import sqlite3

    from brain_ingest.ledger import Ledger

    db = tmp_path / "old.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE files (
            id INTEGER PRIMARY KEY, path TEXT NOT NULL, sha256 TEXT NOT NULL,
            doc_id TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mtime REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', domain TEXT, doc_type TEXT,
            doc_date TEXT, sensitivity TEXT, error TEXT,
            superseded INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE (path, sha256)
        );
        CREATE TABLE episodes (
            episode_uuid TEXT PRIMARY KEY, doc_id TEXT NOT NULL,
            chunk_idx INTEGER NOT NULL, group_id TEXT, created_at TEXT NOT NULL,
            pending_expiry INTEGER NOT NULL DEFAULT 0,
            expired INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO episodes (episode_uuid, doc_id, chunk_idx, group_id, created_at)
        VALUES ('old-ep', 'old-doc', 0, 'personal', '2025-01-01T00:00:00+00:00');
        """
    )
    conn.commit()
    conn.close()

    with Ledger(db) as lg:
        # Old row survives with domain=NULL.
        [old] = lg.episodes_for_doc("old-doc")
        assert old["group_id"] == "personal" and old["domain"] is None
        # New rows store tenant group_id + domain.
        lg.record_episode("new-ep", "d2", 0, "jpreyest", domain="salud")
        [new] = lg.episodes_for_doc("d2")
        assert new["group_id"] == "jpreyest" and new["domain"] == "salud"


def test_rehacer_devuelve_los_documentos_a_la_cola(ledger):
    """Reingerir no debe exigir un DELETE a mano sobre el ledger (regla 5).

    Hizo falta cuando el grafo se vacio del lado del servidor: el ledger seguia
    diciendo "ingested" y `ingest-graph` se saltaba todo.
    """
    _, a = ledger.upsert_file("/docs/uno.pdf", "sha-a", 10, 1e9)
    _, b = ledger.upsert_file("/otros/dos.pdf", "sha-b", 10, 1e9)
    for doc in (a, b):
        ledger.set_classification(doc, "finanzas", "factura", "2024-01-01", [])
        ledger.set_status(doc, "ingested")
        ledger.record_episode(f"uuid-{doc}", doc, 0, "jpreyest", domain="finanzas")

    n = ledger.rehacer("/docs")

    assert n["documentos"] == 1 and n["episodios"] == 1
    assert ledger.get(a).status == "classified"
    assert ledger.episodes_for_doc(a) == []
    # Lo de otra carpeta no se toca.
    assert ledger.get(b).status == "ingested"
    assert len(ledger.episodes_for_doc(b)) == 1


def test_rehacer_sin_ruta_alcanza_todo(ledger):
    _, a = ledger.upsert_file("/x/uno.pdf", "sha-a", 10, 1e9)
    ledger.set_classification(a, "personal", "nota", "2024-01-01", [])
    ledger.set_status(a, "error", error="el servidor no confirmó el episodio")

    ledger.rehacer()

    fila = ledger.get(a)
    assert fila.status == "classified" and not fila.error


def test_retirar_saca_de_la_cola_lo_ya_registrado(ledger):
    """--excluir no servia de nada si el archivo ya estaba en el ledger.

    Seguia pendiente de enviar, asi que excluir la carpeta no ahorraba ni
    tiempo ni dinero — que es justo para lo que se usa.
    """
    _, doc = ledger.upsert_file("/x/_Duplicados/copia.pdf", "sha", 10, 1e9)
    ledger.set_classification(doc, "finanzas", "contrato", "2024-01-01", [])

    assert ledger.retirar("/x/_Duplicados/copia.pdf") is True
    assert ledger.get(doc).status == "skipped"
    # Lo ya ingerido no se toca: eso se limpia en el grafo, no aqui.
    _, otro = ledger.upsert_file("/x/ok.pdf", "sha2", 10, 1e9)
    ledger.set_status(otro, "ingested")
    assert ledger.retirar("/x/ok.pdf") is False
