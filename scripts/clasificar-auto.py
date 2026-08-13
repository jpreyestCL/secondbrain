#!/usr/bin/env python3
"""Rellena el manifiesto de `brain classify` sin usar un LLM.

Envoltorio de `brain_ingest.autoclas`, que es donde viven las heuristicas.
Normalmente no hace falta usarlo: `brain add` y `brain classify --auto` hacen
lo mismo. Existe para el caso en que quieras revisar y reprocesar un
manifiesto por separado.

    scripts/clasificar-auto.py ~/.brain/<tenant>/work/classify-<batch>.json
"""

from __future__ import annotations

import argparse
import json
import sys

sys.path.insert(0, __file__.rsplit("/", 2)[0] + "/ingest/src")

from brain_ingest.autoclas import clasificar, fiables  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("manifiesto")
    ap.add_argument("--dominio", help="fuerza el dominio de todos los documentos")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with open(args.manifiesto, encoding="utf-8") as fh:
        m = json.load(fh)
    origenes = clasificar(m, args.dominio)
    total = len(m["documents"])
    ok = fiables(origenes)

    print(f"{total} documentos\n\nde dónde salió la fecha:")
    for k, v in sorted(origenes.items(), key=lambda kv: -kv[1]):
        print(f"  {str(k):<22} {v:>5}")
    print(f"\n  fecha fiable: {ok}/{total} ({100 * ok // max(total, 1)}%)")

    if args.dry_run:
        print("\n--dry-run: no se escribió nada")
        return 0
    with open(args.manifiesto, "w", encoding="utf-8") as fh:
        json.dump(m, fh, ensure_ascii=False, indent=1)
    print(f"\nmanifiesto actualizado. Siguiente:\n  brain classify --apply {args.manifiesto}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
