#!/usr/bin/env python3
"""Resume el gasto de LLM del second brain a partir del log de uso.

El servidor MCP escribe una línea JSON por llamada en `LLM_USAGE_LOG`
(ver el patch en infra/graphiti/patches/factories.py). Este script agrupa por
modelo y por día, y estima el costo con una tabla de precios editable.

Uso:
    python3 scripts/llm-cost.py                       # log local por defecto
    python3 scripts/llm-cost.py --log /ruta/uso.jsonl
    ssh root@servidor 'cat /opt/secondbrain-native/llm-usage.jsonl' \
        | python3 scripts/llm-cost.py --log -

Los precios son USD por 1M de tokens y hay que mantenerlos a mano: no existe
una API pública que los entregue, y quedarse con precios viejos da una cifra
falsamente tranquilizadora. Última revisión: 2026-08.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

# USD por 1M de tokens (entrada, salida).
PRECIOS = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-5-nano": (0.20, 0.80),
    # Los modelos de NVIDIA NIM en capa gratuita no facturan por token.
    "nvidia/": (0.0, 0.0),
    "meta/": (0.0, 0.0),
    "qwen/": (0.0, 0.0),
}


def precio_de(modelo: str) -> tuple[float, float] | None:
    if modelo in PRECIOS:
        return PRECIOS[modelo]
    for prefijo, tarifa in PRECIOS.items():
        if prefijo.endswith("/") and modelo.startswith(prefijo):
            return tarifa
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--log", default="/opt/secondbrain-native/llm-usage.jsonl",
                    help="archivo JSONL de uso; '-' para leer de stdin")
    ap.add_argument("--por-dia", action="store_true", help="desglosar por día")
    args = ap.parse_args()

    fh = sys.stdin if args.log == "-" else None
    if fh is None:
        try:
            fh = open(args.log, encoding="utf-8")
        except FileNotFoundError:
            print(f"No hay log de uso en {args.log}.\n"
                  f"¿Está LLM_USAGE_LOG definido en mcp.env y el MCP reiniciado?", file=sys.stderr)
            return 1

    por_modelo: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    por_dia: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    malformadas = 0

    with fh:
        for linea in fh:
            linea = linea.strip()
            if not linea:
                continue
            try:
                r = json.loads(linea)
            except json.JSONDecodeError:
                malformadas += 1
                continue
            modelo = r.get("model") or "(desconocido)"
            dia = (r.get("ts") or "")[:10]
            for destino in (por_modelo[modelo], por_dia[(dia, modelo)]):
                destino["llamadas"] += 1
                destino["in"] += r.get("prompt_tokens") or 0
                destino["out"] += r.get("completion_tokens") or 0
                destino["seg"] += r.get("seconds") or 0

    if not por_modelo:
        print("Sin llamadas registradas todavía.")
        return 0

    def costo(modelo: str, d: dict[str, float]) -> float | None:
        tarifa = precio_de(modelo)
        if tarifa is None:
            return None
        return d["in"] / 1e6 * tarifa[0] + d["out"] / 1e6 * tarifa[1]

    print(f"{'modelo':<42} {'llam.':>6} {'tok in':>10} {'tok out':>9} {'seg/llam':>9} {'USD':>9}")
    print("-" * 90)
    total = 0.0
    sin_precio = []
    for modelo, d in sorted(por_modelo.items(), key=lambda kv: -kv[1]["llamadas"]):
        c = costo(modelo, d)
        if c is None:
            sin_precio.append(modelo)
        else:
            total += c
        media = d["seg"] / d["llamadas"] if d["llamadas"] else 0
        print(f"{modelo:<42} {int(d['llamadas']):>6} {int(d['in']):>10} {int(d['out']):>9} "
              f"{media:>9.1f} {('—' if c is None else f'{c:>9.4f}')}")
    print("-" * 90)
    print(f"{'TOTAL estimado':<42} {'':>6} {'':>10} {'':>9} {'':>9} {total:>9.4f}")

    if args.por_dia:
        print("\npor día:")
        for (dia, modelo), d in sorted(por_dia.items()):
            c = costo(modelo, d)
            print(f"  {dia}  {modelo:<40} {int(d['llamadas']):>5} llam.  "
                  f"{('—' if c is None else f'USD {c:.4f}')}")

    if sin_precio:
        print(f"\nSin tarifa conocida (no sumados): {', '.join(sorted(set(sin_precio)))}."
              f"\nAgrégalos en PRECIOS dentro de este script.", file=sys.stderr)
    if malformadas:
        print(f"{malformadas} línea(s) ilegibles omitidas.", file=sys.stderr)
    print("\nEstimación propia a partir de los tokens reportados por la API. "
          "La cifra que factura OpenAI manda: platform.openai.com/usage", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
