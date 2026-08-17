#!/usr/bin/env python3
"""Regenera TODOS los embeddings de un grafo con otro modelo/dimension.

Por qué existe
--------------
Graphiti calcula la similitud con una expresión Cypher —
`(2 - vec.cosineDistance(v, vecf32([...])))/2` — sin índice vectorial, así que
cada búsqueda recorre todos los nodos y **el vector viaja como TEXTO dentro de
la consulta**. Medido en este grafo: 4.096 dimensiones son **52 KB de texto por
vector y por consulta**, con ~85 consultas por episodio. Ese era el 65% del
tiempo de ingesta y el motivo de que FalkorDB estuviera al 134% de CPU.

Bajar a 512 dimensiones divide ese texto por ocho.

La regla de oro
---------------
Mezclar dimensiones **rompe la búsqueda en silencio**: `vec.cosineDistance`
entre vectores de distinto tamaño no compara nada útil, y no falla de forma
visible. Por eso esto es todo-o-nada: o se convierten los 3.436 vectores, o se
deja el grafo como estaba. El script escribe en una transacción por lote y
verifica al final que NO queda ni un vector de la dimensión vieja.

Uso
---
    python3 reembeber.py --tenant jpreyest --dims 512 \
        --modelo text-embedding-3-small --dry-run
    python3 reembeber.py --tenant jpreyest --dims 512 \
        --modelo text-embedding-3-small

Requiere `EMBEDDER_API_KEY_NUEVA` en el entorno (nunca por línea de
comandos: `ps` la mostraría) y que el MCP esté DETENIDO:
si sigue ingiriendo, escribe vectores de la dimensión vieja por detrás.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

import redis

#: Textos por petición al proveedor. Los nombres y hechos son cortos; el límite
#: real es el de tokens por petición, no el de elementos.
LOTE = 128
#: Nodos/aristas por transacción de escritura. Lotes grandes hacen la consulta
#: enorme (el vector va como texto) y bloquean el hilo de FalkorDB más tiempo
#: del necesario.
LOTE_ESCRITURA = 50


def embeber(textos: list[str], modelo: str, dims: int, url: str, key: str) -> list[list[float]]:
    """Pide los vectores al proveedor, conservando el orden de entrada."""
    cuerpo = {"model": modelo, "input": textos}
    # `dimensions` solo lo admiten los modelos entrenados para truncarse
    # (Matryoshka). Si el modelo no lo soporta, mejor que falle aquí y no que
    # devuelva 4.096 en silencio.
    if dims:
        cuerpo["dimensions"] = dims
    req = urllib.request.Request(
        url.rstrip("/") + "/embeddings",
        data=json.dumps(cuerpo).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    for intento in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                datos = json.loads(r.read())
            # Ordenar por `index`: el proveedor no garantiza el orden de salida.
            vectores = [d["embedding"] for d in sorted(datos["data"], key=lambda d: d["index"])]
            if len(vectores) != len(textos):
                raise RuntimeError(f"pedi {len(textos)} vectores y llegaron {len(vectores)}")
            return vectores
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and intento < 4:
                time.sleep(2**intento)
                continue
            raise


def cypher(r: redis.Redis, grafo: str, consulta: str):
    return r.execute_command("GRAPH.QUERY", grafo, consulta)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tenant", required=True, help="nombre del grafo (= group_id)")
    ap.add_argument("--dims", type=int, default=512)
    ap.add_argument("--modelo", default="text-embedding-3-small")
    ap.add_argument("--api-url", default=os.environ.get("EMBEDDER_API_URL_NUEVA", "https://api.openai.com/v1"))
    # Sin `--api-key` A PROPOSITO: los argumentos son visibles en `ps` para
    # cualquier usuario de la maquina. En la primera corrida la clave de OpenAI
    # y la contrasena de FalkorDB quedaron a la vista en la lista de procesos.
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=6380)
    ap.add_argument("--user", default="")
    ap.add_argument("--dry-run", action="store_true", help="cuenta y estima, no escribe")
    args = ap.parse_args()
    args.api_key = os.environ.get("EMBEDDER_API_KEY_NUEVA", "")
    args.password = os.environ.get("FALKORDB_PASSWORD", "")
    args.user = args.user or os.environ.get("FALKORDB_USER", "")

    if not args.api_key:
        print("Falta EMBEDDER_API_KEY_NUEVA en el entorno", file=sys.stderr)
        return 2

    r = redis.Redis(host=args.host, port=args.port, username=args.user or None,
                    password=args.password or None, decode_responses=False)
    g = args.tenant

    # --- inventario ------------------------------------------------------
    nodos = cypher(r, g, "MATCH (n:Entity) WHERE n.name_embedding IS NOT NULL RETURN count(n)")
    aristas = cypher(r, g, "MATCH ()-[e:RELATES_TO]->() WHERE e.fact_embedding IS NOT NULL RETURN count(e)")
    n_nodos = int(nodos[1][0][0])
    n_aristas = int(aristas[1][0][0])
    print(f"grafo '{g}': {n_nodos} entidades y {n_aristas} hechos con embedding")
    print(f"destino: {args.modelo} @ {args.dims} dims")

    if args.dry_run:
        # 52 KB por vector a 4096 dims, proporcional al bajar
        antes = (n_nodos + n_aristas) * 52
        despues = antes * args.dims // 4096
        print(f"[dry-run] texto por barrido completo: {antes/1024:.0f} MB -> {despues/1024:.0f} MB")
        print("[dry-run] nada escrito")
        return 0

    total = 0
    for etiqueta, leer, escribir in (
        (
            "entidades",
            "MATCH (n:Entity) WHERE n.name_embedding IS NOT NULL RETURN n.uuid, n.name",
            "UNWIND {filas} AS f MATCH (n:Entity {{uuid: f.u}}) "
            "SET n.name_embedding = vecf32(f.v)",
        ),
        (
            "hechos",
            "MATCH ()-[e:RELATES_TO]->() WHERE e.fact_embedding IS NOT NULL RETURN e.uuid, e.fact",
            "UNWIND {filas} AS f MATCH ()-[e:RELATES_TO]->() WHERE e.uuid = f.u "
            "SET e.fact_embedding = vecf32(f.v)",
        ),
    ):
        filas = cypher(r, g, leer)[1]
        items = []
        for uuid, texto in filas:
            uuid = uuid.decode() if isinstance(uuid, bytes) else uuid
            texto = texto.decode() if isinstance(texto, bytes) else (texto or "")
            # El MISMO texto que embebe graphiti (normaliza saltos de línea).
            items.append((uuid, texto.replace("\n", " ")))

        print(f"\n{etiqueta}: {len(items)} a convertir")
        hechos = 0
        for i in range(0, len(items), LOTE):
            trozo = items[i : i + LOTE]
            vectores = embeber([t for _, t in trozo], args.modelo, args.dims, args.api_url, args.api_key)
            # Escribir en lotes pequeños: un UNWIND gigante con vectores en texto
            # bloquea el hilo de FalkorDB más de lo necesario.
            for j in range(0, len(trozo), LOTE_ESCRITURA):
                # Mapa de Cypher, NO JSON: las claves van SIN comillas
                # (`{u: ...}`), y json.dumps las pone. El uuid se cita como
                # cadena de Cypher.
                lote_filas = ", ".join(
                    "{{u:'{}', v:{}}}".format(uuid.replace("'", ""), json.dumps(vec))
                    for (uuid, _), vec in zip(
                        trozo[j : j + LOTE_ESCRITURA], vectores[j : j + LOTE_ESCRITURA]
                    )
                )
                cypher(r, g, escribir.format(filas="[" + lote_filas + "]"))
            hechos += len(trozo)
            print(f"  {hechos}/{len(items)}", end="\r", flush=True)
        print(f"  {hechos}/{len(items)} listo")
        total += hechos

    # --- verificación: no puede quedar NADA de la dimensión vieja --------
    # `vecf32Dim` no existe en esta version de FalkorDB, asi que se comprueba
    # por el efecto: comparar contra un vector de la dimension NUEVA falla con
    # "Vector dimension mismatch" en cuanto quede uno de la vieja.
    print("\nverificando dimensiones...")
    sonda = json.dumps([0.01] * args.dims)
    malos = 0
    for etiqueta, consulta in (
        ("entidades",
         f"MATCH (n:Entity) WHERE n.name_embedding IS NOT NULL "
         f"RETURN count(vec.cosineDistance(n.name_embedding, vecf32({sonda})))"),
        ("hechos",
         f"MATCH ()-[e:RELATES_TO]->() WHERE e.fact_embedding IS NOT NULL "
         f"RETURN count(vec.cosineDistance(e.fact_embedding, vecf32({sonda})))"),
    ):
        try:
            n = int(cypher(r, g, consulta)[1][0][0])
            print(f"  {etiqueta}: {n} comparan bien a {args.dims} dims")
        except redis.ResponseError as e:
            print(f"  {etiqueta}: QUEDAN VECTORES DE OTRA DIMENSION ({e})", file=sys.stderr)
            malos += 1

    if malos:
        print(f"\nATENCION: quedaron vectores sin convertir. La busqueda "
              f"mezclara dimensiones y NO fallara de forma visible: vuelve a correr esto.",
              file=sys.stderr)
        return 1

    print(f"\nlisto: {total} vectores regenerados a {args.dims} dimensiones")
    print("Ahora actualiza EMBEDDER_MODEL / EMBEDDER_DIMENSIONS / EMBEDDER_API_* y arranca el MCP.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
