#!/usr/bin/env python3
"""Recover Apple Notes attachments: original files, OCR text and tables.

This module is imported by ``notes-export.py`` (the single entry point) and can
also be run directly as the OCR worker subprocess (``--ocr-worker``).

WHY THIS EXISTS
---------------
Many notes are *only* a photo or a scan (``#pasaporte``, ``RUT JP scan ->``).
The note body in ``ZICNOTEDATA`` is then just the title plus U+FFFC object
replacement characters, so the exported Markdown looked empty and the triage
threw it away as ``casi_vacio``. The real content is in the attachment files.

SCHEMA (verified on this machine, macOS Notes)
----------------------------------------------
There is **no ZICATTACHMENT table**. Everything lives in
``ZICCLOUDSYNCINGOBJECT``:

* an *attachment* row has ``ZTYPEUTI`` set and ``ZNOTE`` -> the note's Z_PK;
* ``ZMEDIA`` -> the Z_PK of a *media* row (``Z_ENT`` 10) that carries
  ``ZIDENTIFIER`` (a directory name) and ``ZFILENAME``;
* the file is **not** at ``Media/<ZIDENTIFIER>/<ZFILENAME>``: Apple inserts a
  generation directory, so the real path is
  ``Media/<ZIDENTIFIER>/<N>_<UUID>/<ZFILENAME>`` for most rows and
  ``Media/<ZIDENTIFIER>/<ZFILENAME>`` for old ones. We walk the media
  directory and take the matching file name (584/584 resolve).

Attachments without a media row:

* ``com.apple.notes.gallery`` -- a *container*; its children are ordinary
  ``public.jpeg`` rows that already point at the note via ``ZNOTE`` and at the
  gallery via ``ZPARENTATTACHMENT``. Galleries are skipped, never dropped.
* ``com.apple.paper.doc.scan`` -- scanned document, PDF at
  ``FallbackPDFs/<attachment ZIDENTIFIER>/<ZFALLBACKPDFGENERATION>/FallbackPDF.pdf``.
* ``com.apple.paper`` -- handwriting/paper, image at
  ``FallbackImages/<ZIDENTIFIER>/<ZFALLBACKIMAGEGENERATION>/FallbackImage.png``.
* ``com.apple.drawing.2`` -- drawing, image at ``FallbackImages/<ZIDENTIFIER>.jpg``.
* ``com.apple.notes.table`` -- an Apple table: a gzipped CRDT protobuf in
  ``ZMERGEABLEDATA1``. Decoded here into a Markdown table (see ictable_*).

Last resort for anything unresolved: ``Previews/<ZIDENTIFIER>-*`` (downscaled,
so only used when the original is missing).

Apple's own OCR is in ``ZOCRSUMMARY`` (present for 586/584 image rows) but it
is noisy -- it stores every recognition candidate separated by tabs. We run
Apple Vision ourselves via ``ocrmac`` and keep ``ZOCRSUMMARY`` only as a
fallback for attachments whose file could not be resolved.

OCR RUNTIME
-----------
``ocrmac`` is not in the stdlib and this script must stay importable from a
plain ``python3``. If ``ocrmac`` cannot be imported in the current interpreter,
we look for the project's uv venv (``ingest/.venv/bin/python3``) and run *this
same file* there as a subprocess worker speaking JSONL over stdin/stdout.

Results are cached in ``<out>/.adjuntos-cache.json`` keyed by the SHA-256 of the
file bytes, so re-running is idempotent and resumable and never re-OCRs.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

NOTES_ROOT = os.path.expanduser("~/Library/Group Containers/group.com.apple.notes")
MEDIA_DIR = os.path.join(NOTES_ROOT, "Media")
FALLBACK_PDF_DIR = os.path.join(NOTES_ROOT, "FallbackPDFs")
FALLBACK_IMG_DIR = os.path.join(NOTES_ROOT, "FallbackImages")
PREVIEWS_DIR = os.path.join(NOTES_ROOT, "Previews")

CACHE_NAME = ".adjuntos-cache.json"
ATTACH_SUBDIR = "adjuntos"

# UTIs whose file we can feed to Vision.
IMAGE_UTIS = {
    "public.png",
    "public.jpeg",
    "public.tiff",
    "public.heic",
    "public.heif",
    "com.compuserve.gif",
}
# Containers: their children are separate rows already linked to the note.
CONTAINER_UTIS = {"com.apple.notes.gallery"}
TABLE_UTI = "com.apple.notes.table"
PDF_UTIS = {"com.apple.paper.doc.scan", "com.adobe.pdf"}
FALLBACK_IMAGE_UTIS = {"com.apple.paper", "com.apple.drawing.2"}

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tiff", ".tif", ".heic", ".heif", ".gif"}


# --------------------------------------------------------------------------
# protobuf helpers (shared shape with notes-export.py, duplicated so this
# module can be imported on its own)
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
    out = []
    i = 0
    n = len(buf)
    while i < n:
        try:
            key, i = _read_varint(buf, i)
        except ValueError:
            break
        field, wire = key >> 3, key & 7
        if wire == 0:
            try:
                value, i = _read_varint(buf, i)
            except ValueError:
                break
            out.append((field, 0, value))
        elif wire == 2:
            try:
                length, i = _read_varint(buf, i)
            except ValueError:
                break
            if length < 0 or i + length > n:
                break
            out.append((field, 2, buf[i : i + length]))
            i += length
        elif wire == 5:
            out.append((field, 5, buf[i : i + 4]))
            i += 4
        elif wire == 1:
            out.append((field, 1, buf[i : i + 8]))
            i += 8
        else:
            break
    return out


def _first(fields, number, wire=2, default=None):
    for f, w, v in fields:
        if f == number and w == wire:
            return v
    return default


# --------------------------------------------------------------------------
# Apple table (ICTable) -> Markdown
# --------------------------------------------------------------------------
#
# ZMERGEABLEDATA1 is gzip( MergableDataProto ):
#
#   MergableDataProto { MergableDataObject mergable_data_object = 2; }
#   MergableDataObject { MergeableDataObjectData data = 3; }
#   MergeableDataObjectData {
#       repeated ObjectEntry object_entry = 3;   <- 0-based "object index"
#       repeated string key_item           = 4;
#       repeated string type_item          = 5;
#       repeated bytes  uuid_item          = 6;  <- 16-byte UUIDs
#   }
#   ObjectEntry { ... Dictionary dictionary = 6; Note note = 10;
#                 CustomMap custom_map = 13; OrderedSet ordered_set = 16; }
#   CustomMap  { uint32 type_index = 1; repeated MapEntry entry = 3; }
#   MapEntry   { uint32 key_index = 1; ObjectID value = 2; }
#   ObjectID   { uint64 unsigned_integer_value = 2; string string_value = 4;
#                uint32 object_index = 6; }
#   Dictionary { repeated Element element = 1; }
#   Element    { ObjectID key = 1; ObjectID value = 2; }
#   Note       { string note_text = 2; ... }
#   OrderedSet { Ordering ordering = 1; Dictionary elements = 2; }
#   Ordering   { Array array = 1; Dictionary contents = 2; }
#   Array      { Note attachment = 1; repeated Replica replica = 2; }
#   Replica    { uint32 index = 1; bytes uuid = 2; }
#
# The table root is the CustomMap of type ``com.apple.notes.ICTable`` and gives
# ``crRows`` / ``crColumns`` (OrderedSets) and ``cellColumns`` (a Dictionary of
# column -> Dictionary of row -> Note).
#
# Ordering is two hops: the Array's replicas give the CRTree node UUIDs *in
# display order*; ``Ordering.contents`` maps each node object to the row/column
# UUID object actually used as a key in ``cellColumns``.


def _objid(buf):
    fs = parse_fields(buf)
    v = _first(fs, 6, 0)
    if v is not None:
        return ("idx", v)
    s = _first(fs, 4, 2)
    if s is not None:
        return ("uuid", s.decode("utf-8", "replace"))
    v = _first(fs, 2, 0)
    if v is not None:
        return ("int", v)
    return None


def _dict_elements(msg):
    out = []
    for f, w, v in parse_fields(msg or b""):
        if f == 1 and w == 2:
            fs = parse_fields(v)
            key, value = _first(fs, 1), _first(fs, 2)
            out.append((_objid(key) if key else None, _objid(value) if value else None))
    return out


def _entry_dictionary(entry):
    d = _first(parse_fields(entry), 6)
    return _dict_elements(d) if d is not None else None


def _entry_custom_map(entry):
    cm = _first(parse_fields(entry), 13)
    if cm is None:
        return None
    fs = parse_fields(cm)
    out = {}
    for f, w, v in fs:
        if f == 3 and w == 2:
            mfs = parse_fields(v)
            value = _first(mfs, 2)
            out[_first(mfs, 1, 0, 0)] = _objid(value) if value is not None else None
    return _first(fs, 1, 0), out


def _entry_note_text(entry):
    note = _first(parse_fields(entry), 10)
    if note is None:
        return None
    text = _first(parse_fields(note), 2)
    return text.decode("utf-8", "replace") if text is not None else ""


def _ordered_set(entry):
    """-> (ordered node uuids, {node object index: target object index})."""
    oset = _first(parse_fields(entry), 16)
    if oset is None:
        return [], {}
    ordering = _first(parse_fields(oset), 1)
    if ordering is None:
        return [], {}
    ofs = parse_fields(ordering)
    array, contents = _first(ofs, 1), _first(ofs, 2)
    seq = {}
    for f, w, v in parse_fields(array or b""):
        if f == 2 and w == 2:
            fs = parse_fields(v)
            uuid = _first(fs, 2, 2)
            if uuid is not None and len(uuid) == 16:
                seq[_first(fs, 1, 0, 0)] = uuid
    cmap = {
        k[1]: v[1]
        for k, v in _dict_elements(contents)
        if k and v and k[0] == "idx" and v[0] == "idx"
    }
    return [seq[i] for i in sorted(seq)], cmap


def table_to_markdown(blob):
    """gzipped ICTable CRDT blob -> Markdown table (or None)."""
    if not blob:
        return None
    try:
        raw = gzip.decompress(blob)
    except Exception:
        return None
    obj = _first(parse_fields(raw), 2)
    data = _first(parse_fields(obj or b""), 3)
    if data is None:
        return None
    fs = parse_fields(data)
    entries = [v for f, w, v in fs if f == 3 and w == 2]
    keys = [v.decode("utf-8", "replace") for f, w, v in fs if f == 4 and w == 2]
    types = [v.decode("utf-8", "replace") for f, w, v in fs if f == 5 and w == 2]
    uuids = [v for f, w, v in fs if f == 6 and w == 2]

    root = None
    obj_uuid = {}
    for i, entry in enumerate(entries):
        cm = _entry_custom_map(entry)
        if not cm:
            continue
        type_index, mapping = cm
        tname = types[type_index] if type_index is not None and type_index < len(types) else ""
        if tname == "com.apple.notes.ICTable":
            root = {keys[k]: v for k, v in mapping.items() if k < len(keys)}
        elif tname == "com.apple.CRDT.NSUUID":
            for _k, value in mapping.items():
                if value and value[0] == "int" and value[1] < len(uuids):
                    obj_uuid[i] = uuids[value[1]]
    if not root:
        return None

    by_uuid = {}
    for obj, uuid in obj_uuid.items():
        by_uuid.setdefault(uuid, obj)

    def ordered(key):
        oid = root.get(key)
        if not (oid and oid[0] == "idx" and oid[1] < len(entries)):
            return []
        seq, cmap = _ordered_set(entries[oid[1]])
        out = []
        for uuid in seq:
            node = by_uuid.get(uuid)
            target = cmap.get(node) if node is not None else None
            if target is not None:
                out.append(target)
        return out

    cols, rows = ordered("crColumns"), ordered("crRows")
    cells = {}
    cc = root.get("cellColumns")
    if cc and cc[0] == "idx" and cc[1] < len(entries):
        for ck, cv in _entry_dictionary(entries[cc[1]]) or []:
            if not (ck and cv and ck[0] == "idx" and cv[0] == "idx"):
                continue
            for rk, rv in _entry_dictionary(entries[cv[1]]) or []:
                if not (rk and rv and rk[0] == "idx" and rv[0] == "idx"):
                    continue
                cells[(ck[1], rk[1])] = _entry_note_text(entries[rv[1]]) or ""
    if not cols or not rows:
        return None

    def cell(c, r):
        return (cells.get((c, r)) or "").replace("\n", " ").replace("|", "\\|").strip()

    grid = [[cell(c, r) for c in cols] for r in rows]
    # Drop trailing all-empty columns (Apple keeps spare ones around).
    while grid and grid[0] and all(not row[-1] for row in grid):
        for row in grid:
            row.pop()
    if not grid or not grid[0]:
        return None
    if not any(any(v for v in row) for row in grid):
        return None
    width = len(grid[0])
    out = ["| " + " | ".join(grid[0]) + " |", "|" + "|".join(["---"] * width) + "|"]
    for row in grid[1:]:
        out.append("| " + " | ".join(row) + " |")
    return "\n".join(out)


# --------------------------------------------------------------------------
# attachment discovery
# --------------------------------------------------------------------------

ATTACH_QUERY = """
SELECT  a.Z_PK                     AS pk,
        a.ZNOTE                    AS note_pk,
        a.ZTYPEUTI                 AS uti,
        a.ZIDENTIFIER              AS identifier,
        a.ZPARENTATTACHMENT        AS parent_pk,
        a.ZFALLBACKPDFGENERATION   AS pdf_gen,
        a.ZFALLBACKIMAGEGENERATION AS img_gen,
        a.ZOCRSUMMARY              AS ocr_summary,
        a.ZHANDWRITINGSUMMARY      AS handwriting,
        a.ZMERGEABLEDATA1          AS mergeable,
        m.ZIDENTIFIER              AS media_dir,
        m.ZFILENAME                AS filename
