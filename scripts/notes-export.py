#!/usr/bin/env python3
"""Export Apple Notes to Markdown files, one per note, with YAML front-matter.

Reads ``~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite``
**without ever writing to it**: the database (plus its ``-wal`` / ``-shm``
sidecars) is copied to a temporary directory and every query runs against the
copy. ``--no-copy`` opens the original with ``mode=ro&immutable=1`` instead
(faster, but ignores a pending WAL, so very recent edits may be missing).

Note bodies live in ``ZICNOTEDATA.ZDATA`` as a **gzipped protobuf**, not plain
text. Decompressing and decoding as UTF-8 works but interleaves the protobuf
framing with the prose (``( ( ( " L8U$K[O+`` and friends). This script walks
the protobuf properly. Empirically verified layout (macOS Notes, proto "1.5"):

    NoteStoreProto { Document document = 2; }
    Document       { ...; Note note = 3; }
    Note           { string note_text = 2;      <- the clean UTF-16-ish body
                     CRDT/merge metadata  = 3;  <- ignored
                     ...                  = 4;  <- ignored
                     repeated AttributeRun = 5; }
    AttributeRun   { uint32 length = 1; ParagraphStyle paragraph_style = 2; }
    ParagraphStyle { uint32 style_type = 1; uint32 indent = 3;
                     Checklist checklist = 5; }
    Checklist      { bytes uuid = 1; uint32 done = 2; }

The attribute runs are used only to restore headings / bullets / checkboxes as
Markdown (``--plain`` skips that and emits the raw text).

Metadata comes from ``ZICCLOUDSYNCINGOBJECT``. NOTE: on this schema the
populated creation-date column is ``ZCREATIONDATE3`` (``ZCREATIONDATE1`` is
NULL for every row); modification is ``ZMODIFICATIONDATE1``. Both are Apple
epoch (seconds since 2001-01-01), converted with ``+978307200``.

The ``created`` date in the front-matter is what later becomes Graphiti's
``reference_time`` -- see rule #1 in CLAUDE.md -- so it must be the note's real
creation date, never today.

ATTACHMENTS. Notes whose real content is a photo, a scan or a table used to
export as (almost) empty: the body only holds the title plus U+FFFC object
placeholders. ``notes-attachments.py`` recovers them -- it resolves every
attachment to its file, copies it to ``<out>/adjuntos/<note_id>/``, OCRs images
and PDFs with Apple Vision (``ocrmac``) and decodes Apple tables to Markdown.
The recovered text is appended to the note under
``## Texto reconocido de adjuntos`` / ``## Tablas de la nota`` and the copies
are listed in the ``attachments`` front-matter key. OCR is cached by file hash
in ``<out>/.adjuntos-cache.json``, so re-running is idempotent and resumable.

Standard library only (the OCR runs in a subprocess using the ``ingest`` venv).
Usage:

    scripts/notes-export.py --out /tmp/notas-export
    scripts/notes-export.py --out /tmp/notas-export --since 2024-01-01
    scripts/notes-export.py --out /tmp/notas-export --no-ocr
    scripts/notes-export.py --only-note 48B29DD3-E390-48EE-B67C-AA7FD625353F
    scripts/notes-export.py --dry-run
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import importlib.util
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import unicodedata


def _load_attachments_module():
    """Import the sibling ``notes-attachments.py`` (a dash is not importable)."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "notes-attachments.py")
    if not os.path.exists(path):
        return None
    spec = importlib.util.spec_from_file_location("notes_attachments", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


attachments_mod = _load_attachments_module()

DEFAULT_DB = os.path.expanduser(
    "~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
)

APPLE_EPOCH_OFFSET = 978307200  # 2001-01-01T00:00:00Z in unix seconds

OBJECT_REPLACEMENT = "￼"  # placeholder Apple uses for inline attachments

# ParagraphStyle.style_type -> markdown prefix rendered at the start of the line
STYLE_PREFIX = {
    0: "# ",  # title
    1: "## ",  # heading
    2: "### ",  # subheading
    100: "- ",  # dotted list
    101: "- ",  # dashed list
    102: "1. ",  # numbered list
    103: "- [ ] ",  # checkbox (overridden to "- [x] " when done)
}


# --------------------------------------------------------------------------
# minimal protobuf reader (wire format only, no schema compilation needed)
# --------------------------------------------------------------------------


def _read_varint(buf, i):
    result = 0
    shift = 0
    n = len(buf)
    while i < n:
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, i
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")
    raise ValueError("truncated varint")


def parse_fields(buf):
    """Return [(field_number, wire_type, value)] for one protobuf message."""
    out = []
    i = 0
    n = len(buf)
    while i < n:
        try:
            key, i = _read_varint(buf, i)
        except ValueError:
            break
        field, wire = key >> 3, key & 7
        if wire == 0:  # varint
            try:
                value, i = _read_varint(buf, i)
            except ValueError:
                break
            out.append((field, 0, value))
        elif wire == 2:  # length-delimited
            try:
                length, i = _read_varint(buf, i)
            except ValueError:
                break
            if length < 0 or i + length > n:
                break
            out.append((field, 2, buf[i : i + length]))
            i += length
        elif wire == 5:  # fixed32
            out.append((field, 5, buf[i : i + 4]))
            i += 4
        elif wire == 1:  # fixed64
            out.append((field, 1, buf[i : i + 8]))
            i += 8
        else:  # groups (3/4) are obsolete and never appear here
            break
    return out


def _sub(fields, number, wire=2):
    return [v for f, w, v in fields if f == number and w == wire]


def _first(fields, number, wire, default=None):
    for f, w, v in fields:
        if f == number and w == wire:
            return v
    return default


# --------------------------------------------------------------------------
# note body decoding
# --------------------------------------------------------------------------


class DecodeError(Exception):
    pass


def decode_note_blob(blob, plain=False):
    """gzipped protobuf blob -> clean text. Raises DecodeError on bad input."""
    try:
        raw = gzip.decompress(blob)
    except Exception as exc:  # password-protected notes are AES, not gzip
        raise DecodeError("not gzip (encrypted or unknown format): %s" % exc)

    document = _sub(parse_fields(raw), 2)
    if not document:
        raise DecodeError("no Document (field 2)")
    note = _sub(parse_fields(document[0]), 3)
    if not note:
        raise DecodeError("no Note (field 3)")
    note_fields = parse_fields(note[0])

    text_bytes = _first(note_fields, 2, 2)
    if text_bytes is None:
        return ""
    text = text_bytes.decode("utf-8", "replace")

    if plain:
        return clean_text(text)
    return clean_text(apply_styles(text, _sub(note_fields, 5)))


def apply_styles(text, runs):
    """Re-apply paragraph styles (headings, bullets, checkboxes) as Markdown."""
    if not runs:
        return text

    # Map each character offset to the paragraph style covering it.
    styles = [None] * len(text)
    pos = 0
    for run in runs:
        rf = parse_fields(run)
        length = _first(rf, 1, 0, 0)
        if length <= 0:
            continue
        pstyle = _first(rf, 2, 2)
        info = None
        if pstyle is not None:
            pf = parse_fields(pstyle)
            style_type = _first(pf, 1, 0)
            indent = _first(pf, 3, 0, 0) or 0
            checklist = _first(pf, 5, 2)
            done = 0
            if checklist is not None:
                done = _first(parse_fields(checklist), 2, 0, 0) or 0
            if style_type is not None:
                info = (style_type, indent, done)
        end = min(pos + length, len(text))
        if info is not None:
            for k in range(pos, end):
                styles[k] = info
        pos += length
        if pos >= len(text):
            break

    # Offsets are tracked on the ORIGINAL text, so prefixes never shift them.
    lines = []
    offset = 0
    for line in text.split("\n"):
        info = styles[offset] if offset < len(styles) else None
        stripped = line.strip()
        out = line
        if info is not None and stripped:
            style_type, indent, done = info
            prefix = STYLE_PREFIX.get(style_type)
            if prefix == "- [ ] " and done:
                prefix = "- [x] "
            if prefix:
                out = ("    " * min(indent, 6)) + prefix + stripped
        lines.append(out)
        offset += len(line) + 1
    return "\n".join(lines)


_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_BLANKS = re.compile(r"\n{3,}")


def clean_text(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace(OBJECT_REPLACEMENT, "")  # inline attachments
    text = text.replace("\u2028", "\n").replace("\u2029", "\n")  # LS / PS
    text = _CTRL.sub("", text)
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    text = _BLANKS.sub("\n\n", text)
    return text.strip()


# --------------------------------------------------------------------------
# database access (never touches the original file)
# --------------------------------------------------------------------------


def open_notes_db(db_path, copy=True):
    """Return (connection, tempdir_or_None). The original DB is never written."""
    if not os.path.exists(db_path):
        raise SystemExit("Notes database not found: %s" % db_path)
    if not copy:
        uri = "file:%s?mode=ro&immutable=1" % db_path.replace("?", "%3f").replace(
            " ", "%20"
        )
        return sqlite3.connect(uri, uri=True), None

    tmpdir = tempfile.mkdtemp(prefix="notes-export-")
    target = os.path.join(tmpdir, "NoteStore.sqlite")
    shutil.copy2(db_path, target)
    for suffix in ("-wal", "-shm"):
        side = db_path + suffix
        if os.path.exists(side):
            try:
                shutil.copy2(side, target + suffix)
            except OSError:
                pass
    # Opened read-write on the COPY so SQLite can replay the WAL; the original
    # is untouched.
    return sqlite3.connect(target), tmpdir


QUERY = """
SELECT  o.Z_PK              AS pk,
        o.ZIDENTIFIER       AS uuid,
        o.ZTITLE1           AS title,
        o.ZCREATIONDATE3    AS created,
        o.ZMODIFICATIONDATE1 AS modified,
        f.ZTITLE2           AS folder,
        o.ZISPASSWORDPROTECTED AS locked,
        d.ZDATA             AS data
FROM    ZICNOTEDATA d
JOIN    ZICCLOUDSYNCINGOBJECT o ON o.Z_PK = d.ZNOTE
LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = o.ZFOLDER
WHERE   d.ZDATA IS NOT NULL
  AND   COALESCE(o.ZMARKEDFORDELETION, 0) = 0
ORDER BY COALESCE(o.ZCREATIONDATE3, 0), o.Z_PK
"""


def apple_time(value):
    if value is None:
        return None
    return dt.datetime.utcfromtimestamp(value + APPLE_EPOCH_OFFSET)


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


def slugify(text, max_len=48):
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = _SLUG_STRIP.sub("-", text.lower()).strip("-")
    if len(text) > max_len:
        text = text[:max_len].rsplit("-", 1)[0] or text[:max_len]
    return text or "sin-titulo"


def yaml_quote(value):
    if value is None:
        return '""'
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def front_matter(meta):
    lines = ["---"]
    for key in ("title", "created", "modified", "folder", "source", "note_id"):
        lines.append("%s: %s" % (key, yaml_quote(meta.get(key))))
    # Attachments are always emitted (even empty) so downstream tools can rely
    # on the key existing. Flow style keeps the front-matter one line per key.
    files = meta.get("attachments") or []
    lines.append("attachments: [%s]" % ", ".join(yaml_quote(f) for f in files))
    lines.append("attachments_text_chars: %d" % int(meta.get("attachments_text_chars") or 0))
    lines.append("---")
    return "\n".join(lines)


def export(args):
    use_attachments = attachments_mod is not None and not args.no_attachments
    conn, tmpdir = open_notes_db(args.db, copy=not args.no_copy)
    attachments_by_note = {}
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(QUERY).fetchall()
        if args.only_note:
            rows = [
                r for r in rows
                if r["uuid"] == args.only_note or str(r["pk"]) == str(args.only_note)
            ]
            if not rows:
                raise SystemExit("--only-note: no hay nota con id %r" % args.only_note)
        if use_attachments:
            wanted = set(r["pk"] for r in rows)
            attachments_by_note = {
                pk: items
                for pk, items in attachments_mod.load(conn).items()
                if pk in wanted
            }
    finally:
        conn.close()
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)

    stats = attachments_mod.Stats() if use_attachments else None
    cache = None
    runner = None
    ocr_seconds = 0.0
    if use_attachments and not args.dry_run:
        cache = attachments_mod.Cache(os.path.join(args.out, attachments_mod.CACHE_NAME))
        if not args.no_ocr:
            python = attachments_mod.find_ocr_python()
            if python is None:
                print(
                    "aviso: no encuentro un python con 'ocrmac'; se exporta sin OCR "
                    "(usa --no-ocr para silenciar este aviso)",
                    file=sys.stderr,
                )
            else:
                runner = attachments_mod.OcrRunner(python, args.ocr_languages.split(","))

    since = None
    if args.since:
        try:
            since = dt.datetime.strptime(args.since, "%Y-%m-%d")
        except ValueError:
            raise SystemExit("--since must be YYYY-MM-DD, got %r" % args.since)

    if not args.dry_run:
        os.makedirs(args.out, exist_ok=True)

    written = 0
    skipped_empty = 0
    skipped_locked = 0
    failed = []
    skipped_since = 0
    used_names = set()
    kept_note_ids = set()
    dates = []
    index = 0

    for row in rows:
        created = apple_time(row["created"])
        modified = apple_time(row["modified"])
        if since is not None and created is not None and created < since:
            skipped_since += 1
            continue

        try:
            body = decode_note_blob(row["data"], plain=args.plain)
        except DecodeError as exc:
            if row["locked"]:
                skipped_locked += 1
            else:
                failed.append((row["pk"], row["title"], str(exc)))
            continue

        extra = ""
        att_files = []
        note_attachments = attachments_by_note.get(row["pk"]) or []
        if use_attachments and note_attachments and not args.dry_run:
            started = time.time()
            extra, att_files = attachments_mod.process_note(
                note_attachments,
                row["uuid"] or ("pk-%s" % row["pk"]),
                args.out,
                cache,
                runner,
                stats,
                copy=not args.no_copy_attachments,
            )
            ocr_seconds += time.time() - started
            cache.save()

        # A note whose only content is a photo has an empty body but real text
        # once the attachment is recovered: it must NOT be skipped as empty.
        # Even when OCR finds nothing (a photo of a place, a drawing), the note
        # is kept as long as it has files: the image itself is the content and
        # it is already sitting in <out>/adjuntos/<note_id>/.
        if not body.strip() and not extra.strip() and not att_files:
            skipped_empty += 1
            if not args.keep_empty:
                continue

        index += 1
        title = (row["title"] or "").strip() or "sin titulo"
        base = "%04d-%s" % (index, slugify(title))
        name = base
        n = 2
        while name in used_names:
            name = "%s-%d" % (base, n)
            n += 1
        used_names.add(name)
        kept_note_ids.add(row["uuid"] or ("pk-%s" % row["pk"]))

        meta = {
            "title": title,
            "created": created.isoformat() if created else "",
            "modified": modified.isoformat() if modified else "",
            "folder": row["folder"] or "",
            "source": "apple-notes",
            "note_id": row["uuid"] or ("pk-%s" % row["pk"]),
            "attachments": att_files,
            "attachments_text_chars": len(extra.strip()),
        }
        parts = [p for p in (body.strip(), extra.strip()) if p]
        content = front_matter(meta) + "\n\n" + "\n\n".join(parts) + "\n"

        if created:
            dates.append(created)
        if args.dry_run:
            if written < 3:
                print("--- %s.md ---" % name)
                print(content[:600])
        else:
            with open(os.path.join(args.out, name + ".md"), "w", encoding="utf-8") as fh:
                fh.write(content)
        written += 1
        if args.limit and written >= args.limit:
            break

    if runner is not None:
        runner.close()
    if cache is not None:
        cache.save()

    # File names are `NNNN-slug.md` numbered by creation date, so adding or
    # removing a note shifts every later name. Without this sweep a re-run
    # would leave the previous numbering behind and the triage would read the
    # same note twice. Only a full, unfiltered run may delete.
    stale = 0
    full_run = not (args.dry_run or args.limit or args.since or args.only_note)
    if full_run and not args.dry_run:
        for name in os.listdir(args.out):
            if name.endswith(".md") and name[:-3] not in used_names:
                os.remove(os.path.join(args.out, name))
                stale += 1
        att_root = os.path.join(args.out, attachments_mod.ATTACH_SUBDIR) \
            if use_attachments else None
        if att_root and os.path.isdir(att_root):
            for name in os.listdir(att_root):
                if name not in kept_note_ids:
                    shutil.rmtree(os.path.join(att_root, name), ignore_errors=True)
                    stale += 1

    print("notes in db (not deleted): %d" % len(rows))
    if skipped_since:
        print("skipped by --since:       %d" % skipped_since)
    print("exported:                 %d%s" % (written, " (dry-run)" if args.dry_run else ""))
    print("empty body:               %d" % skipped_empty)
    if stale:
        print("stale files removed:      %d" % stale)
    print("password-protected:       %d" % skipped_locked)
    if failed:
        print("decode failures:          %d" % len(failed))
        for pk, title, err in failed[:5]:
            print("   pk=%s %r: %s" % (pk, title, err))
    if dates:
        print("date range:               %s .. %s" % (min(dates).date(), max(dates).date()))
    if stats is not None and stats.total:
        print("")
        print("adjuntos")
        print("  notas con adjuntos:     %d" % stats.notes_with_attachments)
        print("  adjuntos totales:       %d" % stats.total)
        print("  resueltos a archivo:    %d" % stats.resolved)
        print("  contenedores (galeria): %d" % stats.containers)
        print("  sin resolver:           %d" % stats.unresolved)
        for reason, count in sorted(stats.unresolved_reasons.items(), key=lambda kv: -kv[1]):
            print("     %s: %d" % (reason, count))
        print("  copiados:               %d" % stats.copied)
        print("  tablas -> markdown:     %d ok / %d sin contenido"
              % (stats.tables_ok, stats.tables_failed))
        print("  OCR ejecutado:          %d" % stats.ocr_run)
        print("  OCR desde cache:        %d" % stats.ocr_cached)
        print("  OCR sin texto:          %d" % stats.ocr_empty)
        print("  texto de Apple (fallback): %d" % stats.apple_fallback)
        print("  tiempo de adjuntos:     %.1f s" % ocr_seconds)
        if runner is not None and runner.failures:
            print("  fallos de OCR:          %d" % len(runner.failures))
            for path, err in runner.failures[:5]:
                print("     %s: %s" % (os.path.basename(path), err))
        types = ", ".join("%s=%d" % kv for kv in
                          sorted(stats.by_uti.items(), key=lambda kv: -kv[1]))
        print("  por tipo:               %s" % types)
    if not args.dry_run:
        print("output:                   %s" % os.path.abspath(args.out))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", default="/tmp/notas-export", help="output directory")
    parser.add_argument("--db", default=DEFAULT_DB, help="path to NoteStore.sqlite")
    parser.add_argument("--limit", type=int, default=0, help="stop after N notes")
    parser.add_argument("--since", help="only notes created on/after YYYY-MM-DD")
    parser.add_argument(
        "--dry-run", action="store_true", help="write nothing; print stats + 3 samples"
    )
    parser.add_argument(
        "--plain", action="store_true", help="skip markdown re-styling of headings/lists"
    )
    parser.add_argument(
        "--keep-empty", action="store_true", help="also export notes with an empty body"
    )
    parser.add_argument(
        "--only-note", help="export only this note (ZIDENTIFIER uuid or Z_PK)"
    )
    parser.add_argument(
        "--no-attachments",
        action="store_true",
        help="do not touch attachments at all (old behaviour)",
    )
    parser.add_argument(
        "--no-ocr",
        action="store_true",
        help="copy attachments and decode tables, but do not run OCR",
    )
    parser.add_argument(
        "--no-copy-attachments",
        action="store_true",
        help="OCR attachments but do not copy the originals into <out>/adjuntos/",
    )
    parser.add_argument(
        "--ocr-languages",
        default="es-ES,en-US",
        help="Vision language hints, comma separated (default: es-ES,en-US)",
    )
    parser.add_argument(
        "--no-copy",
        action="store_true",
        help="read the live DB with immutable=1 instead of copying it "
        "(ignores pending WAL)",
    )
    args = parser.parse_args(argv)
    return export(args)


if __name__ == "__main__":
    sys.exit(main())
