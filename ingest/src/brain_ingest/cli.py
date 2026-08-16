"""`brain` CLI — second brain ingestion pipeline."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import typer
from rich.console import Console
from rich.logging import RichHandler
from rich.table import Table

from . import __version__
from .chunker import chunk_json, chunk_text
from .classify import apply_manifest, emit_manifest
from .config import Config, load_config
from .extract import ExtractError, SkipFile, esta_en_la_nube, extract_file
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


def _lote() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


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


def _falkordb_configurado(cfg: Config) -> bool:
    """¿Hay algún dato para hablar directo con FalkorDB?

    Sirve para distinguir "el usuario administra el servidor y quiere la vía
    directa" de "recién instaló y no ha hecho `brain login`". Sin esto, el
    segundo caso terminaba en un error de autenticación de Redis.
    """
    import os
    import tomllib

    from .config import brain_home

    if any(
        os.environ.get(v)
        for v in ("FALKORDB_HOST", "FALKORDB_TENANT_PASSWORD", "FALKORDB_PASSWORD")
    ):
        return True
    ruta = brain_home() / "config.toml"
    if not ruta.exists():
        return False
    try:
        datos = tomllib.loads(ruta.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError:
        return False
    return bool(datos.get("falkordb_tenant_password"))


def _open() -> tuple[Config, Ledger]:
    cfg = load_config(tenant=_tenant_override)
    log.debug("tenant=%s graph=%s", cfg.tenant, cfg.graph_database)
    return cfg, Ledger(cfg.ledger_path)


#: Errores que NO significan "el archivo esta roto", sino "todavia no esta
#: aqui": en iCloud Drive (y en cualquier montaje de red) el archivo figura en
#: el listado pero su contenido vive en la nube, y el primer intento de leerlo
#: solo DISPARA la descarga. Errno 60 es ETIMEDOUT; 35 es EAGAIN.
_ERRORES_DESCARGA = {35, 60, 89, 116}


def es_archivo_en_la_nube(path: Path) -> bool:
    """¿El archivo esta listado pero su contenido no esta en disco?

    macOS marca asi los archivos evictados por "Optimizar almacenamiento": el
    tamaño logico es el real, pero no ocupan bloques.
    """
    try:
        st = path.stat()
    except OSError:
        return False
    return st.st_size > 0 and st.st_blocks == 0


def sha256_file(path: Path, intentos: int = 3) -> str:
    """Hash del archivo, reintentando si esta descargandose desde la nube.

    El primer intento suele fallar con ETIMEDOUT porque solo pone en marcha la
    descarga; los siguientes la encuentran ya en curso o terminada.
    """
    ultimo: OSError | None = None
    for intento in range(intentos):
        h = hashlib.sha256()
        try:
            with path.open("rb") as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
            return h.hexdigest()
        except OSError as exc:
            if exc.errno not in _ERRORES_DESCARGA:
                raise
            ultimo = exc
            if intento < intentos - 1:
                # Espera creciente: la descarga puede tardar segundos.
                time.sleep(2 * (intento + 1))
                log.info("downloading from the cloud: %s (attempt %d)", path.name, intento + 2)
    raise ultimo if ultimo else OSError(f"no se pudo leer {path}")


# -- scan --------------------------------------------------------------------


@app.command()
def scan(
    folder: Path = typer.Argument(..., exists=True, file_okay=False, resolve_path=True),
    excluir: Optional[list[str]] = typer.Option(
        None,
        "--exclude", "--excluir",
        help="Folder to skip (repeatable). E.g. --exclude _Duplicados --exclude drafts",
    ),
) -> dict:
    """Walk FOLDER, hash every file and upsert it into the ledger.

    Devuelve el resumen para que `add` sepa si la carpeta quedo COMPLETA: un
    archivo que no se pudo leer no esta en el ledger, y sin este dato `add`
    diria "ya esta todo guardado" cuando en realidad faltan documentos.
    """
    cfg, ledger = _open()
    counts = {
        "new": 0, "changed": 0, "unchanged": 0,
        "ilegibles": 0, "excluidos": 0, "retirados": 0,
    }
    en_la_nube: list[Path] = []
    with ledger:
        for path in sorted(folder.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            if any(part in SKIP_DIRS or part.startswith(".") for part in path.parts[:-1]):
                continue
            if excluir and any(e in path.parts[:-1] for e in excluir):
                counts["excluidos"] += 1
                # No basta con no registrarlo: si ya estaba de una corrida
                # anterior, seguiria pendiente de enviar y --excluir no
                # ahorraria nada. Se retira explicitamente.
                if ledger.retirar(str(path)):
                    counts["retirados"] += 1
                continue
            try:
                stat = path.stat()
                digest = sha256_file(path)
            except OSError as exc:
                if exc.errno in _ERRORES_DESCARGA or es_archivo_en_la_nube(path):
                    # No es un archivo roto: esta en iCloud y no se alcanzo a
                    # descargar. Antes se descartaba en silencio y no quedaba
                    # registro, asi que era imposible saber que faltaba ni
                    # reintentarlo.
                    en_la_nube.append(path)
                else:
                    log.warning("skipping %s (unreadable): %s", path, exc)
                    counts["ilegibles"] += 1
                continue
            outcome, doc_id = ledger.upsert_file(
                str(path), digest, stat.st_size, stat.st_mtime
            )
            counts[outcome] += 1
            if outcome != "unchanged":
                log.info("[%s] %s -> %s", outcome, path, doc_id)
    console.print(
        f"scan done: {counts['new']} new, {counts['changed']} changed "
        f"(old versions marked for expiry), {counts['unchanged']} unchanged"
    )
    if counts["excluidos"]:
        extra = (
            f", {counts['retirados']} of them removed from the queue"
            if counts["retirados"]
            else ""
        )
        console.print(f"{counts['excluidos']} file(s) skipped by --exclude{extra}")
    if counts["ilegibles"]:
        console.print(f"[yellow]{counts['ilegibles']} unreadable file(s), skipped[/yellow]")
    if en_la_nube:
        # Se listan de verdad: dejar que pasen como un warning entre cientos de
        # lineas es como perderlos.
        console.print(
            f"\n[yellow]{len(en_la_nube)} file(s) are in iCloud, not on your disk[/yellow], "
            f"so they were NOT ingested. To download them and retry:\n"
            f"  [bold]find '{folder}' -type f -exec brctl download {{}} \\;[/bold]\n"
            f"  (or open them in Finder and wait for the cloud icon to go away)\n"
            f"then run the same command again. The first ones:"
        )
        for p in en_la_nube[:5]:
            console.print(f"  · {p.name}")
        if len(en_la_nube) > 5:
            console.print(f"  · … and {len(en_la_nube) - 5} more")
    return {**counts, "en_la_nube": len(en_la_nube)}


# -- extract -----------------------------------------------------------------


@app.command()
def extract() -> None:
    """Extract text/JSON from every pending file into ~/.brain/extracted/."""
    cfg, ledger = _open()
    counts = {"extracted": 0, "skipped": 0, "errors": 0, "en_la_nube": 0}
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
                motivo = str(exc)
                # Estos mensajes vienen de las librerias y no dicen nada util:
                # se traducen a la causa real, que casi siempre es una de dos.
                if "closed or encrypted" in motivo:
                    ledger.set_status(
                        row.doc_id, "skipped", error="password-protected PDF"
                    )
                    counts["skipped"] += 1
                    log.info("[protected] %s", path.name)
                    continue
                if esta_en_la_nube(path):
                    ledger.set_status(
                        row.doc_id,
                        "pending",
                        error="in iCloud; download it and run the command again",
                    )
                    counts["en_la_nube"] = counts.get("en_la_nube", 0) + 1
                    log.info("[in the cloud] %s", path.name)
                    continue
                try:
                    detalle = f" [{path.stat().st_size} bytes]"
                except OSError:
                    detalle = ""
                ledger.set_status(row.doc_id, "error", error=(motivo + detalle)[:500])
                counts["errors"] += 1
                log.error("[error] %s%s: %s", path.name, detalle, motivo[:160])
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
    if counts.get("en_la_nube"):
        console.print(
            f"[yellow]{counts['en_la_nube']} file(s) are still in iCloud[/yellow] and were left "
            f"pending, not lost: download them and run the same command again."
        )


# -- classify ----------------------------------------------------------------


@app.command()
def classify(
    apply: Optional[Path] = typer.Option(
        None, "--apply", exists=True, dir_okay=False, help="Completed manifest to apply"
    ),
    auto: bool = typer.Option(
        False, "--auto", help="Fill in and apply the manifest unattended (no LLM)"
    ),
    dominio: Optional[str] = typer.Option(None, "--domain", "--dominio", help="Force the domain"),
) -> None:
    """Emit a classification work manifest (no LLM calls), or apply one back.

    Without --apply: writes ~/.brain/work/classify-<batch>.json for Claude Code
    to fill in. With --apply FILE: reads the completed manifest and updates
    the ledger (domain, doc_type, doc_date, sensitivity flags).

    With --auto the CLI fills it in itself using deterministic heuristics
    (brain_ingest.autoclas) and applies it: no LLM, no human step.
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
        if out is not None and auto:
            _clasificar_auto(cfg, ledger, out, dominio)
            return
    if out is None:
        console.print("nothing to classify (no docs in status=extracted)")
    else:
        console.print(f"manifest written: [bold]{out}[/bold]")
        console.print("Fill it in (e.g. with Claude Code), then run: brain classify --apply", out.name)


