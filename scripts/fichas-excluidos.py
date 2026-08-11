#!/usr/bin/env python3
"""Genera una ficha por cada documento que NO entra al grafo.

Por qué existe: hay archivos que no conviene ingerir crudos. Un libro contable
de 50.000 filas se parte en decenas de miles de episodios que ahogan el grafo
con asientos sueltos y cuestan cientos de dólares, sin aportar un solo hecho
consultable. Pero dejarlos fuera del todo tampoco sirve: el grafo entonces no
sabe siquiera que existen.

La salida intermedia es una ficha: un resumen corto y determinista de QUÉ es el
archivo (entidad, período, estructura, totales) más la ruta exacta del original.
Así el grafo puede responder "el balance 2023 de Inversiones Linets existe,
cubre tal período y está en tal ruta", y para el detalle se abre el archivo.

Las fichas se generan sin LLM: todo sale de la estructura del archivo ya
extraído, así que no cuestan nada y no inventan.

Uso:
    scripts/fichas-excluidos.py --tenant jpreyest --out ~/fichas-sociedades
    cd ingest && uv run brain --tenant jpreyest scan ~/fichas-sociedades
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

# Encabezados que suelen contener importes; se totalizan para dar una magnitud.
COL_MONTO = re.compile(
    r"\b(monto|importe|total|debe|haber|saldo|cargo|abono|valor|precio|"
    r"amount|debit|credit|balance|payment|charge)\b",
    re.I,
)
FECHA = re.compile(r"(?<!\d)(20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])(?!\d)")
NUMERO = re.compile(r"^-?[\d.,]+$")

MAX_COLUMNAS = 25
MAX_MUESTRA = 5


def a_numero(v: str) -> float | None:
    """Convierte '1.234.567,89' o '1,234,567.89' a float. None si no es número."""
    s = (v or "").strip().replace(" ", "").replace("$", "")
    if not s or not NUMERO.match(s):
        return None
    # El separador decimal es el ÚLTIMO signo que aparece; el otro es de miles.
    if "," in s and "." in s:
        dec = max(s.rfind(","), s.rfind("."))
        s = s[:dec].replace(",", "").replace(".", "") + "." + s[dec + 1 :]
    elif "," in s:
        s = s.replace(",", ".") if s.count(",") == 1 and len(s.split(",")[-1]) <= 2 else s.replace(",", "")
    else:
        partes = s.split(".")
        if len(partes) > 2 or (len(partes) == 2 and len(partes[-1]) == 3):
            s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def resumir_tabular(datos: dict) -> list[str]:
    """Describe un archivo de hojas de cálculo ya extraído a JSON."""
    lineas: list[str] = []
    fechas: list[str] = []
    for hoja in datos.get("sheets", []):
        headers = [h for h in (hoja.get("headers") or []) if str(h).strip()]
        filas = hoja.get("rows") or []
        lineas.append(f"\n### Hoja «{hoja.get('sheet')}» — {len(filas)} filas")
        if headers:
            recorte = headers[:MAX_COLUMNAS]
            sufijo = f" (+{len(headers) - MAX_COLUMNAS} columnas más)" if len(headers) > MAX_COLUMNAS else ""
            lineas.append("Columnas: " + ", ".join(str(h).strip() for h in recorte) + sufijo)

        # Totales de las columnas que parecen importes: dan la magnitud del
        # archivo sin volcar su contenido.
        totales: dict[str, float] = {}
        for idx, h in enumerate(hoja.get("headers") or []):
            if not COL_MONTO.search(str(h) or ""):
                continue
            suma = 0.0
            cuenta = 0
            for fila in filas:
                if idx < len(fila) and (x := a_numero(str(fila[idx]))) is not None:
                    suma += x
                    cuenta += 1
            if cuenta:
                totales[str(h).strip()] = suma
        for h, s in list(totales.items())[:6]:
            lineas.append(f"Suma de «{h}»: {s:,.2f} ({len(filas)} filas)")

        for fila in filas:
            for celda in fila:
                if m := FECHA.search(str(celda)):
                    fechas.append(m.group(0).replace("/", "-").replace(".", "-"))

        if filas:
            lineas.append("Primeras filas:")
            for fila in filas[:MAX_MUESTRA]:
                lineas.append("  | " + " | ".join(str(c)[:40] for c in fila[:8]))

    if fechas:
        lineas.insert(0, f"Período cubierto: {min(fechas)} a {max(fechas)}")
    return lineas


def resumir_texto(texto: str) -> list[str]:
    """Describe un documento de texto (cartola o balance en PDF)."""
    limpio = " ".join(texto.split())
    fechas = sorted({m.group(0).replace("/", "-") for m in FECHA.finditer(limpio)})
    lineas = []
    if fechas:
        lineas.append(f"Período cubierto: {fechas[0]} a {fechas[-1]}")
    lineas.append(f"Extensión: {len(limpio):,} caracteres")
    lineas.append("\n### Inicio del documento")
    lineas.append(limpio[:1200])
    return lineas


def explicacion(motivo: str) -> str:
    """Texto de cabecera segun POR QUE se excluyo el documento.

    Importa que sea el correcto: la ficha entra al grafo como hecho, y decir
    que un borrador de contrato es "un archivo de datos tabulares" seria
    guardar una afirmacion falsa.
    """
    if "borrador" in (motivo or ""):
        return (
            "Este documento NO está ingerido en el grafo: es un **borrador**, superado "
            "por la versión firmada. Se deja fuera a propósito, porque las cifras y "
            "plazos de los borradores contradicen los del documento definitivo y el "
            "grafo no tendría cómo saber cuál manda. Lo que sigue es su descripción; "
            "para el detalle hay que abrir el archivo original."
        )
    return (
        "Este documento NO está ingerido en el grafo: es un archivo de datos tabulares "
        "o contables, y volcarlo produciría miles de asientos sueltos en vez de hechos "
        "consultables. Lo que sigue es su descripción; para el detalle hay que abrir el "
        "archivo original."
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tenant", default="jpreyest")
    ap.add_argument("--out", required=True, help="carpeta donde escribir las fichas")
    ap.add_argument("--brain-home", default=os.path.expanduser("~/.brain"))
    args = ap.parse_args()

    base = Path(args.brain_home) / args.tenant
    con = sqlite3.connect(base / "ledger.sqlite")
    con.row_factory = sqlite3.Row
    filas = con.execute(
        """select path, doc_id, doc_type, doc_date, domain, error
             from files
            where status='skipped' and error like 'fuera del grafo%'
            order by path"""
    ).fetchall()
    if not filas:
        print("No hay documentos marcados 'fuera del grafo'.", file=sys.stderr)
        return 1

    out = Path(os.path.expanduser(args.out))
    out.mkdir(parents=True, exist_ok=True)
    extraidos = base / "extracted"
    hechas = 0
    sin_extraccion = 0
    tipos: Counter = Counter()

    for f in filas:
        origen = Path(f["path"])
        fuente = None
        for cand in (extraidos / f"{f['doc_id']}.json", extraidos / f"{f['doc_id']}.txt"):
            if cand.exists():
                fuente = cand
                break
        if fuente is None:
            sin_extraccion += 1
            continue

        crudo = fuente.read_text(encoding="utf-8", errors="replace")
        if fuente.suffix == ".json":
            try:
                cuerpo = resumir_tabular(json.loads(crudo))
            except json.JSONDecodeError:
                cuerpo = resumir_texto(crudo)
        else:
            cuerpo = resumir_texto(crudo)

        tipos[f["doc_type"] or "?"] += 1
        ficha = out / f"{f['doc_id']}.md"
        ficha.write_text(
            "\n".join(
                [
                    "---",
                    f"titulo: {origen.name}",
                    f"dominio: {f['domain'] or 'finanzas'}",
                    f"doc_date: {f['doc_date'] or ''}",
                    "---",
                    "",
                    f"# Ficha de archivo: {origen.name}",
                    "",
                    explicacion(f["error"]),
                    "",
                    f"- **Archivo original**: `{origen}`",
                    f"- **Carpeta**: {origen.parent.name}",
                    f"- **Tipo**: {f['doc_type'] or 'documento'}",
                    f"- **Fecha del documento**: {f['doc_date'] or 'sin determinar'}",
                    f"- **Motivo de exclusión**: {f['error']}",
                    "",
                    "## Contenido",
                    *cuerpo,
                    "",
                ]
            ),
            encoding="utf-8",
        )
        hechas += 1

    print(f"fichas escritas: {hechas} en {out}")
    if sin_extraccion:
        print(f"sin texto extraído (omitidos): {sin_extraccion}")
    for k, v in tipos.most_common():
        print(f"  {k:<26} {v}")
    print(f"\nsiguiente paso:\n  cd ingest && uv run brain --tenant {args.tenant} scan {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
