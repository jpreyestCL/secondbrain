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


def test_oversized_single_paragraph_is_own_chunk():
    huge = "una " * 3000  # ~3000 tokens, no blank lines
    chunks = chunk_text(huge, doc_id="d", source_path="p", sha256="s",
                        target_tokens=400)
    assert len(chunks) == 1  # never split mid-paragraph
