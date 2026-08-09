#!/usr/bin/env bash
# Regenera infra/falkordb/users.acl a partir de infra/tenants/*.env.
# Segunda capa de aislamiento multi-tenant: cada usuario tenant_<nombre> solo
# puede tocar la clave Redis "<nombre>" (el grafo FalkorDB del tenant, ya que
# grafo == group_id == tenant).
# Idempotente: ejecutar siempre antes de `docker compose up`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TENANTS_DIR="${INFRA_DIR}/tenants"
OUT_DIR="${INFRA_DIR}/falkordb"
OUT="${OUT_DIR}/users.acl"

mkdir -p "${OUT_DIR}"
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

# NOTA: el formato aclfile de Redis NO admite comentarios — cada linea debe
# ser una regla "user ...". Toda la documentacion vive en este script.
#
# Usuario 'default' sin password: se usa para administracion y backups.
# Aceptable porque el puerto 6379 se publica SOLO en 127.0.0.1 (loopback);
# los contenedores MCP de tenants usan su usuario tenant_<nombre> con ACL.
echo "user default on nopass ~* &* +@all" > "${TMP}"

shopt -s nullglob
declare -a NAMES=()
COUNT=0

for envfile in "${TENANTS_DIR}"/*.env; do
  base="$(basename "${envfile}" .env)"
  [[ "${base}" == "tenant.env" || "${base}" == "tenant" ]] && continue

  TENANT_NAME="$(sed -n 's/^TENANT_NAME=//p' "${envfile}" | tail -1)"
  PASSWORD="$(sed -n 's/^FALKORDB_TENANT_PASSWORD=//p' "${envfile}" | tail -1)"

  if [[ -z "${TENANT_NAME}" ]]; then
    echo "ERROR: ${envfile} debe definir TENANT_NAME" >&2; exit 1
  fi
  if [[ ! "${TENANT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "ERROR: TENANT_NAME invalido '${TENANT_NAME}' en ${envfile}" >&2; exit 1
  fi
  if [[ -z "${PASSWORD}" ]]; then
    echo "ERROR: ${envfile} debe definir FALKORDB_TENANT_PASSWORD (generar: openssl rand -hex 24)" >&2
    exit 1
  fi
  if [[ "${PASSWORD}" =~ [[:space:]\"] ]]; then
    echo "ERROR: FALKORDB_TENANT_PASSWORD en ${envfile} no puede contener espacios ni comillas" >&2
    exit 1
  fi

  # Solo la clave del grafo propio (grafo == nombre del tenant); sin comandos
  # de administracion ni peligrosos (FLUSHALL, KEYS, CONFIG, etc.).
  # +info y +client|setinfo se re-permiten porque el cliente falkordb-py los
  # usa en el handshake (INFO server) y son de solo lectura/inofensivos.
  echo "user tenant_${TENANT_NAME} on >${PASSWORD} ~${TENANT_NAME} +@all -@admin -@dangerous +info +client|setinfo" >> "${TMP}"
  NAMES+=("${TENANT_NAME}"); COUNT=$((COUNT+1))
done

install -m 600 "${TMP}" "${OUT}"
rm -f "${TMP}"
trap - EXIT
echo "Generado ${OUT} con ${COUNT} tenant(s): ${NAMES[*]:-ninguno}"

# Si FalkorDB ya esta corriendo, recargar las ACL en caliente (best effort;
# en el arranque redis las lee solo del aclfile).
if command -v docker >/dev/null 2>&1 && docker exec brain-falkordb redis-cli ACL LOAD >/dev/null 2>&1; then
  echo "ACL recargadas en brain-falkordb (ACL LOAD)"
fi
