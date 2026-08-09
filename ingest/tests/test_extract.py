import json

import pytest

from brain_ingest.extract import (
    CODE_SKIP_REASON,
    SkipFile,
    extract_file,
    ocr_available,
)


def test_markdown_passthrough(tmp_path):
    p = tmp_path / "nota.md"
    p.write_text("# Hola\n\ncontenido", encoding="utf-8")
    content, kind = extract_file(p)
    assert kind == "text"
    assert content == "# Hola\n\ncontenido"


def test_code_file_skipped(tmp_path):
    p = tmp_path / "script.py"
    p.write_text("print('hi')")
    with pytest.raises(SkipFile) as exc:
        extract_file(p)
    assert CODE_SKIP_REASON in str(exc.value)


def test_unknown_extension_skipped(tmp_path):
    p = tmp_path / "data.xyz"
    p.write_bytes(b"\x00\x01")
    with pytest.raises(SkipFile):
        extract_file(p)


def test_csv_to_structured_json(tmp_path):
    p = tmp_path / "gastos.csv"
    p.write_text("fecha,monto\n2024-01-01,1000\n2024-01-02,2500\n", encoding="utf-8")
    content, kind = extract_file(p)
    assert kind == "json"
    data = json.loads(content)
    sheet = data["sheets"][0]
    assert sheet["headers"] == ["fecha", "monto"]
    assert sheet["rows"] == [["2024-01-01", "1000"], ["2024-01-02", "2500"]]


def test_xlsx_to_structured_json(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    p = tmp_path / "libro.xlsx"
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Hoja1"
    ws.append(["nombre", "valor"])
    ws.append(["a", 1])
    wb.save(p)
    content, kind = extract_file(p)
    assert kind == "json"
    data = json.loads(content)
    assert data["sheets"][0]["sheet"] == "Hoja1"
    assert data["sheets"][0]["headers"] == ["nombre", "valor"]
    assert data["sheets"][0]["rows"] == [["a", "1"]]


def test_docx_extraction(tmp_path):
    docx = pytest.importorskip("docx")
    p = tmp_path / "doc.docx"
    d = docx.Document()
    d.add_paragraph("Primer parrafo")
    d.add_paragraph("Segundo parrafo")
    d.save(str(p))
    content, kind = extract_file(p)
    assert kind == "text"
    assert "Primer parrafo" in content and "Segundo parrafo" in content


def test_pdf_with_text_layer(tmp_path):
    fitz = pytest.importorskip("fitz")
    p = tmp_path / "doc.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Texto de prueba PDF")
    doc.save(str(p))
    doc.close()
    content, kind = extract_file(p)
    assert kind == "text"
    assert "Texto de prueba PDF" in content


@pytest.mark.skipif(not ocr_available(), reason="no OCR backend (ocrmac/tesseract)")
def test_image_ocr(tmp_path):
    fitz = pytest.importorskip("fitz")
    # Render a PNG with text using PyMuPDF, then OCR it.
    doc = fitz.open()
    page = doc.new_page(width=400, height=120)
    page.insert_text((20, 60), "HOLA MUNDO OCR", fontsize=28)
    png = tmp_path / "img.png"
    page.get_pixmap(dpi=150).save(str(png))
    doc.close()
    content, kind = extract_file(png)
    assert kind == "text"
    assert "HOLA" in content.upper()