def _clasificar_auto(cfg: Config, ledger: Ledger, manifiesto: Path, dominio: str | None) -> None:
    """Rellena el manifiesto con las heurísticas y lo aplica de inmediato."""
    from .autoclas import clasificar, fiables

    datos = json.loads(manifiesto.read_text(encoding="utf-8"))
    origenes = clasificar(datos, dominio)
    manifiesto.write_text(json.dumps(datos, ensure_ascii=False, indent=1), encoding="utf-8")

    total = len(datos["documents"])
    ok = fiables(origenes)
    console.print(f"classified {total} documents (reliable date on {ok})")
    for k, v in sorted(origenes.items(), key=lambda kv: -kv[1]):
        console.print(f"  {str(k):<24} {v}")
    imprecisos = total - ok
    if imprecisos:
        # No es un detalle menor: una fecha inventada entra al grafo como hecho.
        console.print(
            f"[yellow]{imprecisos} with an imprecise date[/yellow] (year only, or the file's "
            f"date). Worth reviewing before you rely on them."
        )
    counts = apply_manifest(cfg, ledger, manifiesto)
    console.print(f"applied: {counts['applied']}, errors: {counts['errors']}")


# -- add ---------------------------------------------------------------------


@app.command()
def add(
    folder: Path = typer.Argument(..., exists=True, file_okay=False, resolve_path=True),
    dominio: Optional[str] = typer.Option(None, "--domain", "--dominio", help="Force the domain"),
    revisar: bool = typer.Option(
        False, "--review", "--revisar", help="Stop before sending, so you can review the classification"
    ),
    rehacer: bool = typer.Option(
        False,
        "--redo", "--rehacer",
        help="Send already-sent documents again (after wiping the graph or changing extraction)",
    ),
    url: Optional[str] = typer.Option(None, "--url", help="MCP server URL (if you have not run login)"),
    excluir: Optional[list[str]] = typer.Option(
        None, "--exclude", "--excluir", help="Folder to skip (repeatable): duplicates, drafts…"
    ),
    destilar_en: Optional[list[str]] = typer.Option(
        None,
        "--distill", "--destilar",
        help="Folder whose documents Claude condenses into facts instead of sending raw (repeatable)",
    ),
) -> None:
    """Ingest a whole folder: one command from start to finish.

    Equivalent to scan -> extract -> classify --auto -> chunk -> ingest-graph.
    The stages still exist separately because each records its result in the
    ledger: if OCR over hundreds of PDFs dies halfway, or the send fails, the
    retry resumes where it stopped instead of redoing everything. Driving them
    by hand adds nothing, so this is the normal path.
    """
    if rehacer:
        # Sin esto, la unica forma de reingerir era un DELETE a mano sobre el
        # ledger, que es exactamente lo que la regla 5 del proyecto prohibe.
        cfg, ledger = _open()
        with ledger:
            n = ledger.rehacer(str(folder))
        console.print(
            f"redo: {n['documentos']} document(s) back in the queue "
            f"({n['episodios']} send(s) forgotten). The graph and your files were not touched."
        )
    resumen = scan(folder, excluir=excluir)
    faltantes = resumen.get("en_la_nube", 0) + resumen.get("ilegibles", 0)

    # Sin esto, `add` sobre una carpeta ya ingerida no hace NADA y no lo dice:
    # se ve igual que un exito. El silencio en un no-op es la misma trampa que
    # el silencio en un fallo.
    cfg, ledger = _open()
    with ledger:
        bajo = [
            f for f in ledger.all_files() if f.path.startswith(str(folder).rstrip("/"))
        ]
    ya = [f for f in bajo if f.status == "ingested" and not f.superseded]
    if bajo and len(ya) == len(bajo):
        if faltantes:
            # Decir "ya está todo" con archivos que no se pudieron leer seria
            # una afirmacion falsa: esos documentos no estan en ninguna parte.
            console.print(
                f"[yellow]Los {len(ya)} documento(s) legibles ya estaban en tu memoria, "
                f"but {faltantes} could not be read[/yellow] (see above), so this "
                f"folder is NOT complete. Fix that and run the same command again."
            )
            return
        console.print(
            f"The {len(ya)} document(s) in this folder are already in your memory and have "
            f"not changed, so there is nothing new to send.\n"
            f"  · added files? run this again, only the new ones are processed\n"
            f"  · wiped the graph or changed extraction? "
            f"[bold]brain add {folder} --redo[/bold]"
        )
        return

    extract()
    classify(apply=None, auto=True, dominio=dominio)
    chunk(destilar=destilar_en)
    if destilar_en:
        _, ledger2 = _open()
        with ledger2:
            quedan = len(list(ledger2.by_status("por-destilar")))
        if quedan:
            console.print(
                f"\n[bold]{quedan} document(s) awaiting distillation.[/bold] Run "
                f"[bold]brain distill[/bold], ask Claude to fill in the manifest and then "
                f"[bold]brain distill --apply <file>[/bold]."
            )
            if not revisar:
                console.print("The rest has been sent.")
    if revisar:
        console.print(
            "\n[bold]Paused before sending.[/bold] Check with `brain status`; when "
            "you are happy:\n  brain ingest-graph"
        )
        return
    ingest_graph(doc_id=None, force=False, via=None, url=url)



