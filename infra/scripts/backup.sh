#!/usr/bin/env bash
# Respaldo de FalkorDB del "second brain".
# 1. Fuerza un BGSAVE (snapshot RDB) si el contenedor esta corriendo y espera
#    a que termine (comparando LASTSAVE).
# 2. Empaqueta el directorio de datos (RDB + AOF) en
#    backups/falkor-YYYYMMDD-HHMMSS.tar.gz
#    MULTI-TENANT: los archivos RDB/AOF contienen la instancia FalkorDB
#    completa, es decir TODOS los grafos (un grafo por tenant, grafo == tenant).
#    Un solo respaldo cubre a todos los tenants; un restore restaura a todos.
# 3. Elimina respaldos con mas de 30 dias.
#
# Uso: bash infra/scripts/backup.sh   (o "make backup")
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DATA_DIR="${REPO_ROOT}/infra/data/falkordb"
BACKUP_DIR="${REPO_ROOT}/backups"
CONTAINER="brain-falkordb"
RETENTION_DAYS=30
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="${BACKUP_DIR}/falkor-${TS}.tar.gz"

# launchd arranca con un PATH minimo; asegurar rutas tipicas de docker/colima.
export PATH="/usr/local/bin:/opt/homebrew/bin:${HOME}/.local/bin:${PATH}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

if [[ ! -d "${DATA_DIR}" ]]; then
  log "ERROR: no existe el directorio de datos ${DATA_DIR} (¿nunca se levanto el stack?)"
  exit 1
fi
mkdir -p "${BACKUP_DIR}"

container_running() {
  command -v docker >/dev/null 2>&1 \
    && [[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || echo false)" == "true" ]]
}

redis_cli() {
  docker exec "${CONTAINER}" redis-cli -p 6379 "$@"
}

if container_running; then
  log "Contenedor ${CONTAINER} activo: forzando BGSAVE"
  LAST_SAVE="$(redis_cli LASTSAVE | tr -dc '0-9')"
  redis_cli BGSAVE >/dev/null
  # Esperar hasta 120 s a que LASTSAVE avance (snapshot completo)
  for _ in $(seq 1 120); do
    CURRENT="$(redis_cli LASTSAVE | tr -dc '0-9')"
    if [[ "${CURRENT}" -gt "${LAST_SAVE}" ]]; then
      log "BGSAVE completado"
      break
    fi
    sleep 1
  done
  if [[ "$(redis_cli LASTSAVE | tr -dc '0-9')" -le "${LAST_SAVE}" ]]; then
    log "ADVERTENCIA: BGSAVE no confirmo termino en 120 s; se respalda igual (AOF cubre lo reciente)"
  fi
else
  log "ADVERTENCIA: docker/${CONTAINER} no disponible; se respaldan los archivos en frio"
fi

log "Empaquetando ${DATA_DIR} -> ${ARCHIVE}"
TMP_ARCHIVE="${ARCHIVE}.partial"
tar -czf "${TMP_ARCHIVE}" -C "$(dirname "${DATA_DIR}")" "$(basename "${DATA_DIR}")"
mv "${TMP_ARCHIVE}" "${ARCHIVE}"
log "Respaldo creado: ${ARCHIVE} ($(du -h "${ARCHIVE}" | cut -f1 | tr -d ' '))"

log "Eliminando respaldos con mas de ${RETENTION_DAYS} dias"
find "${BACKUP_DIR}" -name 'falkor-*.tar.gz' -type f -mtime +"${RETENTION_DAYS}" -print -delete || true

log "Listo"
