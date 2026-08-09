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
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(_SCHEMA)
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
          a new version row (new doc_id, status=pending) is created.
        """
        cur = self.conn.execute(
            "SELECT * FROM files WHERE path = ? AND superseded = 0 "
            "ORDER BY id DESC LIMIT 1",
            (path,),
        )
        current = cur.fetchone()
        if current is not None and current["sha256"] == sha256:
            return "unchanged", current["doc_id"]

        now = _now()
        doc_id = str(uuid.uuid4())
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
        self.conn.execute(
            "INSERT INTO files (path, sha256, doc_id, size, mtime, status,"
            " created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
            (path, sha256, doc_id, size, mtime, now, now),
        )
        self.conn.commit()
        return outcome, doc_id

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
        self, episode_uuid: str, doc_id: str, chunk_idx: int, group_id: str | None
    ) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO episodes"
            " (episode_uuid, doc_id, chunk_idx, group_id, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (episode_uuid, doc_id, chunk_idx, group_id, _now()),
        )
        self.conn.commit()

    def episodes_for_doc(self, doc_id: str, only_active: bool = True) -> list[sqlite3.Row]:
        q = "SELECT * FROM episodes WHERE doc_id = ?"
        if only_active:
            q += " AND expired = 0"
        return self.conn.execute(q + " ORDER BY chunk_idx", (doc_id,)).fetchall()

    def pending_expiry_episodes(self) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM episodes WHERE pending_expiry = 1 AND expired = 0"
        ).fetchall()

    def mark_episode_expired(self, episode_uuid: str) -> None:
        self.conn.execute(
            "UPDATE episodes SET expired = 1, pending_expiry = 0"
            " WHERE episode_uuid = ?",
            (episode_uuid,),
        )
        self.conn.commit()
