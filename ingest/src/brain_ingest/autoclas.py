#!/usr/bin/env python3
"""Clasificacion automatica del manifiesto: dominio, tipo y fecha REAL.

`brain classify` emite un manifiesto con un registro por documento y espera que
alguien complete dominio, tipo y **fecha real**. Hacerlo con un modelo cuesta
dinero y, para carpetas ordenadas por fecha en el nombre, acierta menos que
leer el propio nombre del archivo.

La fecha es lo que más importa: un grafo temporal alimentado con fechas de
ingesta es inútil (regla de oro 1 en CLAUDE.md). El orden de prioridad aquí
sigue esa regla —contenido y metadatos por sobre `mtime`— pero con una
corrección aprendida a la mala: **el nombre del archivo gana al contenido**.
Un `octubre2023.pdf` que por dentro trae "30/09/2023" en un encabezado es de
octubre; confiar en la primera fecha del texto lo fechaba mal.

Formatos numéricos ambiguos (`12/06/2024`) se descartan a propósito: no hay
forma de saber si son día/mes o mes/día, y una fecha inventada es peor que una
imprecisa marcada como tal.

"""

from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
import re
import sys

MESES = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6,
    "julio": 7, "agosto": 8, "septiembre": 9, "setiembre": 9, "octubre": 10,
    "noviembre": 11, "diciembre": 12,
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
    "ene": 1, "feb": 2, "mar": 3, "abr": 4, "jun": 6, "jul": 7, "ago": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dic": 12,
}
MES_ALT = "|".join(sorted(MESES, key=len, reverse=True))

# Numeros escritos en palabras: las escrituras publicas chilenas fechan asi
# ("a tres de julio del año dos mil veintiseis").
UNI = {
    "un": 1, "uno": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6,
    "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "once": 11, "doce": 12,
    "trece": 13, "catorce": 14, "quince": 15, "dieciseis": 16, "dieciséis": 16,
    "diecisiete": 17, "dieciocho": 18, "diecinueve": 19, "veinte": 20,
    "veintiuno": 21, "veintidos": 22, "veintidós": 22, "veintitres": 23,
    "veintitrés": 23, "veinticuatro": 24, "veinticinco": 25, "veintiseis": 26,
    "veintiséis": 26, "veintisiete": 27, "veintiocho": 28, "veintinueve": 29,
    "treinta": 30, "treinta y uno": 31,
}
ANIOS = {
    f"dos mil {p}": 2000 + v
    for p, v in {
        "veinte": 20, "veintiuno": 21, "veintidos": 22, "veintidós": 22,
        "veintitres": 23, "veintitrés": 23, "veinticuatro": 24,
        "veinticinco": 25, "veintiseis": 26, "veintiséis": 26,
        "veintisiete": 27, "veintiocho": 28,
    }.items()
}
PALABRAS = re.compile(
    rf"\ba\s+({'|'.join(sorted(UNI, key=len, reverse=True))})\s+de\s+({MES_ALT})"
    rf"\s+de[l]?\s+(?:año\s+)?({'|'.join(sorted(ANIOS, key=len, reverse=True))})\b",
    re.I,
)

ISO = re.compile(r"(?<!\d)(20\d{2})[-_./](0[1-9]|1[0-2])[-_./](0[1-9]|[12]\d|3[01])(?!\d)")
DMY = re.compile(r"(?<!\d)(0?[1-9]|[12]\d|3[01])[-_.](0?[1-9]|1[0-2])[-_.](20\d{2})(?!\d)")
ES = re.compile(rf"(?<!\d)(\d{{1,2}})\s+de\s+({MES_ALT})\s+de[l]?\s+(20\d{{2}})", re.I)
EN = re.compile(rf"\b({MES_ALT})\s+(\d{{1,2}}),?\s+(20\d{{2}})", re.I)
# dd/mm/aaaa SOLO cuando dd>12: si no, es indistinguible de mm/dd/aaaa.
DMY_SEGURO = re.compile(r"(?<!\d)(1[3-9]|2\d|3[01])[-_./](0?[1-9]|1[0-2])[-_./](20\d{2})(?!\d)")
MES_PEGADO = re.compile(rf"\b({MES_ALT})[\s_-]*(20\d{{2}})\b", re.I)
ANO_MES = re.compile(rf"\b(20\d{{2}})[\s_-]*({MES_ALT})\b", re.I)
MES_NUM = re.compile(r"(?<!\d)(0[1-9]|1[0-2])[-_.](20\d{2})(?!\d)")
# Convencion de estudios de abogados: "01.16.24" = mes.dia.año.
MM_DD_AA = re.compile(r"(?<!\d)(\d{2})\.(\d{2})\.(\d{2})(?!\d)")
ANO = re.compile(r"(?<!\d)(20[0-2]\d)(?!\d)")

TIPOS = [
    ("escritura", ["escritura"]),
    ("factura", ["factura", "invoice", "boleta"]),
    ("contrato", ["contrato", "agreement", "compraventa", "buyback", "arrendamiento",
                  "lease", "consultor"]),
    ("poder", ["poder", "power of attorney", "mandato"]),
    ("certificado", ["certificado", "certificate", "apostill", "notariz"]),
    ("estatutos", ["estatuto", "articles of association", "bylaw"]),
    ("registro", ["registro", "register", "declaration", "profile report", "incorporation"]),
    ("acta", ["acta", "minutes", "asamblea", "junta", "directorio", "board"]),
    ("cartola", ["cartola", "estado de cuenta", "statement", "movimientos"]),
    ("reconocimiento de deuda", ["reconocimiento de deuda", "pagare", "promissory"]),
    ("declaracion tributaria", ["f29", "f22", "1040", "irs", "sii", "tax", "ein", "renta"]),
    ("balance", ["balance", "estados financieros", "financial statement"]),
    ("examen", ["examen", "laboratorio", "biopsia", "resonancia", "ecograf", "hemograma"]),
    ("receta", ["receta", "prescripcion"]),
    ("boleta", ["boleta"]),
    ("correo", ["correo", "email", "fwd"]),
    ("presentacion", ["presentaci", "deck", "pitch"]),
]