# -- chunk -------------------------------------------------------------------


@app.command()
def chunk(
    destilar: Optional[list[str]] = typer.Option(
        None, "--distill", "--destilar", help="Folder whose documents are summarised instead of chunked"
    ),
) -> None:
    """Chunk extracted text of classified (or extracted) docs into ~/.brain/chunks/."""
    cfg, ledger = _open()
    n_docs = n_chunks = n_destilar = 0
    with ledger:
        rows = list(ledger.by_status("classified")) + list(ledger.by_status("extracted"))
        for row in rows:
            if destilar and any(e in Path(row.path).parts[:-1] for e in destilar):
                # No se trocea: lo condensara Claude. Enviar el texto crudo de
                # estas carpetas es lo caro y lo que menos aporta.
                ledger.set_status(row.doc_id, "por-destilar")
                n_destilar += 1
                continue
            src = cfg.extracted_dir / f"{row.doc_id}.txt"
            if not src.exists():
                src = cfg.extracted_dir / f"{row.doc_id}.json"
            if not src.exists():
                log.warning("no extracted content for %s", row.doc_id)
                continue
            chunker = chunk_json if src.suffix == ".json" else chunk_text
            chunks = chunker(
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
    if n_destilar:
        console.print(f"{n_destilar} document(s) marked for distilling")


# -- ingest-graph ------------------------------------------------------------


@app.command("ingest-graph")
def ingest_graph(
    doc_id: Optional[list[str]] = typer.Option(None, "--doc-id", help="Limit to specific doc_ids"),
    force: bool = typer.Option(
        False, "--force", help="Also process superseded/already-ingested doc_ids"
    ),
    via: Optional[str] = typer.Option(
        None,
        "--via",
        help="mcp (through the connector; the default once you run `brain login`) | "
             "falkordb (straight to the database, needs server admin)",
    ),
    url: Optional[str] = typer.Option(
        None, "--url", help="MCP gateway URL, e.g. https://mybrain.rlz.cl/mcp"
    ),
) -> None:
    """Push chunks of classified docs to Graphiti as episodes.

    Por defecto escribe directo a FalkorDB, lo que exige alcanzarlo por red.
    Con `--via mcp --url <gateway>/mcp` se empuja por el conector MCP
    autenticado: no necesita SSH ni configurar modelos, porque los pone el
    servidor.
    """
    from .graph import GraphConfigError, ingest_chunks

    cfg, ledger = _open()

    # Por defecto se usa el conector MCP si hay servidor configurado. Es el
    # camino que NO necesita ninguna clave de LLM en este equipo: la extraccion
    # la hace el servidor. Solo se cae a FalkorDB si no hay servidor.
    destino = url or cfg.mcp_url
    if via is None:
        via = "mcp" if destino else "falkordb"
    if via == "falkordb" and not destino and not _falkordb_configurado(cfg):
        # Un usuario recien instalado no tiene ni servidor ni credenciales de la
        # base. Antes caia a FalkorDB y reventaba con un error de Redis, que no
        # dice que hacer; el paso que falta es vincularse con el servidor.
        console.print(
            "[yellow]This machine is not linked to a server yet.[/yellow]\n\n"
            "  [bold]brain login https://mybrain.rlz.cl[/bold]\n\n"
            "The browser opens once and that is it. No API key needed:\n"
            "the server does the extraction with its own models."
        )
        raise typer.Exit(2)
    if via not in ("falkordb", "mcp"):
        console.print(f"[red]invalid --via:[/red] {via} (use 'mcp' or 'falkordb')")
        raise typer.Exit(2)
    if via == "mcp" and not destino:
        console.print(
            "[red]No server configured.[/red] Run this first:\n"
            "  [bold]brain login https://mybrain.rlz.cl[/bold]\n"
            "or pass --url. Without a server the only alternative is --via falkordb, "
            "which needs direct database access."
        )
        raise typer.Exit(2)
    remoto = None
    if via == "mcp":
        from .mcp_remote import McpRemoteError, conectar

        parsed = urlparse(destino)
        base = f"{parsed.scheme}://{parsed.netloc}"
        try:
            remoto = conectar(base, cfg.tenant, cfg.home, path=parsed.path or "/mcp")
        except McpRemoteError as exc:
            console.print(f"[red]could not connect to the MCP server:[/red] {exc}")
            raise typer.Exit(2)
        console.print(f"connected to {base} as tenant [bold]{cfg.tenant}[/bold]")

    try:
        with ledger:
            counts = asyncio.run(
                ingest_chunks(cfg, ledger, doc_id or None, force=force, remoto=remoto)
            )
    except GraphConfigError as exc:
        console.print(f"[red]config error:[/red] {exc}")
        raise typer.Exit(2)
    console.print(
        f"ingest-graph done: {counts['docs']} docs, {counts['episodes']} episodes, "
        f"{counts['errors']} errors, {counts['skipped']} skipped"
    )


# -- login -------------------------------------------------------------------


@app.command()
def login(
    url: str = typer.Argument(..., help="Server URL, e.g. https://mybrain.rlz.cl"),
) -> None:
    """Link this machine to a server and store the session.

    This is all you need before ingesting: extraction happens on the server
    with ITS models, so no LLM API key is configured here. Opens the browser
    to authenticate with your account.
    """
    import tomllib

    from .config import brain_home
    from .mcp_remote import McpRemoteError, conectar

    limpia = url.rstrip("/")
    if not limpia.startswith(("http://", "https://")):
        limpia = f"https://{limpia}"
    if not limpia.endswith("/mcp"):
        limpia += "/mcp"

    cfg, _ = _open()
    parsed = urlparse(limpia)
    base = f"{parsed.scheme}://{parsed.netloc}"
    try:
        cliente = conectar(base, cfg.tenant, cfg.home, path=parsed.path)
        herramientas = cliente.herramientas()
    except McpRemoteError as exc:
        console.print(f"[red]could not connect:[/red] {exc}")
        raise typer.Exit(2)

    # Se guarda en config.toml para no tener que repetir --url en cada comando.
    ruta = brain_home() / "config.toml"
    texto = ruta.read_text(encoding="utf-8")
    datos = tomllib.loads(texto)
    linea = f'mcp_url = "{limpia}"'
    if datos.get("mcp_url"):
        texto = "\n".join(
            linea if l.strip().startswith("mcp_url") else l for l in texto.splitlines()
        ) + "\n"
    else:
        texto = texto.rstrip("\n") + f"\n\n{linea}\n"
    ruta.write_text(texto, encoding="utf-8")

    console.print(f"connected to [bold]{base}[/bold] ({len(herramientas)} tools)")
    console.print(f"space: [bold]{cfg.tenant}[/bold]")
    console.print("done: `brain ingest-graph` now sends to this server, with no local API keys.")


# -- destilar ----------------------------------------------------------------


DESTILAR_INSTRUCCIONES = (
    "For each document, replace `hechos: []` with the list of concrete facts it contains, "
    "as complete self-contained sentences (each must stand on its own). Keep proper names, "
    "amounts, dates, percentages and identifiers exactly as they appear. Do NOT interpret "
    "or add opinions. If a document carries no fact, leave the list empty and it will be "
    "skipped. Then run: brain distill --apply <file>"
)


@app.command("distill")
def destilar(
    apply: Optional[Path] = typer.Option(
        None, "--apply", exists=True, dir_okay=False, help="Completed manifest"
    ),
) -> None:
    """Emit (or apply) the distillation manifest.

    Distilling means Claude condenses the document into facts and those facts
    are sent instead of the raw text: far cheaper, because the graph's cost is
    proportional to the text. In exchange you lose the literal wording — which
    is why it only happens in folders named with `--distill`, never by default.
    """
    cfg, ledger = _open()
    with ledger:
        if apply is not None:
            datos = json.loads(apply.read_text(encoding="utf-8"))
            hechos_total = omitidos = 0
            for d in datos.get("documents", []):
                fila = ledger.get(d["doc_id"])
                if fila is None:
                    continue
                hechos = [h.strip() for h in (d.get("hechos") or []) if str(h).strip()]
                if not hechos:
                    ledger.set_status(d["doc_id"], "skipped", error="distilled with no facts")
                    omitidos += 1
                    continue
                # Los hechos se guardan como los fragmentos del documento: de
                # ahi en adelante el pipeline es identico al normal.
                chunks = [
                    {
                        "doc_id": d["doc_id"],
                        "chunk_idx": i,
                        "total_chunks": len(hechos),
                        "text": h,
                        "source_path": fila.path,
                        "sha256": fila.sha256,
                        "destilado": True,
                    }
                    for i, h in enumerate(hechos)
                ]
                (cfg.chunks_dir / f"{d['doc_id']}.json").write_text(
                    json.dumps(chunks, ensure_ascii=False, indent=1), encoding="utf-8"
                )
                ledger.set_status(d["doc_id"], "classified")
                hechos_total += len(hechos)
            console.print(
                f"distill --apply: {hechos_total} fact(s) across {len(datos.get('documents', []))} "
                f"document(s), {omitidos} with no content"
            )
            console.print("next: [bold]brain ingest-graph[/bold]")
            return

        pendientes = [f for f in ledger.by_status("por-destilar")]
        if not pendientes:
            console.print("nothing to distill")
            return
        salida = cfg.work_dir / f"destilar-{_lote()}.json"
        docs = []
        for fila in pendientes:
            origen = cfg.extracted_dir / f"{fila.doc_id}.txt"
            if not origen.exists():
                origen = cfg.extracted_dir / f"{fila.doc_id}.json"
            texto = origen.read_text(encoding="utf-8", errors="replace") if origen.exists() else ""
            # Se acota: el manifiesto tiene que caber en una sesion.
            docs.append(
                {
                    "doc_id": fila.doc_id,
                    "path": fila.path,
                    "doc_date": fila.doc_date,
                    "domain": fila.domain,
                    "texto": redact(texto[:12000]).text,
                    "truncado": len(texto) > 12000,
                    "hechos": [],
                }
            )
        salida.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "instructions": DESTILAR_INSTRUCCIONES,
                    "documents": docs,
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        console.print(f"distill manifest: [bold]{salida}[/bold]")
        console.print(f"{len(docs)} document(s). {DESTILAR_INSTRUCCIONES}")


# -- status ------------------------------------------------------------------


@app.command()
def status() -> None:
    """Ledger summary."""
    cfg, ledger = _open()
    with ledger:
        rows = ledger.status_summary()
        pending_exp = len(ledger.pending_expiry_episodes())
        pending_docs = ledger.docs_pending_expiry()
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
            f"[yellow]{pending_exp} episodes pending expiry[/yellow] across "
            f"{len(pending_docs)} docs — run `brain expire --all` (or "
            "`brain expire <doc_id>`):"
        )
        for d in pending_docs:
            console.print(f"  {d}")


