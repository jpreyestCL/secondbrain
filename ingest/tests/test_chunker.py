from brain_ingest.chunker import chunk_text, estimate_tokens, split_blocks


def make_para(i: int, words: int = 60) -> str:
    return f"parrafo{i} " + " ".join(f"palabra{j}" for j in range(words))


def test_short_text_single_chunk():
    chunks = chunk_text(
        "Hola mundo.\n\nSegundo parrafo.",
        doc_id="d1", source_path="/a.md", sha256="s",
    )
    assert len(chunks) == 1
    c = chunks[0]
    assert c.chunk_idx == 0 and c.total_chunks == 1
    assert c.doc_id == "d1" and c.source_path == "/a.md" and c.sha256 == "s"
    assert "Segundo parrafo." in c.text


def test_empty_text():
    assert chunk_text("  \n\n ", doc_id="d", source_path="p", sha256="s") == []


def test_headings_start_new_blocks():
    text = "# Title\nintro line\n## Section\nbody"
    blocks = split_blocks(text)
    assert blocks == ["# Title\nintro line", "## Section\nbody"]


def test_long_text_splits_with_overlap_and_whole_paragraphs():
    paras = [make_para(i) for i in range(40)]
    text = "\n\n".join(paras)
    chunks = chunk_text(text, doc_id="d", source_path="p", sha256="s",
                        target_tokens=400, overlap_tokens=100)
    assert len(chunks) > 1
    assert all(c.total_chunks == len(chunks) for c in chunks)
    assert [c.chunk_idx for c in chunks] == list(range(len(chunks)))

    # No paragraph is ever split: every paragraph in every chunk is one of
    # the original paragraphs, verbatim.
    originals = set(paras)
    for c in chunks:
        for para in c.text.split("\n\n"):
            assert para in originals

    # Consecutive chunks share overlap: last paragraph of chunk N appears in
    # chunk N+1.
    for a, b in zip(chunks, chunks[1:]):
        last_para = a.text.split("\n\n")[-1]
        assert last_para in b.text

    # All original paragraphs survive chunking.
    seen = {p for c in chunks for p in c.text.split("\n\n")}
    assert originals <= seen

    # Chunks respect the target size (with one-block tolerance).
    for c in chunks:
        assert estimate_tokens(c.text) <= 400 + estimate_tokens(make_para(0))


def test_un_parrafo_gigante_se_parte_para_no_reventar_el_limite():
    """Antes se emitia entero, y eso reventaba el episodio.

    `split_blocks` corta por lineas en blanco, que el texto de PyMuPDF a menudo
    no tiene: un PDF entero podia ser UN bloque. Medido en el corpus real, 18
    trozos pasaban de 4.096 tokens y uno llegaba a 25.934. El embedder corta en
    4.096 y el episodio fallaba entero con "Input length ... exceeds maximum
    allowed token size" — esta en el ledger.
    """
    from brain_ingest.chunker import MAX_TOKENS, estimate_tokens

    huge = "Una frase de prueba. " * 4000
    chunks = chunk_text(huge, doc_id="d", source_path="p", sha256="s")

    assert len(chunks) > 1, "un parrafo gigante debe partirse"
    for c in chunks:
        assert estimate_tokens(c.text) <= MAX_TOKENS, (
            f"un trozo de {estimate_tokens(c.text)} tokens supera el tope {MAX_TOKENS}"
        )
    # Y no se pierde texto: todas las frases siguen estando.
    assert sum(c.text.count("Una frase de prueba.") for c in chunks) >= 4000


def test_una_frase_sola_mas_grande_que_el_tope_tambien_se_parte():
    """Ultimo recurso: sin puntos donde cortar, se trocea por longitud."""
    from brain_ingest.chunker import MAX_TOKENS, estimate_tokens

    sin_puntos = "palabra " * 20000  # ni un punto en todo el texto
    chunks = chunk_text(sin_puntos, doc_id="d", source_path="p", sha256="s")

    assert len(chunks) > 1
    for c in chunks:
        assert estimate_tokens(c.text) <= MAX_TOKENS


# -- chunk_json (fix 4) ------------------------------------------------------

import json

from brain_ingest.chunker import chunk_json


def _sheet_doc(n_rows, sheet="Hoja1", source="ventas.xlsx"):
    return {
        "source": source,
        "sheets": [
            {
                "sheet": sheet,
                "headers": ["fecha", "cliente", "monto"],
                "rows": [
                    [f"2024-01-{i % 28 + 1:02d}", f"cliente-{i}", str(1000 + i)]
                    for i in range(n_rows)
                ],
            }
        ],
    }


def test_chunk_json_splits_rows_into_valid_standalone_json():
    text = json.dumps(_sheet_doc(400), ensure_ascii=False)
    chunks = chunk_json(text, doc_id="d", source_path="p", sha256="s",
                        target_tokens=300)
    assert len(chunks) > 1
    all_rows = []
    for c in chunks:
        data = json.loads(c.text)  # every chunk is valid standalone JSON
        # Sheet name + headers repeated per chunk for context.
        assert data["source"] == "ventas.xlsx"
        assert data["sheet"] == "Hoja1"
        assert data["headers"] == ["fecha", "cliente", "monto"]
        assert data["rows"]
        all_rows.extend(data["rows"])
        # Roughly the target size (tolerance: one row + JSON separators).
        assert estimate_tokens(c.text) <= 300 * 1.3
    # No row lost, none duplicated, order preserved.
    assert all_rows == _sheet_doc(400)["sheets"][0]["rows"]
    assert [c.chunk_idx for c in chunks] == list(range(len(chunks)))
    assert all(c.total_chunks == len(chunks) for c in chunks)


def test_chunk_json_never_mixes_sheets():
    doc = {
        "source": "libro.xlsx",
        "sheets": [
            {"sheet": "A", "headers": ["x"], "rows": [[f"a{i}"] for i in range(5)]},
            {"sheet": "B", "headers": ["y"], "rows": [[f"b{i}"] for i in range(5)]},
        ],
    }
    chunks = chunk_json(json.dumps(doc), doc_id="d", source_path="p", sha256="s")
    sheets_seen = [json.loads(c.text)["sheet"] for c in chunks]
    assert set(sheets_seen) == {"A", "B"}
    for c in chunks:
        data = json.loads(c.text)
        prefix = "a" if data["sheet"] == "A" else "b"
        assert all(cell.startswith(prefix) for row in data["rows"] for cell in row)


def test_chunk_json_small_doc_single_chunk():
    text = json.dumps(_sheet_doc(3), ensure_ascii=False)
    chunks = chunk_json(text, doc_id="d", source_path="p", sha256="s")
    assert len(chunks) == 1
    assert json.loads(chunks[0].text)["rows"] == _sheet_doc(3)["sheets"][0]["rows"]


def test_chunk_json_empty_sheets_yield_no_chunks():
    text = json.dumps({"source": "vacio.csv", "sheets": []})
    assert chunk_json(text, doc_id="d", source_path="p", sha256="s") == []


def test_chunk_json_invalid_json_falls_back_to_text():
    chunks = chunk_json("no es json {", doc_id="d", source_path="p", sha256="s")
    assert len(chunks) == 1 and "no es json" in chunks[0].text
