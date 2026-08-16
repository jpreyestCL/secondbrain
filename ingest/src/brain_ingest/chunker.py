"""Structural chunking of extracted text.

Text is split into blocks on markdown headings and blank lines (paragraphs).
Blocks are packed into chunks of roughly ``target_tokens`` (default 1200) with
about ``overlap_tokens`` (default 150) of trailing context repeated at the
start of the next chunk. A paragraph is never split in half — an oversized
single paragraph becomes its own chunk.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

#: Tamano objetivo de cada trozo, en tokens estimados.
#:
#: Subido de 1.200 a 3.000 con la medicion delante. Cada trozo se convierte en
#: UN episodio del grafo, y un episodio cuesta ~8 llamadas al LLM, ~34
#: embeddings y ~85 consultas al grafo — un peaje fijo que es el ~60% del coste
#: total, independiente de lo que traiga dentro. Con trozos de 4,4 KB medianos
#: se pagaba ese peaje 2.017 veces para mover paquetes pequenos.
#:
#: No se sube mas porque la extraccion de entidades pierde recall en textos
#: largos: el LLM se salta cosas del medio.
TARGET_TOKENS = 3000
OVERLAP_TOKENS = 150

#: Tope DURO. Ningun trozo sale de aqui por encima de esto.
#:
#: Antes no habia: un bloque que superara el objetivo se emitia entero, y como
#: `split_blocks` corta por lineas en blanco —que el texto de PyMuPDF a menudo
#: no tiene—, un PDF entero podia ser UN bloque. Medido en el corpus real: 18
#: trozos de mas de 4.096 tokens y uno de 25.934. El embedder corta en 4.096 y
#: el episodio fallaba entero con "Input length ... exceeds maximum allowed
#: token size".
MAX_TOKENS = 3800

_HEADING_RE = re.compile(r"^#{1,6}\s", re.MULTILINE)


def estimate_tokens(text: str) -> int:
    """Estimacion barata de tokens, CONSERVADORA (por exceso).

    Antes asumia 4 caracteres por token, que vale para prosa inglesa. En
    espanol con acentos y nombres propios ronda 3,3, y en JSON con comillas y
    llaves baja a ~2,5: el "1200" real eran 1.500-1.900 tokens. Equivocarse por
    exceso parte un trozo de mas; por defecto, revienta el episodio contra el
    limite del proveedor.
    """
    return max(1, len(text) // 3)


@dataclass
class Chunk:
    doc_id: str
    chunk_idx: int
    total_chunks: int
    source_path: str
    sha256: str
    text: str

    def to_dict(self) -> dict:
        return {
            "doc_id": self.doc_id,
            "chunk_idx": self.chunk_idx,
            "total_chunks": self.total_chunks,
            "source_path": self.source_path,
            "sha256": self.sha256,
            "text": self.text,
        }


def split_blocks(text: str) -> list[str]:
    """Split into structural blocks: heading lines start a new block, and
    blank-line-separated paragraphs are separate blocks."""
    blocks: list[str] = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip("\n")
        if not para.strip():
            continue
        # Further split a paragraph that contains headings mid-block.
        lines = para.split("\n")
        buf: list[str] = []
        for line in lines:
            if _HEADING_RE.match(line) and buf:
                blocks.append("\n".join(buf))
                buf = [line]
            else:
                buf.append(line)
        if buf:
            blocks.append("\n".join(buf))
    return blocks


def _partir_si_excede(bloques: list[str], tope: int) -> list[list[str]]:
    """Divide un grupo que supere `tope`, cortando por frases y sin perder texto."""
    if estimate_tokens("\n\n".join(bloques)) <= tope:
        return [bloques]

    salida: list[list[str]] = []
    actual: list[str] = []
    for bloque in bloques:
        piezas = [bloque]
        if estimate_tokens(bloque) > tope:
            # Un solo bloque ya no cabe: cortarlo por frases (y si una frase
            # sola tampoco cabe, por longitud, que es el ultimo recurso).
            piezas = _partir_por_frases(bloque, tope)
        for pieza in piezas:
            if actual and estimate_tokens("\n\n".join(actual + [pieza])) > tope:
                salida.append(actual)
                actual = []
            actual.append(pieza)
    if actual:
        salida.append(actual)
    return salida


def _partir_por_frases(texto: str, tope: int) -> list[str]:
    frases = re.split(r"(?<=[.!?])\s+", texto)
    piezas: list[str] = []
    actual = ""
    for frase in frases:
        candidata = f"{actual} {frase}".strip() if actual else frase
        if actual and estimate_tokens(candidata) > tope:
            piezas.append(actual)
            actual = frase
        else:
            actual = candidata
        # Ni cortando por frases cabe: trocear por longitud, sin perder nada.
        while estimate_tokens(actual) > tope:
            corte = tope * 3
            piezas.append(actual[:corte])
            actual = actual[corte:]
    if actual:
        piezas.append(actual)
    return piezas


def chunk_text(
    text: str,
    *,
    doc_id: str,
    source_path: str,
    sha256: str,
    target_tokens: int = TARGET_TOKENS,
    overlap_tokens: int = OVERLAP_TOKENS,
) -> list[Chunk]:
    blocks = split_blocks(text)
    if not blocks:
        return []

    groups: list[list[str]] = []
    current: list[str] = []
    current_tokens = 0

    for block in blocks:
        btok = estimate_tokens(block)
        if current and current_tokens + btok > target_tokens:
            groups.append(current)
            # Overlap: carry trailing blocks (~overlap_tokens) into next chunk.
            carry: list[str] = []
            carry_tokens = 0
            for prev in reversed(current):
                ptok = estimate_tokens(prev)
                if carry and carry_tokens + ptok > overlap_tokens:
                    break
                if not carry and ptok > overlap_tokens * 2:
                    # Last paragraph is far larger than the overlap budget;
                    # duplicating it would bloat chunks — skip overlap.
                    break
                carry.insert(0, prev)
                carry_tokens += ptok
            current = list(carry)
            current_tokens = carry_tokens
        current.append(block)
        current_tokens += btok

    if current:
        groups.append(current)

    # Tope duro: parte por frases lo que siga siendo demasiado grande. Se hace
    # al final, sobre los grupos ya formados, para no complicar el empaquetado.
    groups = [t for g in groups for t in _partir_si_excede(g, MAX_TOKENS)]

    total = len(groups)
    return [
        Chunk(
            doc_id=doc_id,
            chunk_idx=i,
            total_chunks=total,
            source_path=source_path,
            sha256=sha256,
            text="\n\n".join(g),
        )
        for i, g in enumerate(groups)
    ]


def chunk_json(
    text: str,
    *,
    doc_id: str,
    source_path: str,
    sha256: str,
    target_tokens: int = TARGET_TOKENS,
) -> list[Chunk]:
    """Chunk a structured JSON extraction (xlsx/csv shape:
    ``{"source": ..., "sheets": [{"sheet", "headers", "rows"}]}``).

    Rows are grouped per sheet (never across sheets) so that every chunk
    re-serializes as VALID standalone JSON, with the source, sheet name and
    headers repeated in each chunk for context. Non-conforming JSON becomes a
    single chunk; invalid JSON falls back to text chunking.
    """
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return chunk_text(
            text,
            doc_id=doc_id,
            source_path=source_path,
            sha256=sha256,
            target_tokens=target_tokens,
        )

    def _mk(texts: list[str]) -> list[Chunk]:
        total = len(texts)
        return [
            Chunk(
                doc_id=doc_id,
                chunk_idx=i,
                total_chunks=total,
                source_path=source_path,
                sha256=sha256,
                text=t,
            )
            for i, t in enumerate(texts)
        ]

    if not (isinstance(data, dict) and isinstance(data.get("sheets"), list)):
        return _mk([json.dumps(data, ensure_ascii=False)])

    texts: list[str] = []
    for sheet in data["sheets"]:
        if not isinstance(sheet, dict):
            continue
        base = {
            "source": data.get("source"),
            "sheet": sheet.get("sheet"),
            "headers": sheet.get("headers") or [],
        }
        base_tokens = estimate_tokens(json.dumps(base, ensure_ascii=False))
        rows = list(sheet.get("rows") or [])
        if not rows:
            continue
        group: list = []
        group_tokens = base_tokens
        for row in rows:
            row_tokens = estimate_tokens(json.dumps(row, ensure_ascii=False))
            if group and group_tokens + row_tokens > target_tokens:
                texts.append(json.dumps({**base, "rows": group}, ensure_ascii=False))
                group, group_tokens = [], base_tokens
            group.append(row)
            group_tokens += row_tokens
        if group:
            texts.append(json.dumps({**base, "rows": group}, ensure_ascii=False))

    return _mk(texts)
