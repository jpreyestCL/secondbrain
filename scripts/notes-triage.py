#!/usr/bin/env python3
"""Layered triage for exported Apple Notes: decide what deserves the graph.

Nothing is ever deleted. This script only *labels* notes so that
``notes-apply.py`` can copy the keepers into a folder ready for ``brain scan``.

Two layers:

  Layer 0 -- deterministic, free, no LLM. Catches the obvious noise:
             ``vacio``, ``casi_vacio``, ``solo_url``, ``solo_numeros``,
             ``duplicado_exacto`` (content hash; the oldest copy survives).
             Every note gets an explicit reason.
             A note whose content came from an attachment (front-matter
             ``attachments_text_chars`` > 0: OCR of a photo/scan or a decoded
             Apple table) is NEVER ``vacio``/``casi_vacio`` -- that text is the
             note. Every note also carries a ``tiene_adjuntos`` signal.

  Layer 1 -- LLM triage in BATCHES (default 40 notes per call, title + first
             400 chars each) against an OpenAI-compatible endpoint using
             ``json_schema`` structured output. Each note gets
             ``decision`` (guardar|descartar|dudoso), ``dominio``,
             ``doc_date`` (only if the text itself states one) and a short
             ``razon``. Resumable via a JSONL checkpoint: re-running only
             sends the batches that are still missing.

The judgement criterion handed to the model is NOT "is this well written" but
"is this a fact about my life I would want to retrieve later". A note like
``banco santander 157260 78137000-2`` looks like garbage and is gold.

Output: ``triage.json`` (machine) + ``triage.md`` (human review, grouped by
decision) in the ``--work`` directory.

    scripts/notes-triage.py --in /tmp/notas-export                # layer 0 only
    scripts/notes-triage.py --in /tmp/notas-export --llm --dry-run  # show batch 1
    scripts/notes-triage.py --in /tmp/notas-export --llm            # spend calls

Standard library only. Config via env (same names as the rest of the project):
``OPENAI_API_KEY``, ``OPENAI_API_URL``, ``MODEL_NAME``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DOMAINS = ["personal", "salud", "finanzas", "trabajo", "proyectos"]
DECISIONS = ["guardar", "descartar", "dudoso"]

URL_RE = re.compile(r"^(https?://|www\.)\S+$", re.I)
LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)


# --------------------------------------------------------------------------
# input
# --------------------------------------------------------------------------


def parse_markdown(path):
    """Read a note exported by notes-export.py -> (meta dict, body str)."""
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    meta = {}
    body = text
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            for line in text[4:end].split("\n"):
                if ":" in line:
                    key, _, value = line.partition(":")
                    value = value.strip()
                    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
                        value = value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
                    meta[key.strip()] = value
            body = text[end + 5 :]
    return meta, body.strip()


_FLOW_ITEM = re.compile(r'"((?:[^"\\]|\\.)*)"')


def parse_flow_list(value):
    """``["a", "b"]`` (as written by notes-export.py) -> ['a', 'b']."""
    value = (value or "").strip()
    if not value.startswith("["):
        return []
    return [
        m.group(1).replace('\\"', '"').replace("\\\\", "\\")
        for m in _FLOW_ITEM.finditer(value)
    ]


def load_notes(indir):
    notes = []
    for name in sorted(os.listdir(indir)):
        if not name.endswith(".md"):
            continue
        path = os.path.join(indir, name)
        meta, body = parse_markdown(path)
        try:
            att_chars = int(meta.get("attachments_text_chars") or 0)
        except ValueError:
            att_chars = 0
        notes.append(
            {
                "file": name,
                "path": os.path.abspath(path),
                "title": meta.get("title", ""),
                "created": meta.get("created", ""),
                "modified": meta.get("modified", ""),
                "note_id": meta.get("note_id", ""),
                "attachments": parse_flow_list(meta.get("attachments")),
                "attachments_text_chars": att_chars,
                "body": body,
            }
        )
    return notes


# --------------------------------------------------------------------------
# layer 0
# --------------------------------------------------------------------------


def normalized(text):
    return re.sub(r"\s+", " ", text).strip().lower()


def layer0(notes, min_chars=15):
    """Annotate each note with layer0 = reason string, or None if it survives."""
    seen = {}
    for note in notes:
        body = note["body"]
        # Apple repeats the title as the first body line, but not always. The
        # tests below run on title + body TOGETHER: the title often carries all
        # the meaning ("banco santander" + a bare account number is a real
        # financial datum, not `solo_numeros`).
        title = (note["title"] or "").strip()
        first = body.partition("\n")[0].strip()
        content = body if (title and first == title) else (title + "\n" + body).strip()
        flat = normalized(content)

        # An image-only note (a passport scan, an ID card, an Apple table) has
        # no typed text: everything it says was recovered by notes-export.py
        # from its attachments. That text counts as content, so the emptiness
        # tests below must not fire for it.
        has_attachment_text = (note.get("attachments_text_chars") or 0) > 0
        # Tables live in the DB, not on disk, so they contribute text without
        # any copied file: the note still "has attachments".
        note["tiene_adjuntos"] = bool(note.get("attachments")) or has_attachment_text

        if not flat and not has_attachment_text:
            note["layer0"] = "vacio"
        elif len(flat) < min_chars and not has_attachment_text:
            note["layer0"] = "casi_vacio"
        elif flat and all(URL_RE.match(tok) for tok in flat.split()):
            note["layer0"] = "solo_url"
        elif flat and not LETTER_RE.search(flat):
            note["layer0"] = "solo_numeros"
        else:
            note["layer0"] = None

        note["content"] = content
        digest = hashlib.sha256(flat.encode("utf-8")).hexdigest()
        note["hash"] = digest
        if note["layer0"] is None:
            if digest in seen:
                note["layer0"] = "duplicado_exacto"
                note["duplicate_of"] = seen[digest]
            else:
                seen[digest] = note["file"]
    return notes


# --------------------------------------------------------------------------
# layer 1 (LLM)
# --------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "Eres el filtro de entrada del 'second brain' de una persona: un grafo de "
    "conocimiento donde se guardan hechos de su vida (personales, de salud, "
    "financieros, laborales y de proyectos) para poder recuperarlos años "
    "despues.\n\n"
    "Recibes notas sueltas de Apple Notes, muchas escritas a la rapida. "
    "Para cada una decides si entra al grafo.\n\n"
    "EL CRITERIO NO ES si la nota esta bien escrita, ni si es larga, ni si se "
    "entiende sola. El criterio es: '¿esto es un DATO DE SU VIDA que querria "
    "recuperar mas adelante?'.\n\n"
    "guardar   -> hechos, datos y decisiones concretas: numeros de cuenta, "
    "rut, direcciones, contactos, precios acordados, resultados medicos, "
    "credenciales de servicios (que existen y donde), decisiones de proyecto, "
    "notas de reuniones, pretensiones de sueldo, tramites. Una nota corta y "
    "cripitica como 'banco santander 157260 78137000-2' ES guardar: es un dato "
    "bancario real.\n"
    "descartar -> ruido sin valor recuperable: pruebas de teclado, un numero "
    "suelto sin contexto ni etiqueta, listas de compras triviales de hace "
    "años, texto copiado de internet sin relacion con su vida, borradores "
    "ilegibles sin ningun dato.\n"
    "dudoso    -> cuando no puedes decidir con lo que ves. Usalo sin miedo: "
    "el humano revisara los dudosos. Ante la duda entre guardar y descartar, "
    "responde dudoso.\n\n"
    "dominio: el area a la que pertenece el dato "
    "(personal, salud, finanzas, trabajo, proyectos).\n"
    "doc_date: SOLO si el TEXTO menciona explicitamente una fecha a la que se "
    "refiere el contenido (formato YYYY-MM-DD, o YYYY-MM / YYYY si es "
    "parcial). Si no la menciona, cadena vacia. NO inventes ni copies la "
    "fecha de creacion de la nota.\n"
    "razon: maximo 12 palabras, en español.\n\n"
    "Responde con un objeto JSON con la lista 'notas', un elemento por cada "
    "nota recibida, en el mismo orden y con el mismo 'id'."
)

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "notas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "decision": {"type": "string", "enum": DECISIONS},
                    "dominio": {"type": "string", "enum": DOMAINS},
                    "doc_date": {"type": "string"},
                    "razon": {"type": "string"},
                },
                "required": ["id", "decision", "dominio", "doc_date", "razon"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["notas"],
    "additionalProperties": False,
}


# Rule #2 in CLAUDE.md: secrets never leave in the clear. The exported .md
# files stay local (and `brain`'s redact.py cleans them before the graph), but
# the triage excerpt is POSTed to a third-party endpoint, so it is scrubbed
# first. Only notes that talk about credentials are touched, so real data like
# "banco santander 157260 78137000-2" survives intact.
# This runs on the WHOLE body, which now includes the OCR of the attachments,
# so a password photographed in a screenshot is redacted the same way a typed
# one is. Identity numbers (RUT, passport, serial) are NOT credentials: they
# stay in the note and, unless the note also mentions clave/token/etc., they
# are not redacted either.
CREDENTIAL_CONTEXT = re.compile(
    r"(clave|contrase[nñ]a|password|passwd|\bpin\b|token|api[_ -]?key|secret|"
    r"credencial)",
    re.I,
)
SECRET_TOKEN = re.compile(r"\b(?=\S*[A-Za-z])(?=\S*\d)\S{8,}\b")


def redact_excerpt(title, body):
    if not CREDENTIAL_CONTEXT.search(title + "\n" + body):
        return body
    return SECRET_TOKEN.sub("[REDACTADO]", body)


# In an image-only note the first 400 chars are the excerpt's whole budget, so
# the per-file `### 31D682B4-....jpg` headings are dropped: they are UUIDs, they
# say nothing, and they would push the actual OCR text out of the window. The
# `## Texto reconocido de adjuntos` heading stays -- the model should know the
# text came from an OCR and may have recognition errors.
ATTACH_FILE_HEADING = re.compile(r"^### .*$", re.M)


def excerpt(note, max_chars=400):
    body = note["body"]
    first, _, rest = body.partition("\n")
    if note["title"] and first.strip() == note["title"].strip():
        body = rest.strip()
    if note.get("attachments_text_chars"):
        body = ATTACH_FILE_HEADING.sub("", body)
    body = re.sub(r"\n{2,}", "\n", body)
    body = redact_excerpt(note["title"] or "", body)
    if len(body) > max_chars:
        body = body[:max_chars] + "…"
    return body


def render_batch(batch):
    parts = []
    for idx, note in batch:
        created = (note.get("created") or "")[:10]
        parts.append(
            "### %d\nTitulo: %s\nNota creada: %s\nTexto:\n%s"
            % (idx, note["title"] or "(sin titulo)", created or "?", excerpt(note))
        )
    return (
        "Clasifica estas %d notas. Devuelve exactamente %d elementos en 'notas'.\n\n"
        % (len(batch), len(batch))
    ) + "\n\n".join(parts)


def build_payload(batch, model):
    return {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": render_batch(batch)},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "triage_notas",
                "strict": True,
                "schema": RESPONSE_SCHEMA,
            },
        },
    }


def post_chat(api_url, api_key, payload, timeout=180, retries=3):
    url = api_url.rstrip("/") + "/chat/completions"
    data = json.dumps(payload).encode("utf-8")
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer %s" % api_key,
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:400]
            last = "HTTP %s: %s" % (exc.code, body)
            if exc.code not in (408, 409, 429) and exc.code < 500:
                break
        except Exception as exc:  # noqa: BLE001 - network flakiness
            last = str(exc)
        time.sleep(2 ** attempt)
    raise RuntimeError("LLM call failed: %s" % last)


def load_env_file(path):
    """Populate os.environ from a .env file (existing vars always win)."""
    if not path or not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def read_checkpoint(path):
    done = {}
    if not path or not os.path.exists(path):
        return done
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("file"):
                done[row["file"]] = row
    return done


def layer1(notes, args):
    pending = [n for n in notes if n["layer0"] is None]
    checkpoint = read_checkpoint(args.checkpoint)
    todo = [n for n in pending if n["file"] not in checkpoint]

    batches = [
        list(enumerate(todo[i : i + args.batch_size]))
        for i in range(0, len(todo), args.batch_size)
    ]
    # Re-key indices so ids are 1..n inside each batch.
    batches = [[(i + 1, n) for i, (_, n) in enumerate(b)] for b in batches]

    print(
        "layer 1: %d notas pendientes, %d ya en checkpoint, %d por clasificar "
        "-> %d llamadas de %d notas"
        % (len(pending), len(pending) - len(todo), len(todo), len(batches), args.batch_size)
    )

    if not batches:
        return checkpoint, 0

    if args.dry_run:
        payload = build_payload(batches[0], args.model)
        print("\n=== DRY RUN: endpoint ===")
        print("POST %s/chat/completions" % args.api_url.rstrip("/"))
        print("model: %s   temperature: 0" % args.model)
        print("\n=== DRY RUN: payload que se enviaria (batch 1/%d) ===" % len(batches))
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        print("\n=== DRY RUN: coste ===")
        print(
            "llamadas totales: %d  |  notas: %d  |  chars aprox del user prompt: %d"
            % (len(batches), len(todo), len(payload["messages"][1]["content"]))
        )
        return checkpoint, 0

    if not args.api_key:
        raise SystemExit("OPENAI_API_KEY no definida (ni --api-key)")

    calls = 0
    ckpt_fh = open(args.checkpoint, "a", encoding="utf-8") if args.checkpoint else None
    try:
        for number, batch in enumerate(batches, 1):
            payload = build_payload(batch, args.model)
            response = post_chat(args.api_url, args.api_key, payload, args.timeout)
            calls += 1
            content = response["choices"][0]["message"]["content"]
            try:
                parsed = json.loads(content)
            except ValueError:
                print("  batch %d: respuesta no-JSON, se reintenta luego" % number,
                      file=sys.stderr)
                continue
            by_id = {int(r.get("id", -1)): r for r in parsed.get("notas", [])}
            hits = 0
            for idx, note in batch:
                row = by_id.get(idx)
                if not row:
                    continue
                hits += 1
                record = {
                    "file": note["file"],
                    "decision": row.get("decision", "dudoso"),
                    "dominio": row.get("dominio", "personal"),
                    "doc_date": (row.get("doc_date") or "").strip(),
                    "razon": row.get("razon", ""),
                }
                if record["decision"] not in DECISIONS:
                    record["decision"] = "dudoso"
                if record["dominio"] not in DOMAINS:
                    record["dominio"] = "personal"
                checkpoint[note["file"]] = record
                if ckpt_fh:
                    ckpt_fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            if ckpt_fh:
                ckpt_fh.flush()
            usage = response.get("usage") or {}
            print(
                "  batch %d/%d: %d/%d clasificadas (tokens %s)"
                % (number, len(batches), hits, len(batch), usage.get("total_tokens", "?"))
            )
    finally:
        if ckpt_fh:
            ckpt_fh.close()
    return checkpoint, calls


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------


def build_result(notes, llm):
    out = []
    for note in notes:
        row = {
            "file": note["file"],
            "path": note["path"],
            "title": note["title"],
            "created": note["created"],
            "note_id": note["note_id"],
            "chars": len(note["body"]),
            "hash": note["hash"],
            "tiene_adjuntos": bool(note.get("tiene_adjuntos")),
            "adjuntos": note.get("attachments") or [],
            "adjuntos_chars": note.get("attachments_text_chars") or 0,
        }
        if note["layer0"] is not None:
            row["layer"] = 0
            row["decision"] = "descartar"
            row["razon"] = note["layer0"]
            row["dominio"] = None
            row["doc_date"] = ""
            if note.get("duplicate_of"):
                row["duplicate_of"] = note["duplicate_of"]
        else:
            hit = llm.get(note["file"])
            if hit:
                row["layer"] = 1
                row["decision"] = hit["decision"]
                row["razon"] = hit["razon"]
                row["dominio"] = hit["dominio"]
                row["doc_date"] = hit.get("doc_date", "")
            else:
                row["layer"] = 1
                row["decision"] = "sin_clasificar"
                row["razon"] = "layer 1 no ejecutada"
                row["dominio"] = None
                row["doc_date"] = ""
        out.append(row)
    return out


def write_markdown(rows, path, sample=40):
    groups = {}
    for row in rows:
        groups.setdefault(row["decision"], []).append(row)

    lines = ["# Triage de notas de Apple Notes", ""]
    lines.append("Total: **%d** notas." % len(rows))
    lines.append("")
    lines.append("| decision | notas |")
    lines.append("|---|---:|")
    for key in ("guardar", "dudoso", "descartar", "sin_clasificar"):
        if key in groups:
            lines.append("| %s | %d |" % (key, len(groups[key])))
    lines.append("")

    with_att = [r for r in rows if r.get("tiene_adjuntos")]
    if with_att:
        recovered = [r for r in with_att if r.get("adjuntos_chars")]
        lines += [
            "## Adjuntos",
            "",
            "| señal | notas |",
            "|---|---:|",
            "| tiene_adjuntos | %d |" % len(with_att),
            "| con texto recuperado (OCR / tabla) | %d |" % len(recovered),
            "| adjuntos copiados | %d |" % sum(len(r.get("adjuntos") or []) for r in rows),
            "",
        ]

    reasons = {}
    for row in rows:
        if row["layer"] == 0:
            reasons[row["razon"]] = reasons.get(row["razon"], 0) + 1
    if reasons:
        lines += ["## Layer 0 (deterministico)", "", "| motivo | notas |", "|---|---:|"]
        for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
            lines.append("| %s | %d |" % (reason, count))
        lines.append("")

    lines += [
        "## Que revisar",
        "",
        "1. **dudoso**: revisar todos y mover a guardar/descartar editando "
        "`triage.json` (campo `decision`).",
        "2. **descartar**: revisar la muestra de abajo para detectar falsos "
        "negativos.",
        "3. Luego: `scripts/notes-apply.py --triage <work>/triage.json --out "
        "<carpeta>`.",
        "",
    ]

    for key in ("dudoso", "guardar", "descartar", "sin_clasificar"):
        items = groups.get(key)
        if not items:
            continue
        shown = items if key == "dudoso" else items[:sample]
        lines.append("## %s (%d)%s" % (key, len(items),
                                       "" if len(shown) == len(items)
                                       else " — muestra de %d" % len(shown)))
        lines.append("")
        lines.append("| archivo | fecha | titulo | adj | dominio | doc_date | razon |")
        lines.append("|---|---|---|---|---|---|---|")
        for row in shown:
            lines.append(
                "| `%s` | %s | %s | %s | %s | %s | %s |"
                % (
                    row["file"],
                    (row["created"] or "")[:10],
                    (row["title"] or "").replace("|", "/")[:60],
                    ("%d" % len(row.get("adjuntos") or [])) if row.get("tiene_adjuntos") else "",
                    row.get("dominio") or "",
                    row.get("doc_date") or "",
                    (row.get("razon") or "").replace("|", "/"),
                )
            )
        lines.append("")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--in", dest="indir", default="/tmp/notas-export",
                        help="directory produced by notes-export.py")
    parser.add_argument("--work", default="/tmp/notas-triage",
                        help="where triage.json / triage.md / checkpoint go")
    parser.add_argument("--min-chars", type=int, default=15,
                        help="layer 0: below this many chars -> casi_vacio")
    parser.add_argument("--llm", action="store_true", help="run layer 1")
    parser.add_argument("--dry-run", action="store_true",
                        help="with --llm: print the first batch and spend nothing")
    parser.add_argument("--batch-size", type=int, default=40)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--model", default=None, help="default: $MODEL_NAME")
    parser.add_argument("--api-url", default=None, help="default: $OPENAI_API_URL")
    parser.add_argument("--api-key", default=None, help="default: $OPENAI_API_KEY")
    parser.add_argument("--env-file", default=os.path.join(REPO_ROOT, ".env"),
                        help="file to read OPENAI_* / MODEL_NAME from")
    parser.add_argument("--checkpoint", default=None,
                        help="default: <work>/checkpoint.jsonl")
    args = parser.parse_args(argv)

    load_env_file(args.env_file)
    args.model = args.model or os.environ.get("MODEL_NAME") or "meta/llama-3.1-8b-instruct"
    args.api_url = args.api_url or os.environ.get("OPENAI_API_URL") or \
        "https://integrate.api.nvidia.com/v1"
    args.api_key = args.api_key or os.environ.get("OPENAI_API_KEY") or ""

    if not os.path.isdir(args.indir):
        raise SystemExit("no existe el directorio de entrada: %s" % args.indir)
    os.makedirs(args.work, exist_ok=True)
    if not args.checkpoint:
        args.checkpoint = os.path.join(args.work, "checkpoint.jsonl")

    notes = load_notes(args.indir)
    layer0(notes, args.min_chars)

    counts = {}
    for note in notes:
        counts[note["layer0"] or "pendiente_llm"] = \
            counts.get(note["layer0"] or "pendiente_llm", 0) + 1
    with_att = sum(1 for n in notes if n.get("tiene_adjuntos"))
    with_text = sum(1 for n in notes if (n.get("attachments_text_chars") or 0) > 0)
    print("notas leidas: %d" % len(notes))
    print("con adjuntos: %d (con texto recuperado: %d)" % (with_att, with_text))
    print("layer 0:")
    for reason, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print("  %-20s %d" % (reason, count))

    llm = {}
    calls = 0
    if args.llm:
        llm, calls = layer1(notes, args)
        if args.dry_run:
            return 0
    else:
        llm = read_checkpoint(args.checkpoint)

    rows = build_result(notes, llm)
    json_path = os.path.join(args.work, "triage.json")
    md_path = os.path.join(args.work, "triage.md")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "schema_version": 1,
                "source_dir": os.path.abspath(args.indir),
                "domains": DOMAINS,
                "llm_calls": calls,
                "notes": rows,
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )
    write_markdown(rows, md_path)

    final = {}
    for row in rows:
        final[row["decision"]] = final.get(row["decision"], 0) + 1
    print("decisiones: %s" % json.dumps(final, ensure_ascii=False))
    if calls:
        print("llamadas LLM en esta corrida: %d" % calls)
    print("escrito: %s" % json_path)
    print("escrito: %s" % md_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
