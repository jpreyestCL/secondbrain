"""`brain` CLI — second brain ingestion pipeline."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.table import Table

from . import __version__
from .chunker import chunk_text
from .classify import apply_manifest, emit_manifest
from .config import Config, load_config
from .extract import ExtractError, SkipFile, extract_file
from .ledger import Ledger
from .redact import redact

console = Console()
log = logging.getLogger("brain")

app = typer.Typer(
    name="brain",
    help="Ingestion pipeline: scan -> extract -> classify -> chunk -> ingest-graph.",
    no_args_is_help=True,
    pretty_exceptions_show_locals=False,
)

SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv"}


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(message)s",
        datefmt="[%X]",
        handlers=[RichHandler(console=console, rich_tracebacks=True, show_path=False)],
        force=True,
    )


_tenant_override: Optional[str] = None


@app.callback()
def _main(
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Debug logging"),
    tenant: Optional[str] = typer.Option(
        None, "--tenant", help="Tenant to operate on (overrides config.toml)"
    ),
) -> None:
    global _tenant_override
    _tenant_override = tenant
    _setup_logging(verbose)


def _open() -> tuple[Config, Ledger]:
    cfg = load_config(tenant=_tenant_override)
    log.debug("tenant=%s graph=%s", cfg.tenant, cfg.graph_database)
    return cfg, Ledger(cfg.ledger_path)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# -- scan --------------------------------------------------------------------


@app.command()
def scan(folder: Path = typer.Argument(..., exists=True, file_okay=False, resolve_path=True)) -> None:
    """Walk FOLDER, hash every file and upsert it into the ledger."""
    cfg, ledger = _open()
    counts = {"new": 0, "changed": 0, "unchanged": 0}
    with ledger:
        for path in sorted(folder.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            if any(part in SKIP_DIRS or part.startswith(".") for part in path.parts[:-1]):
                continue
            stat = path.stat()
            outcome, doc_id = ledger.upsert_file(
                str(path), sha256_file(path), stat.st_size, stat.st_mtime
            )
            counts[outcome] += 1
            if outcome != "unchanged":
                log.info("[%s] %s -> %s", outcome, path, doc_id)
    console.print(
        f"scan done: {counts['new']} new, {counts['changed']} changed "
        f"(old versions marked for expiry), {counts['unchanged']} unchanged"
    )


# -- extract -----------------------------------------------------------------


@app.command()
def extract() -> None:
    """Extract text/JSON from every pending file into ~/.brain/extracted/."""
    cfg, ledger = _open()
    counts = {"extracted": 0, "skipped": 0, "errors": 0}
    with ledger:
        for row in list(ledger.by_status("pending")):
            path = Path(row.path)
            if not path.exists():
                ledger.set_status(row.doc_id, "error", error="file missing on disk")
                counts["errors"] += 1
                continue
            try:
                content, kind = extract_file(path)
            except SkipFile as exc:
                ledger.set_status(row.doc_id, "skipped", error=str(exc))
                counts["skipped"] += 1
                log.info("[skip] %s (%s)", path, exc)
                continue
            except (ExtractError, Exception) as exc:  # noqa: BLE001
                ledger.set_status(row.doc_id, "error", error=str(exc)[:500])
                counts["errors"] += 1
                log.error("[error] %s: %s", path, exc)
                continue
            suffix = ".json" if kind == "json" else ".txt"
            out = cfg.extracted_dir / f"{row.doc_id}{suffix}"
            out.write_text(content, encoding="utf-8")
            ledger.set_status(row.doc_id, "extracted")
            counts["extracted"] += 1
            log.info("[ok] %s -> %s", path.name, out.name)
    console.print(
        f"extract done: {counts['extracted']} extracted, "
        f"{counts['skipped']} skipped, {counts['errors']} errors"
    )


# -- classify ----------------------------------------------------------------


@app.command()
def classify(
    apply: Optional[Path] = typer.Option(
        None, "--apply", exists=True, dir_okay=False, help="Completed manifest to apply"
    ),
) -> None:
    """Emit a classification work manifest (no LLM calls), or apply one back.

    Without --apply: writes ~/.brain/work/classify-<batch>.json for Claude Code
    to fill in. With --apply FILE: reads the completed manifest and updates
    the ledger (domain, doc_type, doc_date, sensitivity flags).
    """
    cfg, ledger = _open()
    with ledger:
        if apply is not None:
            counts = apply_manifest(cfg, ledger, apply)
            console.print(
                f"classify --apply: {counts['applied']} applied, "
                f"{counts['skipped']} still unfilled, {counts['errors']} errors"
            )
            return
        out = emit_manifest(cfg, ledger)
    if out is None:
        console.print("nothing to classify (no docs in status=extracted)")
    else:
        console.print(f"manifest written: [bold]{out}[/bold]")
        console.print("Fill it in (e.g. with Claude Code), then run: brain classify --apply", out.name)


# -- chunk -------------------------------------------------------------------


@app.command()
def chunk() -> None:
    """Chunk extracted text of classified (or extracted) docs into ~/.brain/chunks/."""
    cfg, ledger = _open()
    n_docs = n_chunks = 0
    with ledger:
        rows = list(ledger.by_status("classified")) + list(ledger.by_status("extracted"))
        for row in rows:
            src = cfg.extracted_dir / f"{row.doc_id}.txt"
            if not src.exists():
                src = cfg.extracted_dir / f"{row.doc_id}.json"
            if not src.exists():
                log.warning("no extracted content for %s", row.doc_id)
                continue
            chunks = chunk_text(
                src.read_text(encoding="utf-8", errors="replace"),
                doc_id=row.doc_id,
                source_path=row.path,
                sha256=row.sha256,
            )
            out = cfg.chunks_dir / f"{row.doc_id}.json"
            out.write_text(
                json.dumps([c.to_dict() for c in chunks], ensure_ascii=False, indent=1),
                encoding="utf-8",
            )
            n_docs += 1
            n_chunks += len(chunks)
    console.print(f"chunk done: {n_chunks} chunks across {n_docs} docs")


# -- ingest-graph ------------------------------------------------------------


@app.command("ingest-graph")
def ingest_graph(
    doc_id: Optional[list[str]] = typer.Option(None, "--doc-id", help="Limit to specific doc_ids"),
) -> None:
    """Push chunks of classified docs to Graphiti (FalkorDB) as episodes."""
    from .graph import GraphConfigError, ingest_chunks

    cfg, ledger = _open()
    try:
        with ledger:
            counts = asyncio.run(ingest_chunks(cfg, ledger, doc_id or None))
    except GraphConfigError as exc:
        console.print(f"[red]config error:[/red] {exc}")
        raise typer.Exit(2)
    console.print(
        f"ingest-graph done: {counts['docs']} docs, {counts['episodes']} episodes, "
        f"{counts['errors']} errors"
    )


# -- status ------------------------------------------------------------------


@app.command()
def status() -> None:
    """Ledger summary."""
    cfg, ledger = _open()
    with ledger:
        rows = ledger.status_summary()
        pending_exp = len(ledger.pending_expiry_episodes())
    table = Table(title=f"brain ledger — {cfg.ledger_path}")
    table.add_column("status")
    table.add_column("superseded")
    table.add_column("files", justify="right")
    table.add_column("bytes", justify="right")
    for r in rows:
        table.add_row(
            r["status"], "yes" if r["superseded"] else "", str(r["n"]), str(r["bytes"] or 0)
        )
    console.print(table)
    if pending_exp:
        console.print(
            f"[yellow]{pending_exp} episodes pending expiry[/yellow] — run "
            "`brain expire <doc_id>` for superseded docs"
        )


# -- expire ------------------------------------------------------------------


@app.command()
def expire(doc_id: str = typer.Argument(..., help="doc_id whose episodes to expire")) -> None:
    """Remove a doc's episodes from Graphiti and mark them expired in the ledger.

    graphiti-core supports hard removal (Graphiti.remove_episode); there is no
    soft-invalidate API, so supersession is implemented as removal + ledger
    audit trail.
    """
    from .graph import GraphConfigError, expire_doc

    cfg, ledger = _open()
    try:
        with ledger:
            removed = asyncio.run(expire_doc(cfg, ledger, doc_id))
    except GraphConfigError as exc:
        console.print(f"[red]config error:[/red] {exc}")
        raise typer.Exit(2)
    console.print(f"expired {removed} episodes for doc {doc_id}")


@app.command()
def version() -> None:
    """Print version."""
    console.print(f"brain_ingest {__version__}")


if __name__ == "__main__":
    app()
