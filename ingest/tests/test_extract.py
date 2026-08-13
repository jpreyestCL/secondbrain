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


def test_xls_html_disfrazado(tmp_path):
    """La cartola del banco se llama .xls pero es una tabla HTML.

    Es el caso real de ~/Documents/Sociedades: 24 de 25 archivos .xls eran
    HTML. Despachar por extension los mandaba a xlrd, que fallaba con
    "Unsupported format", y los documentos quedaban fuera del grafo.
    """
    p = tmp_path / "octubre.xls"
    p.write_text(
        "<html><body><table>"
        "<tr><th>fecha</th><th>cargo</th></tr>"
        "<tr><td>2024-10-01</td><td>1.500</td></tr>"
        "<tr><td>2024-10-02</td><td>2.300</td></tr>"
        "</table></body></html>",
        encoding="utf-8",
    )
    content, kind = extract_file(p)
    assert kind == "json"
    hoja = json.loads(content)["sheets"][0]
    assert hoja["headers"] == ["fecha", "cargo"]
    assert hoja["rows"] == [["2024-10-01", "1.500"], ["2024-10-02", "2.300"]]


def test_xls_que_en_realidad_es_xlsx(tmp_path):
    """Un .xlsx renombrado a .xls: la firma PK manda, no la extension."""
    openpyxl = pytest.importorskip("openpyxl")
    p = tmp_path / "cartola.xls"
    wb = openpyxl.Workbook()
    wb.active.title = "Movimientos"
    wb.active.append(["glosa", "monto"])
    wb.active.append(["transferencia", 42])
    wb.save(p)
    content, kind = extract_file(p)
    assert kind == "json"
    assert json.loads(content)["sheets"][0]["rows"] == [["transferencia", "42"]]


def test_xls_ole2_convierte_fechas(tmp_path):
    """Excel 97-2003 real: las fechas deben salir como fecha, no como float.

    xlrd entrega los serales de fecha como float (45231.0); dejarlos crudos
    mete numeros sin sentido en el grafo, justo lo que prohibe la regla de las
    fechas reales.
    """
    xlwt = pytest.importorskip("xlwt")
    import datetime

    p = tmp_path / "antiguo.xls"
    wb = xlwt.Workbook()
    ws = wb.add_sheet("Hoja1")
    ws.write(0, 0, "fecha")
    estilo = xlwt.easyxf(num_format_str="YYYY-MM-DD")
    ws.write(1, 0, datetime.datetime(2022, 10, 31), estilo)
    wb.save(str(p))

    content, kind = extract_file(p)
    assert kind == "json"
    assert json.loads(content)["sheets"][0]["rows"][0][0].startswith("2022-10-31")


def test_xls_binario_ilegible_da_error(tmp_path):
    from brain_ingest.extract import ExtractError

    p = tmp_path / "roto.xls"
    p.write_bytes(b"\x01\x02\x03 no soy ni OLE2 ni zip ni HTML")
    with pytest.raises(ExtractError):
        extract_file(p)


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


def test_los_temporales_de_office_se_omiten(tmp_path):
    """`~$ordenes.xlsx` es un archivo de bloqueo, no un documento.

    Daba "File is not a zip file" y se contaba como error, ensuciando el
    resumen con fallos que no lo son.
    """
    p = tmp_path / "~$ordenes EEUU.xlsx"
    p.write_bytes(b"basura de bloqueo")
    with pytest.raises(SkipFile) as exc:
        extract_file(p)
    assert "Office" in str(exc.value)


def test_un_archivo_en_la_nube_se_omite_con_su_causa(tmp_path, monkeypatch):
    """PyMuPDF dice "Failed to open file as type pdf" y parece corrupto.

    No lo esta: su contenido vive en iCloud. Confundirlo con corrupcion hace
    que el usuario descarte documentos que en realidad solo hay que bajar.
    """
    p = tmp_path / "escritura.pdf"
    p.write_bytes(b"%PDF-1.4 loquesea")
    monkeypatch.setattr("brain_ingest.extract.esta_en_la_nube", lambda _p: True)
    with pytest.raises(SkipFile) as exc:
        extract_file(p)
    assert "iCloud" in str(exc.value)


def test_un_pdf_que_no_es_pdf_dice_que_es(tmp_path):
    """La extension miente igual que con los .xls.

    Un archivo de 1,6 MB llamado .pdf resulto no serlo, y PyMuPDF solo sabia
    decir "Failed to open file as type pdf" — que no permite distinguirlo de un
    archivo corrupto.
    """
    from brain_ingest.extract import ExtractError

    p = tmp_path / "contrato.pdf"
    p.write_bytes(b"PK\x03\x04" + b"x" * 100)
    with pytest.raises(ExtractError) as exc:
        extract_file(p)
    assert "zip" in str(exc.value)

    p2 = tmp_path / "otro.pdf"
    p2.write_bytes(b"<html><body>hola</body></html>")
    with pytest.raises(ExtractError) as exc2:
        extract_file(p2)
    assert "HTML" in str(exc2.value)
