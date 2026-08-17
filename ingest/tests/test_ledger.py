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


# -- deduplicacion por CONTENIDO (no por ruta) --------------------------------


def test_el_mismo_contenido_en_otra_ruta_es_duplicado(ledger):
    """El ledger deduplicaba por (ruta, hash), asi que el mismo archivo en dos
    carpetas eran dos documentos, dos extracciones y dos ingestas.

    Medido en el corpus real: 18 contenidos con copias y 21 copias sobrantes —
    `(1).pdf` de descargas repetidas, una carpeta `Duplicados/`, y la misma
    factura archivada en dos sociedades.
    """
    r1, doc1 = ledger.upsert_file("/docs/contrato.pdf", "abc123", 10, 1.0)
    r2, doc2 = ledger.upsert_file("/otra/carpeta/contrato.pdf", "abc123", 10, 1.0)

    assert r1 == "new"
    assert r2 == "duplicate"
    assert doc1 != doc2, "cada ruta conserva su fila: saber donde mas esta archivado sirve"
    assert ledger.get(doc2).status == "duplicate"
    assert ledger.get(doc2).duplicate_of == doc1
    assert ledger.get(doc1).status == "pending", "el canonico sigue su curso normal"


def test_el_canonico_es_el_mejor_archivado_no_el_primero(ledger):
    """Si el canonico fuera el de `Duplicados/`, el grafo apuntaria justo a
    donde nadie va a buscar."""
    _, copia = ledger.upsert_file("/docs/Duplicados/escritura (2).pdf", "h1", 10, 1.0)
    _, bueno = ledger.upsert_file("/docs/Escrituras/escritura.pdf", "h1", 10, 1.0)

    assert ledger.get(bueno).status == "pending", "el bien archivado debe ser el canonico"
    assert ledger.get(copia).status == "duplicate"
    assert ledger.get(copia).duplicate_of == bueno


def test_el_sufijo_de_descarga_pierde_frente_al_original(ledger):
    _, uno = ledger.upsert_file("/d/SAFE - Endeavor (1).pdf", "h2", 10, 1.0)
    _, dos = ledger.upsert_file("/d/SAFE - Endeavor.pdf", "h2", 10, 1.0)

    assert ledger.get(dos).status == "pending"
    assert ledger.get(uno).status == "duplicate"


def test_una_tercera_copia_apunta_al_canonico_no_a_otra_copia(ledger):
    """Encadenar duplicados (A->B->C) hace que rastrear el original sea un
    paseo por punteros, y basta un eslabon roto para perderlo."""
    _, bueno = ledger.upsert_file("/d/doc.pdf", "h3", 10, 1.0)
    _, c1 = ledger.upsert_file("/d/doc (1).pdf", "h3", 10, 1.0)
    _, c2 = ledger.upsert_file("/d/doc (2).pdf", "h3", 10, 1.0)

    assert ledger.get(c1).duplicate_of == bueno
    assert ledger.get(c2).duplicate_of == bueno, "apunta al canonico, no a la otra copia"


def test_contenido_distinto_en_la_misma_ruta_sigue_siendo_una_version_nueva(ledger):
    """La deduplicacion no puede romper la supersesion."""
    r1, doc1 = ledger.upsert_file("/docs/x.pdf", "v1", 10, 1.0)
    r2, doc2 = ledger.upsert_file("/docs/x.pdf", "v2", 11, 2.0)

    assert (r1, r2) == ("new", "changed")
    assert ledger.get(doc1).superseded is True
    assert ledger.get(doc2).status == "pending"


# -- destino del episodio: "ingested" tiene que decir DONDE ------------------


def test_el_episodio_guarda_a_que_servidor_fue(ledger):
    """Sin esto, `ingested` no distingue el grafo local del de produccion.

    Paso lo peor que podia pasar: 339 documentos marcados como ingeridos vivian
    en el FalkorDB local de Docker y no en el servidor, que es el que se
    consulta desde Claude. No fallo nada — los datos estaban donde nadie los
    mira — y el ledger impedia reintentarlos porque los daba por hechos.
    """
    _, doc = ledger.upsert_file("/a/x.md", "h", 10, 1.0)
    ledger.record_episode("ep-1", doc, 0, "jpreyest", "personal",
                          destino="https://mybrain.rlz.cl/mcp")

    assert ledger.destinos() == {"https://mybrain.rlz.cl/mcp": 1}


def test_los_episodios_viejos_salen_como_sin_registrar(ledger):
    """Los de antes de la migracion no tienen destino: hay que poder verlo,
    no confundirlos con 'verificados'."""
    _, doc = ledger.upsert_file("/a/y.md", "h2", 10, 1.0)
    ledger.record_episode("ep-2", doc, 0, "jpreyest", "personal")

    assert ledger.destinos() == {"(sin registrar)": 1}


def test_desingerir_devuelve_a_la_cola_y_borra_los_episodios(ledger):
    """Dejarlos en `ingested` cuando no estan en el grafo que manda es peor que
    no haberlos ingerido: impide el reintento."""
    _, doc = ledger.upsert_file("/a/z.md", "h3", 10, 1.0)
    ledger.set_status(doc, "classified")
    ledger.record_episode("ep-3", doc, 0, "jpreyest", "personal", destino="local")
    ledger.set_status(doc, "ingested")

    n = ledger.desingerir([doc])

    assert n == 1
    assert ledger.get(doc).status == "classified"
    assert ledger.episodes_for_doc(doc) == [], "los episodios obsoletos deben desaparecer"


def test_desingerir_no_toca_lo_que_no_esta_ingerido(ledger):
    """Solo revierte lo que estaba dado por hecho; un documento en error o
    pendiente sigue su curso."""
    _, doc = ledger.upsert_file("/a/w.md", "h4", 10, 1.0)
    ledger.set_status(doc, "error", "algo fallo")

    ledger.desingerir([doc])

    assert ledger.get(doc).status == "error"
