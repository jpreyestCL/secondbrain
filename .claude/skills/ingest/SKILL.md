---
name: ingest
description: Ingestar por lote una carpeta de documentos al second brain (/ingest <carpeta>). Usar cuando el usuario quiere procesar el inbox o una carpeta de PDFs, imágenes o documentos hacia el grafo Graphiti mediante el pipeline del CLI `brain`.
---

# /ingest <carpeta> — Pipeline de ingesta por lote

Orquesta el pipeline del paquete `ingest/` (CLI `uv run brain`, ejecutar desde `ingest/`). Si no se indica carpeta, usar `inbox/`.

> **Multi-tenant**: el CLI acepta `--tenant` (default `jpreyest`, estado en `~/.brain/<tenant>/`). Toda la corrida usa UN solo tenant de principio a fin; nunca mezclar documentos de distintas personas en la misma corrida ni ingestar al grafo de otro tenant.

> **Modelo de particionado**: un grafo por tenant; el `group_id` de cada episodio es SIEMPRE el tenant (el nombre del grafo). El **dominio** (`personal`, `salud`, ...) NO es un `group_id`: viaja como metadata — en el `source_description` (`dominio: <dominio> | tipo: <doc_type> | origen: ...`) y como prefijo `[<dominio>]` en el nombre del episodio. El CLI `ingest-graph` ya lo hace así.

## Pipeline

Ejecutar en orden, verificando la salida de cada paso antes de continuar:

1. **Scan** — `uv run brain scan <carpeta>`
   Registra los archivos en el ledger. Revisar el conteo y avisar si hay archivos ya ingestados (el ledger los salta).

2. **Extract** — `uv run brain extract`
   Extrae texto (PDF, imágenes/OCR, etc.). Reportar fallos de extracción al usuario; esos archivos se manejan aparte.

3. **Classify** — `uv run brain classify`
   Emite un manifiesto JSON con los documentos pendientes de clasificar. **Este es el paso donde Claude trabaja:**
   - Leer el manifiesto y el texto extraído de cada documento.
   - Para CADA documento completar: `domain` (dominio según SCHEMA.md — metadata, no group_id), `doc_type` (contrato, examen, factura, boleta, certificado, nota...), `doc_date` (fecha REAL del documento — prioridad: contenido > metadatos > mtime > preguntar al usuario; nunca dejar la fecha de hoy por defecto), `sensitivity` (`normal`, `medical`, `financial`, `secret`).
   - Documentos con `sensitivity=secret`: marcar los pasajes a redactar; los secretos no entran al grafo.
   - Escribir el manifiesto completado.

4. **Aplicar** — `uv run brain classify --apply <manifiesto>`

5. **Chunk** — `uv run brain chunk`

6. **Ingesta al grafo** — `uv run brain ingest-graph`
   Requiere el stack arriba (`make up` en `infra/`). Verificar antes con `uv run brain status` o similar.

7. **Archivar** — mover los originales de `<carpeta>` a `archive/<dominio>/` según la clasificación de cada documento (crear el subdirectorio del dominio si no existe). No borrar nada; `archive/` es la fuente de verdad de los originales.

## Guía de lotes

- **Lotes grandes (>10 docs): revisar una muestra primero.** Clasificar 3-5 documentos, mostrar la clasificación al usuario y pedir su OK antes de clasificar y aplicar el resto. Evita archivar 50 documentos en el dominio equivocado.
- Si aparecen documentos de un proyecto sin dominio `proyecto-<slug>` existente, proponer el slug al usuario antes de crearlo.
- **Costo**: la extracción y clasificación las hace Claude dentro de la sesión (suscripción, sin costo por API). El único costo por API son los **embeddings** de `ingest-graph`, que es marginal. No hay motivo para escatimar en clasificación cuidadosa.

## Reporte final

Al terminar, presentar SIEMPRE una tabla resumen:

| Archivo | Dominio | Tipo | Fecha | Sensibilidad | Estado |
|---|---|---|---|---|---|
| examen_lipidico.pdf | salud | examen | 2026-07-12 | medical | ingestado → archive/salud/ |

más: total ingestado, fallos de extracción, documentos que quedaron pendientes (y por qué), y episodios creados según la salida de `ingest-graph`.