FROM    ZICCLOUDSYNCINGOBJECT a
LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON m.Z_PK = a.ZMEDIA
WHERE   a.ZTYPEUTI IS NOT NULL
  AND   a.ZNOTE IS NOT NULL
  AND   COALESCE(a.ZMARKEDFORDELETION, 0) = 0
ORDER BY a.ZNOTE, a.Z_PK
"""


class Attachment(object):
    __slots__ = (
        "pk",
        "note_pk",
        "uti",
        "identifier",
        "filename",
        "path",
        "source",
        "reason",
        "kind",
        "table_md",
        "apple_ocr",
        "text",
        "copied_as",
    )

    def __init__(self, row):
        self.pk = row["pk"]
        self.note_pk = row["note_pk"]
        self.uti = row["uti"] or ""
        self.identifier = row["identifier"] or ""
        self.filename = row["filename"] or ""
        self.path = None
        self.source = None
        self.reason = None
        self.kind = "other"
        self.table_md = None
        self.apple_ocr = clean_apple_ocr(row["ocr_summary"]) or clean_apple_ocr(
            row["handwriting"]
        )
        self.text = ""
        self.copied_as = None

    @property
    def label(self):
        return self.filename or ("%s.%s" % (self.identifier[:8] or self.pk, short_uti(self.uti)))


def short_uti(uti):
    return (uti or "desconocido").rsplit(".", 1)[-1]


_OCR_ALT = re.compile(r"\n\t[^\n]*")


def clean_apple_ocr(value):
    """ZOCRSUMMARY stores every candidate: 'REAL\\n\\talt1\\n\\talt2'. Keep the first."""
    if not value:
        return ""
    return _OCR_ALT.sub("", value).strip()


def _walk_find(directory, filename):
    if not filename or not os.path.isdir(directory):
        return None
    for root, _dirs, files in os.walk(directory):
        if filename in files:
            return os.path.join(root, filename)
    return None


def _first_file(directory):
    if not os.path.isdir(directory):
        return None
    for root, _dirs, files in os.walk(directory):
        for name in sorted(files):
            if not name.startswith("."):
                return os.path.join(root, name)
    return None


def _preview_path(identifier):
    if not identifier or not os.path.isdir(PREVIEWS_DIR):
        return None
    best = None
    prefix = identifier + "-"
    for name in os.listdir(PREVIEWS_DIR):
        if not name.startswith(prefix):
            continue
        full = os.path.join(PREVIEWS_DIR, name)
        candidate = full if os.path.isfile(full) else _first_file(full)
        if candidate and (best is None or os.path.getsize(candidate) > os.path.getsize(best)):
            best = candidate
    return best


def resolve(att, row):
    """Fill att.path / att.source / att.kind / att.reason."""
    if att.uti in CONTAINER_UTIS:
        att.kind = "container"
        att.reason = "contenedor (sus hijos se procesan aparte)"
        return
    if att.uti == TABLE_UTI:
        att.kind = "table"
        att.table_md = table_to_markdown(row["mergeable"])
        if att.table_md is None:
            att.reason = "tabla sin contenido legible"
        return

    if row["media_dir"] and att.filename:
        path = _walk_find(os.path.join(MEDIA_DIR, row["media_dir"]), att.filename)
        if path is None:
            path = _first_file(os.path.join(MEDIA_DIR, row["media_dir"]))
        if path:
            att.path, att.source = path, "media"

    if att.path is None and att.uti in PDF_UTIS:
        base = os.path.join(FALLBACK_PDF_DIR, att.identifier)
        path = _walk_find(os.path.join(base, row["pdf_gen"] or ""), "FallbackPDF.pdf")
        path = path or _first_file(base)
        if path:
            att.path, att.source = path, "fallback-pdf"
            att.filename = att.filename or ("%s.pdf" % att.identifier[:8])

    if att.path is None and att.uti in FALLBACK_IMAGE_UTIS:
        flat = os.path.join(FALLBACK_IMG_DIR, att.identifier + ".jpg")
        if os.path.isfile(flat):
            att.path, att.source = flat, "fallback-image"
        else:
            path = _first_file(os.path.join(FALLBACK_IMG_DIR, att.identifier))
            if path:
                att.path, att.source = path, "fallback-image"
        if att.path and not att.filename:
            att.filename = "%s%s" % (att.identifier[:8], os.path.splitext(att.path)[1])

    if att.path is None:
        path = _preview_path(att.identifier)
        if path:
            att.path, att.source = path, "preview"
            if not att.filename:
                att.filename = "%s-preview%s" % (
                    att.identifier[:8],
                    os.path.splitext(path)[1] or ".jpg",
                )

    if att.path is None:
        att.reason = "sin archivo en Media/, FallbackPDFs/, FallbackImages/ ni Previews/"
        att.kind = "pdf" if att.uti in PDF_UTIS else (
            "image" if att.uti in IMAGE_UTIS or att.uti in FALLBACK_IMAGE_UTIS else "other"
        )
        return

    ext = os.path.splitext(att.path)[1].lower()
    if ext == ".pdf" or att.uti in PDF_UTIS:
        att.kind = "pdf"
    elif ext in IMAGE_EXTS or att.uti in IMAGE_UTIS or att.uti in FALLBACK_IMAGE_UTIS:
        att.kind = "image"
    else:
        att.kind = "other"
        att.reason = "tipo no OCR-able (%s)" % att.uti


def load(conn, only_note_pk=None):
    """-> {note_pk: [Attachment]} with paths already resolved."""
    conn.row_factory = __import__("sqlite3").Row
    by_note = {}
    for row in conn.execute(ATTACH_QUERY):
        if only_note_pk is not None and row["note_pk"] != only_note_pk:
            continue
        att = Attachment(row)
        resolve(att, row)
        by_note.setdefault(att.note_pk, []).append(att)
    return by_note


# --------------------------------------------------------------------------
# OCR
# --------------------------------------------------------------------------

VENV_CANDIDATES = (
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                 "ingest", ".venv", "bin", "python3"),
)


def _have_ocrmac(python=None):
    if python is None:
        try:
            import ocrmac  # noqa: F401
            return True
        except Exception:
            return False
    try:
        return subprocess.call(
            [python, "-c", "import ocrmac"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ) == 0
    except OSError:
        return False


def find_ocr_python():
    """-> interpreter able to import ocrmac, or None."""
    if _have_ocrmac():
        return sys.executable
    for candidate in VENV_CANDIDATES:
        if os.path.exists(candidate) and _have_ocrmac(candidate):
            return candidate
    return None


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class OcrRunner(object):
    """Runs the OCR worker (this file, --ocr-worker) in an ocrmac-capable venv."""

    def __init__(self, python, languages=("es-ES", "en-US")):
        self.python = python
        self.languages = list(languages)
        self.proc = None
        self.failures = []

    def _start(self):
        if self.proc is not None:
            return
        self.proc = subprocess.Popen(
            [self.python, os.path.abspath(__file__), "--ocr-worker",
             "--languages", ",".join(self.languages)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=None, text=True, bufsize=1,
        )

    def run(self, path, kind):
        self._start()
        self.proc.stdin.write(json.dumps({"path": path, "kind": kind}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("el worker de OCR murio")
        result = json.loads(line)
        if result.get("error"):
            self.failures.append((path, result["error"]))
            return ""
        return result.get("text", "")

    def close(self):
        if self.proc is not None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=10)
            except Exception:
                self.proc.kill()
            self.proc = None


# ---- worker side (runs in the venv that has ocrmac) -----------------------


def _lines_from_vision(result):
    """[(text, conf, (x, y, w, h))] with a bottom-left origin -> reading order."""
    boxes = [r for r in result if (r[0] or "").strip()]
    if not boxes:
        return ""
    heights = sorted(b[2][3] for b in boxes)
    tol = max(heights[len(heights) // 2] * 0.6, 0.005)
    boxes.sort(key=lambda b: -(b[2][1] + b[2][3] / 2.0))
    lines = []
    for box in boxes:
        center = box[2][1] + box[2][3] / 2.0
        if lines and abs(lines[-1][0] - center) <= tol:
            lines[-1][1].append(box)
        else:
            lines.append((center, [box]))
    out = []
    for _center, group in lines:
        group.sort(key=lambda b: b[2][0])
        out.append(" ".join(b[0].strip() for b in group))
    return "\n".join(out)


def _ocr_image_worker(path, languages):
    from ocrmac import ocrmac

    result = ocrmac.OCR(
        path, language_preference=languages, recognition_level="accurate"
    ).recognize()
    return _lines_from_vision(result)


def _ocr_pdf_worker(path, languages):
    import tempfile

    from Foundation import NSURL, NSMakeSize
    from Quartz import PDFDocument, kPDFDisplayBoxMediaBox

    doc = PDFDocument.alloc().initWithURL_(NSURL.fileURLWithPath_(path))
    if doc is None:
        raise RuntimeError("PDF ilegible")
    embedded = (doc.string() or "").strip()
    pages = []
    tmpdir = tempfile.mkdtemp(prefix="notes-pdf-ocr-")
    try:
        for index in range(doc.pageCount()):
            page = doc.pageAtIndex_(index)
            bounds = page.boundsForBox_(kPDFDisplayBoxMediaBox)
            scale = 2.0
            size = NSMakeSize(bounds.size.width * scale, bounds.size.height * scale)
            image = page.thumbnailOfSize_forBox_(size, kPDFDisplayBoxMediaBox)
            data = image.TIFFRepresentation()
            out = os.path.join(tmpdir, "page-%03d.tiff" % index)
            data.writeToFile_atomically_(out, True)
            text = _ocr_image_worker(out, languages)
            if text.strip():
                pages.append(text)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    if embedded and len("".join(pages)) < len(embedded):
        return embedded
    return "\n\n".join(pages)


def ocr_worker_main(languages):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        job = json.loads(line)
        try:
            if job.get("kind") == "pdf":
                text = _ocr_pdf_worker(job["path"], languages)
            else:
                text = _ocr_image_worker(job["path"], languages)
            out = {"path": job["path"], "text": text}
        except Exception as exc:  # noqa: BLE001 - report, never crash the batch
            out = {"path": job.get("path"), "error": "%s: %s" % (type(exc).__name__, exc)}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------


class Cache(object):
    def __init__(self, path):
        self.path = path
        self.data = {}
        self.dirty = False
        self.hits = 0
        if path and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    self.data = json.load(fh)
            except Exception:
                self.data = {}

    def get(self, digest):
        value = self.data.get(digest)
        if value is not None:
            self.hits += 1
        return value

    def put(self, digest, text):
        self.data[digest] = text
        self.dirty = True

    def save(self):
        if not self.path or not self.dirty:
            return
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.data, fh, ensure_ascii=False)
        os.replace(tmp, self.path)
        self.dirty = False


# --------------------------------------------------------------------------
# per-note processing
# --------------------------------------------------------------------------

OCR_HEADING = "## Texto reconocido de adjuntos"
TABLE_HEADING = "## Tablas de la nota"


class Stats(object):
    def __init__(self):
        self.notes_with_attachments = 0
        self.total = 0
        self.resolved = 0
        self.unresolved = 0
        self.containers = 0
        self.by_uti = {}
        self.unresolved_reasons = {}
        self.ocr_run = 0
        self.ocr_cached = 0
        self.ocr_empty = 0
        self.apple_fallback = 0
        self.tables_ok = 0
        self.tables_failed = 0
        self.copied = 0
        self.failures = []

    def bump(self, mapping, key):
        mapping[key] = mapping.get(key, 0) + 1


def unique_name(name, taken):
    base, ext = os.path.splitext(name)
    candidate = name
    counter = 2
    while candidate in taken:
        candidate = "%s-%d%s" % (base, counter, ext)
        counter += 1
    taken.add(candidate)
    return candidate


def process_note(attachments, note_id, out_dir, cache, runner, stats, copy=True):
    """-> (markdown_sections, [relative attachment paths]).

    ``markdown_sections`` is appended verbatim to the note body.
    """
    if not attachments:
        return "", []

    stats.notes_with_attachments += 1
    rel_paths = []
    ocr_blocks = []
    table_blocks = []
    taken = set()
    dest_dir = os.path.join(out_dir, ATTACH_SUBDIR, note_id)

    table_index = 0
    for att in attachments:
        stats.total += 1
        stats.bump(stats.by_uti, att.uti)

        if att.kind == "container":
            stats.containers += 1
            continue

        if att.kind == "table":
            table_index += 1
            if att.table_md:
                stats.tables_ok += 1
                table_blocks.append("### Tabla %d\n\n%s" % (table_index, att.table_md))
            else:
                stats.tables_failed += 1
            stats.resolved += 1  # the table lives in the DB, not on disk
            continue

        if att.path is None:
            stats.unresolved += 1
            stats.bump(stats.unresolved_reasons, att.reason or "desconocido")
            if att.apple_ocr:
                stats.apple_fallback += 1
                ocr_blocks.append(
                    "### %s\n\n_(archivo no encontrado; texto tomado del OCR "
                    "propio de Apple, ZOCRSUMMARY)_\n\n%s" % (att.label, att.apple_ocr)
                )
            continue

        stats.resolved += 1

        name = unique_name(os.path.basename(att.path), taken)
        if copy:
            os.makedirs(dest_dir, exist_ok=True)
            target = os.path.join(dest_dir, name)
            if not os.path.exists(target) or os.path.getsize(target) != os.path.getsize(att.path):
                shutil.copy2(att.path, target)
                stats.copied += 1
            att.copied_as = name
            rel_paths.append("%s/%s/%s" % (ATTACH_SUBDIR, note_id, name))

        if runner is None or att.kind not in ("image", "pdf"):
            if att.apple_ocr:
                stats.apple_fallback += 1
                ocr_blocks.append(
                    "### %s\n\n_(OCR propio de Apple, ZOCRSUMMARY)_\n\n%s"
                    % (name, att.apple_ocr)
                )
            continue

        digest = sha256_file(att.path)
        text = cache.get(digest)
        if text is None:
            text = runner.run(att.path, att.kind)
            cache.put(digest, text)
            stats.ocr_run += 1
            # One note can hold 100+ screenshots; flush often so a crash never
            # throws away an hour of OCR.
            if stats.ocr_run % 10 == 0:
                cache.save()
        else:
            stats.ocr_cached += 1

        text = (text or "").strip()
        if not text and att.apple_ocr:
            text = att.apple_ocr
            stats.apple_fallback += 1
        if text:
            ocr_blocks.append("### %s\n\n%s" % (name, text))
        else:
            stats.ocr_empty += 1

    sections = []
    if table_blocks:
        sections.append(TABLE_HEADING + "\n\n" + "\n\n".join(table_blocks))
    if ocr_blocks:
        sections.append(OCR_HEADING + "\n\n" + "\n\n".join(ocr_blocks))
    return ("\n\n".join(sections), rel_paths)


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="OCR worker for notes-export.py")
    parser.add_argument("--ocr-worker", action="store_true",
                        help="read JSONL jobs on stdin, write JSONL results on stdout")
    parser.add_argument("--languages", default="es-ES,en-US")
    args = parser.parse_args(argv)
    if args.ocr_worker:
        return ocr_worker_main([x for x in args.languages.split(",") if x])
    parser.error("este modulo se usa desde notes-export.py (o con --ocr-worker)")


if __name__ == "__main__":
    sys.exit(main())
