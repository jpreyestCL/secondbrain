"""SQLite ledger tracking every document through the pipeline.

The ledger is versioned by content hash: each (path, sha256) pair is one row
with its own ``doc_id``. When a file changes on disk, the old row is marked
``superseded`` (its Graphiti episodes flagged ``pending_expiry``) and a fresh
row/doc_id is created, so history is never lost.

Statuses: pending -> extracted -> classified -> ingested, plus error/skipped.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

STATUSES = ("pending", "extracted", "classified", "ingested", "error", "skipped")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    doc_id      TEXT NOT NULL UNIQUE,
    size        INTEGER NOT NULL,
    mtime       REAL NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    domain      TEXT,
    doc_type    TEXT,
    doc_date    TEXT,
    sensitivity TEXT,
    error       TEXT,
    superseded  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (path, sha256)
);
CREATE INDEX IF NOT EXISTS idx_files_status ON files (status);
CREATE INDEX IF NOT EXISTS idx_files_path ON files (path);

CREATE TABLE IF NOT EXISTS episodes (
    episode_uuid   TEXT PRIMARY KEY,
    doc_id         TEXT NOT NULL,
    chunk_idx      INTEGER NOT NULL,
    group_id       TEXT,
    domain         TEXT,
    created_at     TEXT NOT NULL,
    pending_expiry INTEGER NOT NULL DEFAULT 0,
    expired        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_episodes_doc ON episodes (doc_id);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class FileRow:
    id: int
    path: str
    sha256: str
    doc_id: str
    size: int
    mtime: float
    status: str
    domain: str | None
    doc_type: str | None
    doc_date: str | None
    sensitivity: list[str]
    error: str | None
    superseded: bool
    created_at: str
    updated_at: str

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "FileRow":
        return cls(
            id=row["id"],
            path=row["path"],
            sha256=row["sha256"],
            doc_id=row["doc_id"],
            size=row["size"],
            mtime=row["mtime"],
            status=row["status"],
            domain=row["domain"],
            doc_type=row["doc_type"],
            doc_date=row["doc_date"],
            sensitivity=json.loads(row["sensitivity"]) if row["sensitivity"] else [],
            error=row["error"],
            superseded=bool(row["superseded"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class Ledger:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        # Autocommit mode: transactions are managed explicitly (upsert_file
        # uses BEGIN IMMEDIATE to serialize concurrent scans).
        self.conn = sqlite3.connect(db_path, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(_SCHEMA)
        # Migration: older databases lack episodes.domain (group_id used to
        # store the domain). Tolerate both layouts.
        try:
            self.conn.execute("ALTER TABLE episodes ADD COLUMN domain TEXT")
        except sqlite3.OperationalError:
            pass  # column already exists
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Ledger":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- scan / upsert -----------------------------------------------------

    def upsert_file(
        self, path: str, sha256: str, size: int, mtime: float
    ) -> tuple[str, str]:
        """Idempotent upsert of a scanned file.

        Returns ``(outcome, doc_id)`` where outcome is one of:

        * ``"unchanged"`` — same path+hash already known; nothing done.
        * ``"new"``       — first time this path is seen.
        * ``"changed"``   — path known with a different hash: old version row
          is marked superseded, its episodes flagged ``pending_expiry``, and
          a new version row (new doc_id, status=pending) is created. If the
          "new" hash matches a previously superseded row (a revert), that row
          is reactivated instead of inserting a duplicate.

        The whole SELECT+writes sequence runs inside BEGIN IMMEDIATE so
        concurrent scans serialize instead of racing.
        """
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            current = self.conn.execute(
                "SELECT * FROM files WHERE path = ? AND superseded = 0 "
                "ORDER BY id DESC LIMIT 1",
                (path,),
            ).fetchone()
            now = _now()
            if current is not None and current["sha256"] == sha256:
                if current["status"] == "error":
                    # File reappeared unchanged after an error: retry it.
                    self.conn.execute(
                        "UPDATE files SET status = 'pending', error = NULL,"
                        " updated_at = ? WHERE id = ?",
                        (now, current["id"]),
                    )
                self.conn.execute("COMMIT")
                return "unchanged", current["doc_id"]

            outcome = "new"
            if current is not None:
                outcome = "changed"
                self.conn.execute(
                    "UPDATE files SET superseded = 1, updated_at = ? WHERE id = ?",
                    (now, current["id"]),
                )
                self.conn.execute(
                    "UPDATE episodes SET pending_expiry = 1 "
                    "WHERE doc_id = ? AND expired = 0",
                    (current["doc_id"],),
                )

            old = self.conn.execute(
                "SELECT * FROM files WHERE path = ? AND sha256 = ?",
                (path, sha256),
            ).fetchone()
            if old is not None:
                # Revert to a previous version: reactivate the superseded row
                # (INSERT would violate UNIQUE(path, sha256)).
                doc_id = old["doc_id"]
                active = self.conn.execute(
                    "SELECT COUNT(*) AS n FROM episodes"
                    " WHERE doc_id = ? AND expired = 0",
                    (doc_id,),
                ).fetchone()["n"]
                status = (
                    "ingested"
                    if old["status"] == "ingested" and active
                    else "pending"
                )
                self.conn.execute(
                    "UPDATE files SET superseded = 0, status = ?, error = NULL,"
                    " size = ?, mtime = ?, updated_at = ? WHERE id = ?",
                    (status, size, mtime, now, old["id"]),
                )
                self.conn.execute(
                    "UPDATE episodes SET pending_expiry = 0"
                    " WHERE doc_id = ? AND expired = 0",
                    (doc_id,),
                )
            else:
                doc_id = str(uuid.uuid4())
                self.conn.execute(
                    "INSERT INTO files (path, sha256, doc_id, size, mtime, status,"
                    " created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
                    (path, sha256, doc_id, size, mtime, now, now),
                )
            self.conn.execute("COMMIT")
            return outcome, doc_id
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise

    # -- queries -----------------------------------------------------------

    def get(self, doc_id: str) -> FileRow | None:
        row = self.conn.execute(
            "SELECT * FROM files WHERE doc_id = ?", (doc_id,)
        ).fetchone()
        return FileRow.from_row(row) if row else None

    def by_status(self, status: str, include_superseded: bool = False) -> Iterator[FileRow]:
        q = "SELECT * FROM files WHERE status = ?"
        if not include_superseded:
            q += " AND superseded = 0"
        for row in self.conn.execute(q + " ORDER BY id", (status,)):
            yield FileRow.from_row(row)

    def all_rows(self) -> Iterator[FileRow]:
        for row in self.conn.execute("SELECT * FROM files ORDER BY id"):
            yield FileRow.from_row(row)

    def status_summary(self) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT status, superseded, COUNT(*) AS n, SUM(size) AS bytes "
            "FROM files GROUP BY status, superseded ORDER BY status"
        ).fetchall()

    # -- mutations ---------------------------------------------------------

    def set_status(self, doc_id: str, status: str, error: str | None = None) -> None:
        if status not in STATUSES:
            raise ValueError(f"invalid status {status!r}")
        self.conn.execute(
            "UPDATE files SET status = ?, error = ?, updated_at = ? WHERE doc_id = ?",
            (status, error, _now(), doc_id),
        )
        self.conn.commit()

    def set_classification(
        self,
        doc_id: str,
        domain: str | None,
        doc_type: str | None,
        doc_date: str | None,
        sensitivity: list[str] | None = None,
    ) -> None:
        self.conn.execute(
            "UPDATE files SET domain = ?, doc_type = ?, doc_date = ?,"
            " sensitivity = ?, status = 'classified', updated_at = ?"
            " WHERE doc_id = ?",
            (
                domain,
                doc_type,
                doc_date,
                json.dumps(sensitivity or []),
                _now(),
                doc_id,
            ),
        )
        self.conn.commit()

    def add_sensitivity_flags(self, doc_id: str, flags: list[str]) -> None:
        row = self.get(doc_id)
        if row is None:
            return
        merged = sorted(set(row.sensitivity) | set(flags))
        self.conn.execute(
            "UPDATE files SET sensitivity = ?, updated_at = ? WHERE doc_id = ?",
            (json.dumps(merged), _now(), doc_id),
        )
        self.conn.commit()

    # -- episodes ----------------------------------------------------------

    def record_episode(
        self,
        episode_uuid: str,
        doc_id: str,
        chunk_idx: int,
        group_id: str | None,
        domain: str | None = None,
    ) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO episodes"
            " (episode_uuid, doc_id, chunk_idx, group_id, domain, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (episode_uuid, doc_id, chunk_idx, group_id, domain, _now()),
        )
        self.conn.commit()

    def episodes_for_doc(self, doc_id: str, only_active: bool = True) -> list[sqlite3.Row]:
        q = "SELECT * FROM episodes WHERE doc_id = ?"
        if only_active:
            q += " AND expired = 0"
        return self.conn.execute(q + " ORDER BY chunk_idx", (doc_id,)).fetchall()

    def episodes_pendientes(self, prefijo: str) -> list[sqlite3.Row]:
        """Episodios enviados por MCP cuyo uuid real aun no se conoce.

        add_memory encola y responde de inmediato sin devolver el uuid, asi que
        se registran con un id provisional y se reconcilian al final del lote.
        """
        return self.conn.execute(
            "SELECT * FROM episodes WHERE episode_uuid LIKE ? AND expired = 0",
            (prefijo + "%",),
        ).fetchall()

    def actualizar_uuid_episodio(self, provisional: str, real: str) -> None:
        self.conn.execute(
            "UPDATE episodes SET episode_uuid = ? WHERE episode_uuid = ?",
            (real, provisional),
        )
        self.conn.commit()

    def borrar_episodio(self, episode_uuid: str) -> None:
        """Quita el registro para que un reintento vuelva a enviar ese chunk."""
        self.conn.execute("DELETE FROM episodes WHERE episode_uuid = ?", (episode_uuid,))
        self.conn.commit()

    def all_files(self) -> list[FileRow]:
        """Todas las filas vigentes (no superseded), para inspeccion."""
        filas = self.conn.execute(
            "SELECT * FROM files WHERE superseded = 0 ORDER BY path"
        ).fetchall()
        return [FileRow(**dict(f)) for f in filas]

    def rehacer(self, prefijo_ruta: str | None = None) -> dict[str, int]:
        """Olvida lo enviado al grafo para poder reingerir desde cero.

        Existe para no tener que tocar el ledger a mano. Hizo falta cuando el
        grafo se vacio del lado del servidor (por un cambio de ontologia o una
        limpieza): el ledger seguia diciendo "ingested" y `ingest-graph` se
        saltaba todo, asi que la unica salida era un DELETE a mano — justo lo
        que la regla 5 del proyecto prohibe.

        NO borra nada del grafo ni toca los archivos: solo el registro local de
        que ya se habian enviado.
        """
        cur = self.conn.cursor()
        if prefijo_ruta:
            patron = prefijo_ruta.rstrip("/") + "%"
            cur.execute(
                "DELETE FROM episodes WHERE doc_id IN"
                " (SELECT doc_id FROM files WHERE path LIKE ?)",
                (patron,),
            )
            episodios = cur.rowcount
            cur.execute(
                "UPDATE files SET status='classified', error=NULL"
                " WHERE status IN ('ingested','error') AND path LIKE ?",
                (patron,),
            )
        else:
            cur.execute("DELETE FROM episodes")
            episodios = cur.rowcount
            cur.execute(
                "UPDATE files SET status='classified', error=NULL"
                " WHERE status IN ('ingested','error')"
            )
        docs = cur.rowcount
        self.conn.commit()
        return {"documentos": max(docs, 0), "episodios": max(episodios, 0)}

    def pending_expiry_episodes(self) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM episodes WHERE pending_expiry = 1 AND expired = 0"
        ).fetchall()

    def docs_pending_expiry(self) -> list[str]:
        """doc_ids that still have active episodes flagged pending_expiry."""
        return [
            r["doc_id"]
            for r in self.conn.execute(
                "SELECT DISTINCT doc_id FROM episodes"
                " WHERE pending_expiry = 1 AND expired = 0 ORDER BY doc_id"
            )
        ]

    def mark_episode_expired(self, episode_uuid: str) -> None:
        self.conn.execute(
            "UPDATE episodes SET expired = 1, pending_expiry = 0"
            " WHERE episode_uuid = ?",
            (episode_uuid,),
        )
        self.conn.commit()
