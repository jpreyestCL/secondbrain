#!/usr/bin/env bash
# Revisa qué pasó con los documentos de una carpeta: qué entró al grafo, qué se
# saltó y POR QUÉ, y si quedó algo a medias.
#
# "Absorbido" no es lo mismo que "todo en el grafo". Muchos documentos se marcan
# `skipped` a propósito —cartolas mensuales cuyo agregado anual ya está,
# planillas que se partirían en decenas de miles de asientos, plantillas en
# blanco, borradores superados por su versión firmada— y cada uno lleva escrito
# su motivo. Este script existe para que esas decisiones se puedan auditar en
# vez de tener que confiar en ellas.
#
# Uso:
#   scripts/revisar-carpeta.sh "Andes USA Invest LLC"
#   scripts/revisar-carpeta.sh "DOCUMENTOS PERSONALES" --motivos
#   scripts/revisar-carpeta.sh ""                       # todo el ledger
#
# Sin --motivos solo muestra el resumen y lo pendiente, que es lo que se mira a
# diario. Con --motivos lista archivo por archivo por qué no entró.
set -euo pipefail

CARPETA="${1-}"
MOTIVOS="${2-}"
LEDGER="${BRAIN_LEDGER:-$HOME/.brain/${BRAIN_TENANT:-jpreyest}/ledger.sqlite}"

if [ ! -f "$LEDGER" ]; then
  echo "no encuentro el ledger en $LEDGER" >&2
  echo "usa BRAIN_TENANT=<tenant> o BRAIN_LEDGER=<ruta>" >&2
  exit 2
fi

# Con carpeta vacía el patrón '%%' hace match con todo el ledger.
PAT="%${CARPETA}%"
echo "ledger: $LEDGER"
echo "filtro: ${CARPETA:-(todo)}"
echo

echo "== resumen =="
sqlite3 -header -column "$LEDGER" \
  "SELECT status, count(*) AS archivos FROM files
   WHERE path LIKE '$PAT' GROUP BY status ORDER BY 2 DESC;"

echo
echo "== pendientes (vacío = nada a medias) =="
sqlite3 "$LEDGER" \
  "SELECT replace(path,'$HOME/Documents/','') FROM files
   WHERE path LIKE '$PAT'
     AND status NOT IN ('ingested','skipped','duplicate') ORDER BY path;"

echo
echo "== integridad =="
printf '  ingested sin ningún episodio: %s\n' \
  "$(sqlite3 "$LEDGER" "SELECT count(*) FROM files f WHERE f.path LIKE '$PAT'
      AND f.status='ingested'
      AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.doc_id=f.doc_id AND e.expired=0);")"
printf '  trozos duplicados en el grafo: %s\n' \
  "$(sqlite3 "$LEDGER" "SELECT count(*) FROM (
      SELECT e.doc_id, e.chunk_idx FROM episodes e JOIN files f ON f.doc_id=e.doc_id
      WHERE f.path LIKE '$PAT' AND e.expired=0
      GROUP BY e.doc_id, e.chunk_idx HAVING count(*)>1);")"
echo "  (los dos deben ser 0; si no, mira \`brain doctor\` y \`brain dedupe-episodes\`)"

if [ "$MOTIVOS" = "--motivos" ]; then
  echo
  echo "== por qué se saltó cada uno =="
  sqlite3 -line "$LEDGER" \
    "SELECT replace(path,'$HOME/Documents/','') AS archivo, error AS motivo
     FROM files WHERE path LIKE '$PAT' AND status='skipped' ORDER BY path;"
fi
