"""Classification via work manifests — no LLM API calls happen here.

``brain classify`` writes a manifest to ``~/.brain/work/classify-<batch>.json``
listing every extracted-but-unclassified document with an excerpt. A human or
Claude Code session fills in the classification fields, then
``brain classify --apply <file>`` writes the results back to the ledger.

Manifest JSON schema (schema_version 1)
---------------------------------------

Top level object::

    {
      "schema_version": 1,
      "batch": "20260809-151233",            // batch id (UTC timestamp)
      "created_at": "2026-08-09T15:12:33+00:00",
      "instructions": "...",                 // how to fill this file in
      "domains": ["personal", "salud", ...], // allowed values for `domain`
      "documents": [ <document>, ... ]
    }

Each ``<document>``::

    {
      "doc_id":  "uuid",                 // read-only, do not modify
      "path":    "/abs/source/path",     // read-only
      "excerpt": "first 2000 words...",  // read-only
      // Fields below start as null/[] and MUST be filled in:
      "domain":   "finanzas",            // one of top-level `domains`
      "doc_type": "factura",             // free-form short noun, lowercase
      "doc_date": "2024-03-15",          // ISO 8601 date (or datetime) the
                                         // document refers to; null if unknown
      "sensitivity_flags": ["medical"]   // list of strings; [] if none.
                                         // suggested: medical, financial,
                                         // legal, credentials, pii
    }

``--apply`` rules: unknown doc_ids are reported and skipped; a ``domain``
outside ``domains`` is a warning (still applied); an unparseable ``doc_date``
is an error for that document; documents with ``domain == null`` are left
untouched (still pending classification).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from .config import Config
from .ledger import Ledger

log = logging.getLogger("brain")

SCHEMA_VERSION = 1
EXCERPT_WORDS = 2000

INSTRUCTIONS = (
    "Fill in domain, doc_type, doc_date and sensitivity_flags for every "
    "document, based on its excerpt and path. domain must be one of the "
    "values in `domains`. doc_type is a short lowercase noun (e.g. contrato, "
    "factura, examen, nota). doc_date is the ISO date the document is about "
    "(issue date, exam date...), null if unknown. Do not modify doc_id, path "
    "or excerpt. Then run: brain classify --apply <this file>"
)


def _excerpt(text: str, max_words: int = EXCERPT_WORDS) -> str:
    words = text.split()
    return " ".join(words[:max_words])


def emit_manifest(cfg: Config, ledger: Ledger) -> Path | None:
    """Write a manifest for all extracted (unclassified) docs; return its path."""
    docs = []
    for row in ledger.by_status("extracted"):
        ext_path = cfg.extracted_dir / f"{row.doc_id}.txt"
        if not ext_path.exists():
            ext_path = cfg.extracted_dir / f"{row.doc_id}.json"
        if not ext_path.exists():
            log.warning("no extracted file for %s (%s)", row.doc_id, row.path)
            continue
        docs.append(
            {
                "doc_id": row.doc_id,
                "path": row.path,
                "excerpt": _excerpt(ext_path.read_text(encoding="utf-8", errors="replace")),
                "domain": None,
                "doc_type": None,
                "doc_date": None,
                "sensitivity_flags": [],
            }
        )
    if not docs:
        return None

    batch = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "batch": batch,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "instructions": INSTRUCTIONS,
        "domains": cfg.domains,
        "documents": docs,
    }
    out = cfg.work_dir / f"classify-{batch}.json"
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def apply_manifest(cfg: Config, ledger: Ledger, manifest_path: Path) -> dict[str, int]:
    """Apply a completed manifest; returns counters (applied/skipped/errors)."""
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(
            f"unsupported schema_version {data.get('schema_version')!r}"
        )

    counts = {"applied": 0, "skipped": 0, "errors": 0}
    for doc in data.get("documents", []):
        doc_id = doc.get("doc_id")
        row = ledger.get(doc_id) if doc_id else None
        if row is None:
            log.error("unknown doc_id %r — skipping", doc_id)
            counts["errors"] += 1
            continue
        domain = doc.get("domain")
        if domain is None:
            counts["skipped"] += 1
            continue
        if domain not in cfg.domains:
            log.warning("doc %s: domain %r not in configured domains", doc_id, domain)
        doc_date = doc.get("doc_date")
        if doc_date is not None:
            try:
                datetime.fromisoformat(str(doc_date))
            except ValueError:
                log.error("doc %s: invalid ISO doc_date %r — skipping", doc_id, doc_date)
                counts["errors"] += 1
                continue
        flags = doc.get("sensitivity_flags") or []
        if not isinstance(flags, list):
            log.error("doc %s: sensitivity_flags must be a list — skipping", doc_id)
            counts["errors"] += 1
            continue
        ledger.set_classification(
            doc_id,
            domain=domain,
            doc_type=doc.get("doc_type"),
            doc_date=str(doc_date) if doc_date is not None else None,
            sensitivity=[str(f) for f in flags],
        )
        counts["applied"] += 1
    return counts
