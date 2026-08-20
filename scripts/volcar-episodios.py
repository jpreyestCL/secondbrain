#!/usr/bin/env python3
"""Vuelca los NOMBRES de los episodios del servidor, uno por línea.

Es el archivo que `brain doctor --episodes` necesita para comparar lo que el
ledger da por ingerido contra lo que existe de verdad en el grafo que se
consulta (regla de oro 8).

Existe como script y no como subcomando porque `get_episodes` devuelve el
CONTENIDO COMPLETO de cada episodio: con ~900 episodios son cientos de KB de
texto que no aportan nada a un archivo que solo lleva nombres. Pedirlo desde
una sesión de Claude llenaría el contexto para tirar el 99% de lo recibido.

Uso:
    python3 scripts/volcar-episodios.py /tmp/episodios.txt
    python3 scripts/volcar-episodios.py /tmp/episodios.txt --max 5000

    # y después, SIEMPRE mirando el resultado antes de reparar nada:
    brain doctor --episodes /tmp/episodios.txt

⚠️  NUNCA correr `brain doctor --repair` sin revisar a mano cada documento que
marque. `doctor` empareja el NOMBRE DEL ARCHIVO contra los nombres de episodio
por contención de substring, así que cualquier desajuste de nombre da un falso
positivo: doble espacio, un `&` escapado a `&amp;`, un archivo URL-encoded, o un
episodio combinado que cubre varios documentos y no lleva el nombre literal de
ninguno. Medido el 2026-08-20 sobre 370 documentos: marcó 6 y los SEIS estaban
en el grafo. `--repair` los habría devuelto a la cola y borrado sus filas de
episodio, y reingerirlos habría duplicado contenido que ya estaba.

Si el token guardado venció, abre el navegador para reautenticar.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "ingest" / "src"))

from brain_ingest.config import load_config  # noqa: E402
from brain_ingest.mcp_remote import conectar  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("destino", type=Path, help="archivo de salida, un nombre por línea")
    ap.add_argument(
        "--max", type=int, default=3000, help="cuántos episodios pedir al servidor"
    )
    args = ap.parse_args()

    cfg = load_config()
    if not cfg.mcp_url:
        print("no hay servidor configurado; corre `brain login <url>`", file=sys.stderr)
        return 2

    p = urlparse(cfg.mcp_url)
    base = f"{p.scheme}://{p.netloc}"
    print(f"servidor={base}{p.path}  tenant={cfg.tenant}", file=sys.stderr)

    cliente = conectar(base, cfg.tenant, cfg.home, path=p.path or "/mcp")
    crudo = cliente.llamar("get_episodes", {"max_episodes": args.max})

    # Se extrae con regex y no con json.loads del todo porque la respuesta MCP
    # llega envuelta de formas distintas segun el transporte (JSON directo o
    # SSE con un mensaje por linea).
    nombres: list[str] = []
    for m in re.finditer(r'"name"\s*:\s*"((?:[^"\\]|\\.)*)"', crudo):
        try:
            nombres.append(json.loads(f'"{m.group(1)}"'))
        except json.JSONDecodeError:
            nombres.append(m.group(1))

    vistos: set[str] = set()
    unicos = [n for n in nombres if not (n in vistos or vistos.add(n))]

    args.destino.write_text("\n".join(unicos) + "\n", encoding="utf-8")
    print(
        f"episodios leídos={len(nombres)}  nombres únicos={len(unicos)}"
        f"  -> {args.destino}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
