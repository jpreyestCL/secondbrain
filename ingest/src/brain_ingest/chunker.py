"""Structural chunking of extracted text.

Text is split into blocks on markdown headings and blank lines (paragraphs).
Blocks are packed into chunks of roughly ``target_tokens`` (default 1200) with
about ``overlap_tokens`` (default 150) of trailing context repeated at the
start of the next chunk. A paragraph is never split in half — an oversized
single paragraph becomes its own chunk.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

TARGET_TOKENS = 1200
OVERLAP_TOKENS = 150

_HEADING_RE = re.compile(r"^#{1,6}\s", re.MULTILINE)


def estimate_tokens(text: str) -> int:
    """Cheap token estimate: ~4 characters per token (English/Spanish prose)."""
    return max(1, len(text) // 4)


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
