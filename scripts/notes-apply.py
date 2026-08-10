#!/usr/bin/env python3
"""Apply a reviewed triage: build the folder that goes into ``brain scan``.

Reads ``triage.json`` (produced and then hand-reviewed by ``notes-triage.py``)
and copies **only** the notes whose ``decision`` is ``guardar`` into ``--out``.
Nothing is deleted: the full export stays where it is.

Two extra jobs, so the same decision is never made twice:

* Each copied note gets ``dominio`` and ``doc_date`` added to its YAML
  front-matter (``doc_date`` falls back to the note's creation date, which is
  what must end up as Graphiti's ``reference_time`` -- rule #1 in CLAUDE.md).
* ``--prefill`` writes ``prefill.json`` keyed by absolute output path, and
  ``--merge-manifest`` takes the manifest that ``brain classify`` emits and
  fills in ``domain`` / ``doc_type`` / ``doc_date`` / ``sensitivity_flags`` for
  every document whose ``path`` matches one of those notes.

Typical flow:

    scripts/notes-apply.py --triage /tmp/notas-triage/triage.json \\
                           --out ~/notas-guardar
    cd ingest && uv run brain scan ~/notas-guardar && uv run brain extract
    uv run brain classify                       # emits classify-<batch>.json
    scripts/notes-apply.py --triage /tmp/notas-triage/triage.json \\
        --merge-manifest ~/.brain/jpreyest/work/classify-<batch>.json
    cd ingest && uv run brain classify --apply ~/.brain/.../classify-<batch>.json

Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys

DOMAIN_SENSITIVITY = {
    "salud": ["medical"],
    "finanzas": ["financial"],
}

CREDENTIAL_HINTS = re.compile(
    r"\b(clave|contrase[nñ]a|password|passwd|pin|token|api[_ -]?key|usuario)\b", re.I
)
RUT_RE = re.compile(r"\b\d{1,2}\.?\d{3}\.?\d{3}[-‐]?[\dkK]\b")


def read_triage(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if data.get("schema_version") != 1:
        raise SystemExit("triage.json: schema_version %r no soportada"
                         % data.get("schema_version"))
    return data


def split_front_matter(text):
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            return text[4:end], text[end + 5 :]
    return "", text


def sensitivity_for(row, body):
    flags = list(DOMAIN_SENSITIVITY.get(row.get("dominio") or "", []))
    blob = (row.get("title") or "") + "\n" + body
    if CREDENTIAL_HINTS.search(blob):
        flags.append("credentials")
    if RUT_RE.search(blob):
        flags.append("pii")
    return sorted(set(flags))


def doc_date_for(row):
    date = (row.get("doc_date") or "").strip()
    if date:
        return date
    created = (row.get("created") or "").strip()
    return created[:10] if created else ""


def yaml_quote(value):
    return '"' + str(value or "").replace("\\", "\\\\").replace('"', '\\"') + '"'


def apply(args):
    data = read_triage(args.triage)
    include = {d.strip() for d in args.include.split(",") if d.strip()}
    selected = [r for r in data["notes"] if r.get("decision") in include]

    counts = {}
    for row in data["notes"]:
        counts[row.get("decision")] = counts.get(row.get("decision"), 0) + 1
    print("triage: %s" % json.dumps(counts, ensure_ascii=False))
    print("seleccionadas (%s): %d" % (args.include, len(selected)))

    if not selected:
        print("nada que copiar", file=sys.stderr)
        return 1

    prefill = {}
    copied = 0
    missing = []

    if not args.dry_run:
        os.makedirs(args.out, exist_ok=True)

    for row in selected:
        src = row["path"]
        if not os.path.exists(src):
            missing.append(src)
            continue
        dest = os.path.join(os.path.abspath(args.out), row["file"])

        with open(src, "r", encoding="utf-8") as fh:
            text = fh.read()
        front, body = split_front_matter(text)
        date = doc_date_for(row)
        flags = sensitivity_for(row, body)
        extra = [
            "dominio: %s" % yaml_quote(row.get("dominio") or ""),
            "doc_date: %s" % yaml_quote(date),
            "doc_type: %s" % yaml_quote(args.doc_type),
        ]
        if flags:
            extra.append("sensitivity_flags: [%s]" % ", ".join(flags))
        new_text = "---\n" + front.rstrip("\n") + "\n" + "\n".join(extra) + "\n---\n" + body

        prefill[dest] = {
            "domain": row.get("dominio"),
            "doc_type": args.doc_type,
            "doc_date": date or None,
            "sensitivity_flags": flags,
            "note_id": row.get("note_id"),
            "title": row.get("title"),
        }

        if not args.dry_run:
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(new_text)
        copied += 1

    print("copiadas: %d%s" % (copied, " (dry-run)" if args.dry_run else ""))
    if missing:
        print("no encontradas en disco: %d (ej: %s)" % (len(missing), missing[0]))

    no_domain = sum(1 for v in prefill.values() if not v["domain"])
    if no_domain:
        print("sin dominio asignado: %d (brain classify las dejara pendientes)"
              % no_domain)

    if args.prefill and not args.dry_run:
        # Never inside --out: that folder is fed to `brain scan` and a stray
        # JSON there would be ingested as if it were a note.
        path = (
            args.prefill
            if args.prefill != "-"
            else os.path.join(os.path.dirname(os.path.abspath(args.triage)),
                              "prefill.json")
        )
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"schema_version": 1, "documents": prefill}, fh,
                      ensure_ascii=False, indent=2)
        print("prefill: %s" % path)

    if args.merge_manifest:
        merge_manifest(args.merge_manifest, prefill, args.manifest_out, args.dry_run)

    if not args.dry_run:
        print("listo. siguiente paso:")
        print("  cd ingest && uv run brain scan %s" % os.path.abspath(args.out))
    return 0


def merge_manifest(manifest_path, prefill, out_path, dry_run):
    """Fill domain/doc_type/doc_date/sensitivity in a `brain classify` manifest."""
    with open(manifest_path, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    if manifest.get("schema_version") != 1:
        raise SystemExit("manifest: schema_version %r no soportada"
                         % manifest.get("schema_version"))
    by_path = {os.path.abspath(k): v for k, v in prefill.items()}
    by_name = {os.path.basename(k): v for k, v in prefill.items()}

    filled = 0
    untouched = 0
    for doc in manifest.get("documents", []):
        path = os.path.abspath(doc.get("path", ""))
        hit = by_path.get(path) or by_name.get(os.path.basename(path))
        if not hit:
            untouched += 1
            continue
        doc["domain"] = hit["domain"]
        doc["doc_type"] = hit["doc_type"]
        doc["doc_date"] = hit["doc_date"]
        doc["sensitivity_flags"] = hit["sensitivity_flags"]
        filled += 1

    target = out_path or manifest_path
    print("manifest: %d documentos rellenados, %d intactos" % (filled, untouched))
    if dry_run:
        print("(dry-run: no se escribio %s)" % target)
        return
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print("manifest escrito: %s" % target)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--triage", required=True, help="triage.json ya revisado")
    parser.add_argument("--out", default=os.path.expanduser("~/notas-guardar"),
                        help="carpeta destino para brain scan")
    parser.add_argument("--include", default="guardar",
                        help="decisiones a copiar, separadas por coma "
                             "(ej: guardar,dudoso)")
    parser.add_argument("--doc-type", default="nota",
                        help="doc_type para el manifest (default: nota)")
    parser.add_argument("--prefill", nargs="?", const="-", default=None,
                        help="escribe prefill.json (default: <out>/prefill.json)")
    parser.add_argument("--merge-manifest",
                        help="ruta del classify-<batch>.json de `brain classify`")
    parser.add_argument("--manifest-out",
                        help="escribir el manifest fusionado aqui en vez de in-place")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    return apply(args)


if __name__ == "__main__":
    sys.exit(main())