# Palabras de la ruta que delatan el dominio cuando no se fuerza uno.
PISTAS_DOMINIO = [
    ("salud", ["salud", "medic", "clinica", "examen", "laboratorio", "isapre", "receta"]),
    ("finanzas", ["finanza", "banco", "cartola", "factura", "balance", "impuesto", "tax",
                  "sociedad", "inversion", "contrato", "escritura"]),
    ("trabajo", ["trabajo", "empleo", "contrato laboral", "curriculum", "cv"]),
    ("proyectos", ["proyecto", "startup", "producto"]),
]

HOY = datetime.date.today()


def valida(y, m, d=1) -> str | None:
    try:
        f = datetime.date(int(y), int(m), int(d))
    except (ValueError, TypeError):
        return None
    # Una fecha futura no puede ser la de emision; una anterior a 1990 en estas
    # carpetas es casi siempre un numero mal leido.
    return f.isoformat() if datetime.date(1990, 1, 1) <= f <= HOY else None


def del_nombre(nombre: str, carpeta: str):
    for texto in (nombre, carpeta):
        if (x := ISO.search(texto)) and (f := valida(x[1], x[2], x[3])):
            return f, "nombre iso"
        if (x := DMY.search(texto)) and (f := valida(x[3], x[2], x[1])):
            return f, "nombre dmy"
    for texto in (nombre, carpeta):
        if (x := MES_PEGADO.search(texto)) and (f := valida(x[2], MESES[x[1].lower()])):
            return f, "nombre mes+año"
        if (x := ANO_MES.search(texto)) and (f := valida(x[1], MESES[x[2].lower()])):
            return f, "nombre año+mes"
        if (x := MES_NUM.search(texto)) and (f := valida(x[2], x[1])):
            return f, "nombre mm-aaaa"
    base = nombre.rsplit(".", 1)[0].strip().lower()
    if base in MESES and (y := ANO.search(carpeta)) and (f := valida(y[1], MESES[base])):
        return f, "mes + carpeta"
    if x := MM_DD_AA.search(nombre):
        a, b, y = int(x[1]), int(x[2]), 2000 + int(x[3])
        mes, dia = (a, b) if a <= 12 else (b, a)  # el campo >12 solo puede ser el dia
        if f := valida(y, mes, dia):
            return f, "nombre mm.dd.aa"
    return None, None


def del_texto(texto: str) -> str | None:
    texto = texto[:3000]  # el encabezado es donde va la fecha de emision
    if x := PALABRAS.search(texto):
        return valida(ANIOS[x[3].lower()], MESES[x[2].lower()], UNI[x[1].lower()])
    candidatas = []
    for rx, orden in ((ISO, "ymd"), (ES, "dmy"), (EN, "mdy"), (DMY_SEGURO, "dmy")):
        for x in rx.finditer(texto):
            g = x.groups()
            if orden == "ymd":
                f = valida(g[0], g[1], g[2])
            elif orden == "dmy":
                f = valida(g[2], MESES.get(str(g[1]).lower(), g[1]), g[0])
            else:
                f = valida(g[2], MESES[g[0].lower()], g[1])
            if f:
                candidatas.append((x.start(), f))
    return min(candidatas)[1] if candidatas else None


def fecha_de(doc: dict):
    ruta = doc["path"]
    nombre, carpeta = os.path.basename(ruta), os.path.dirname(ruta)
    f, origen = del_nombre(nombre, carpeta)
    if f:
        return f, origen
    if f := del_texto(doc.get("excerpt") or ""):
        return f, "contenido"
    for texto in (nombre, carpeta):
        if (y := ANO.search(texto)) and (f := valida(y[1], 1, 1)):
            return f, "solo año (impreciso)"
    try:
        return datetime.date.fromtimestamp(os.stat(ruta).st_mtime).isoformat(), "mtime (impreciso)"
    except OSError:
        return None, "sin fecha"


def tipo_de(ruta: str) -> str:
    bajo = ruta.lower()
    for nombre, claves in TIPOS:
        if any(k in bajo for k in claves):
            return nombre
    return "documento"


def dominio_de(ruta: str, forzado: str | None, validos: list[str]) -> str:
    if forzado:
        return forzado
    bajo = ruta.lower()
    for dom, claves in PISTAS_DOMINIO:
        if dom in validos and any(k in bajo for k in claves):
            return dom
    return "personal" if "personal" in validos else validos[0]




def clasificar(manifiesto: dict, dominio_forzado: str | None = None) -> dict:
    """Rellena el manifiesto en sitio. Devuelve el conteo por origen de fecha."""
    import collections

    validos = manifiesto.get("domains") or ["personal"]
    origenes: collections.Counter = collections.Counter()
    for d in manifiesto["documents"]:
        fecha, origen = fecha_de(d)
        d["doc_date"] = fecha
        d["doc_type"] = tipo_de(d["path"])
        d["domain"] = dominio_de(d["path"], dominio_forzado, validos)
        d["sensitivity_flags"] = {
            "salud": ["medical"], "finanzas": ["financial"]
        }.get(d["domain"], [])
        origenes[origen] += 1
    return dict(origenes)


def fiables(origenes: dict) -> int:
    return sum(v for k, v in origenes.items() if "impreciso" not in str(k) and k != "sin fecha")
