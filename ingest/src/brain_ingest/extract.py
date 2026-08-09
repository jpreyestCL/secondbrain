"""Extraction: turn source files into plain text or structured JSON.

Dispatch by extension:

* ``.md`` / ``.txt``          — passthrough
* ``.pdf``                    — PyMuPDF text; pages without a text layer are
                                OCR'd (ocrmac / macOS Vision, tesseract fallback)
* ``.docx``                   — python-docx; ``.doc`` via macOS ``textutil``
* ``.xlsx`` / ``.csv``        — structured JSON (per-sheet headers + rows)
* images (.png/.jpg/.heic...) — OCR
* code files                  — skipped ("code goes to codebase-memory-mcp")

Output goes to ``<extracted_dir>/<doc_id>.txt`` (or ``.json``).
"""

from __future__ import annotations

import csv
import io
import json
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

log = logging.getLogger("brain")

TEXT_EXTS = {".md", ".txt", ".markdown", ".rst", ".org"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".heic", ".tiff", ".tif", ".bmp", ".gif", ".webp"}
CODE_EXTS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".rb", ".sh", ".bash", ".zsh", ".swift",
    ".kt", ".kts", ".php", ".sql", ".scala", ".lua", ".pl", ".r", ".m", ".mm",
    ".toml", ".yaml", ".yml", ".ini", ".cfg", ".lock", ".ipynb",
}
CODE_SKIP_REASON = "code goes to codebase-memory-mcp"


class SkipFile(Exception):
    """File should be marked skipped (reason in str(exc))."""


class ExtractError(Exception):
    """Extraction failed."""


def extract_file(path: Path) -> tuple[str, str]:
    """Extract ``path``. Returns ``(content, kind)`` with kind ``text``/``json``.

    Raises :class:`SkipFile` or :class:`ExtractError`.
    """
    ext = path.suffix.lower()
    if ext in CODE_EXTS:
        raise SkipFile(CODE_SKIP_REASON)
    if ext in TEXT_EXTS:
        return path.read_text(encoding="utf-8", errors="replace"), "text"
    if ext == ".pdf":
        return _extract_pdf(path), "text"
    if ext == ".docx":
        return _extract_docx(path), "text"
    if ext == ".doc":
        return _extract_doc(path), "text"
    if ext == ".xlsx":
        return _extract_xlsx(path), "json"
    if ext == ".csv":
        return _extract_csv(path), "json"
    if ext in IMAGE_EXTS:
        return _ocr_image(path), "text"
    raise SkipFile(f"unsupported extension {ext or '(none)'}")


# -- OCR ---------------------------------------------------------------------


def ocr_available() -> bool:
    try:
        import ocrmac  # noqa: F401

        return True
    except ImportError:
        return shutil.which("tesseract") is not None


def _ocr_image(path: Path) -> str:
    try:
        from ocrmac import ocrmac as _ocrmac

        annotations = _ocrmac.OCR(str(path), recognition_level="accurate").recognize()
        return "\n".join(a[0] for a in annotations)
    except ImportError:
        pass
    if shutil.which("tesseract"):
        proc = subprocess.run(
            ["tesseract", str(path), "stdout", "-l", "spa+eng"],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if proc.returncode == 0:
            return proc.stdout
        raise ExtractError(f"tesseract failed: {proc.stderr.strip()[:200]}")
    raise ExtractError("no OCR backend (install ocrmac or tesseract)")


# -- PDF ---------------------------------------------------------------------


def _extract_pdf(path: Path) -> str:
    import fitz  # PyMuPDF

    parts: list[str] = []
    with fitz.open(path) as doc:
        for pageno, page in enumerate(doc):
            text = page.get_text().strip()
            if not text:
                text = _ocr_pdf_page(page, pageno, path)
            parts.append(text)
    return "\n\n".join(parts).strip()


def _ocr_pdf_page(page, pageno: int, path: Path) -> str:
    if not ocr_available():
        log.warning("%s p.%d has no text layer and OCR unavailable", path.name, pageno + 1)
        return ""
    pix = page.get_pixmap(dpi=200)
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        pix.save(str(tmp_path))
        return _ocr_image(tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)


# -- Word --------------------------------------------------------------------


def _extract_docx(path: Path) -> str:
    import docx

    d = docx.Document(str(path))
    parts = [p.text for p in d.paragraphs]
    for table in d.tables:
        for row in table.rows:
            parts.append(" | ".join(c.text.strip() for c in row.cells))
    return "\n\n".join(p for p in parts if p.strip())


def _extract_doc(path: Path) -> str:
    if not shutil.which("textutil"):
        raise ExtractError(".doc extraction requires macOS textutil")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / (path.stem + ".txt")
        proc = subprocess.run(
            ["textutil", "-convert", "txt", "-output", str(out), str(path)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if proc.returncode != 0 or not out.exists():
            raise ExtractError(f"textutil failed: {proc.stderr.strip()[:200]}")
        return out.read_text(encoding="utf-8", errors="replace")


# -- Tabular -----------------------------------------------------------------


def _extract_xlsx(path: Path) -> str:
    import openpyxl

    wb = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        rows = [
            ["" if c is None else str(c) for c in row]
            for row in ws.iter_rows(values_only=True)
        ]
        headers = rows[0] if rows else []
        sheets.append({"sheet": ws.title, "headers": headers, "rows": rows[1:]})
    wb.close()
    return json.dumps({"source": path.name, "sheets": sheets}, ensure_ascii=False, indent=1)


def _extract_csv(path: Path) -> str:
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    try:
        dialect = csv.Sniffer().sniff(raw[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = [row for row in csv.reader(io.StringIO(raw), dialect)]
    headers = rows[0] if rows else []
    payload = {
        "source": path.name,
        "sheets": [{"sheet": path.stem, "headers": headers, "rows": rows[1:]}],
    }
    return json.dumps(payload, ensure_ascii=False, indent=1)