# -- expire ------------------------------------------------------------------


@app.command()
def expire(
    doc_id: Optional[str] = typer.Argument(None, help="doc_id whose episodes to expire"),
    expire_all: bool = typer.Option(
        False, "--all", help="Expire every doc with pending_expiry episodes"
    ),
) -> None:
    """Remove a doc's episodes from Graphiti and mark them expired in the ledger.

    graphiti-core supports hard removal (Graphiti.remove_episode); there is no
    soft-invalidate API, so supersession is implemented as removal + ledger
    audit trail. With --all, every doc that has pending_expiry episodes is
    expired in one batch.
    """
    from .graph import GraphConfigError, expire_doc

    if expire_all == (doc_id is not None):
        console.print("[red]error:[/red] provide exactly one of DOC_ID or --all")
        raise typer.Exit(2)

    cfg, ledger = _open()
    try:
        with ledger:
            if expire_all:
                targets = ledger.docs_pending_expiry()
                if not targets:
                    console.print("nothing to expire (no pending_expiry episodes)")
                    return
                total = 0
                for d in targets:
                    removed = asyncio.run(expire_doc(cfg, ledger, d))
                    console.print(f"expired {removed} episodes for doc {d}")
                    total += removed
                console.print(f"expire --all done: {total} episodes across {len(targets)} docs")
            else:
                removed = asyncio.run(expire_doc(cfg, ledger, doc_id))
                console.print(f"expired {removed} episodes for doc {doc_id}")
    except GraphConfigError as exc:
        console.print(f"[red]config error:[/red] {exc}")
        raise typer.Exit(2)


@app.command()
def version() -> None:
    """Print version."""
    console.print(f"brain_ingest {__version__}")


if __name__ == "__main__":
    app()
