#!/usr/bin/env bash
# Aprovisiona un tenant completo del "second brain" (idempotente).
# Lo invoca el gateway OAuth en el registro self-service (/registro), y también
# sirve para uso manual por el administrador.
#
# Uso: provision-tenant.sh <slug> <puerto>     (ej: provision-tenant.sh maria 9022)
#
# Pasos:
#   1. Crea infra/tenants/<slug>.env vía add-tenant.sh (si no existe).
#   2. Regenera infra/docker-compose.tenants.yml y las ACL de FalkorDB
#      (gen-falkordb-acl.sh recarga las ACL en caliente si FalkorDB corre).
#   3. Levanta SOLO el servicio nuevo (mcp-<slug>) con docker compose, con los
#      mismos archivos compose y proyecto que usa el Makefile de la raíz.
#
# Idempotente: si el tenant ya existe con el mismo puerto, no recrea nada y
# solo regenera + levanta. Si existe con OTRO puerto, aborta con error claro.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${INFRA_DIR}/.." && pwd)"
TENANTS_DIR="${INFRA_DIR}/tenants"

SLUG="${1:-}"; PORT="${2:-}"
if [[ -z "${SLUG}" || -z "${PORT}" ]]; then
  echo "Uso: $0 <slug> <puerto>   (ej: $0 maria 9022)" >&2; exit 1
fi
if [[ ! "${SLUG}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "ERROR: slug invalido '${SLUG}' (usar [a-z0-9_-], minusculas)" >&2; exit 1
fi
if [[ ! "${PORT}" =~ ^[0-9]{4,5}$ ]]; then
  echo "ERROR: puerto invalido '${PORT}'" >&2; exit 1
fi

ENVFILE="${TENANTS_DIR}/${SLUG}.env"
if [[ -f "${ENVFILE}" ]]; then
  EXISTING_PORT="$(sed -n 's/^MCP_PORT=//p' "${ENVFILE}" | tail -1)"
  if [[ "${EXISTING_PORT}" != "${PORT}" ]]; then
    echo "ERROR: el tenant '${SLUG}' ya existe con puerto ${EXISTING_PORT} (pedido: ${PORT})." >&2
    echo "       No se toca nada. Revisa ${ENVFILE}." >&2
    exit 1
  fi
  echo ">> Tenant '${SLUG}' ya existe con puerto ${PORT}; re-run idempotente."
  # add-tenant.sh ya corrió en su momento; solo regeneramos artefactos.
  bash "${SCRIPT_DIR}/gen-tenants-compose.sh"
  bash "${SCRIPT_DIR}/gen-falkordb-acl.sh"   # recarga ACL en caliente (best effort)
else
  # Crea el .env del tenant y regenera compose + ACL (con hot-reload de ACL).
  bash "${SCRIPT_DIR}/add-tenant.sh" "${SLUG}" "${PORT}"
fi

# --- Levantar SOLO el servicio nuevo ---
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker CLI no encontrado" >&2; exit 1
fi
if ! docker ps >/dev/null 2>&1; then
  echo "ERROR: el daemon docker no responde (¿colima start?)" >&2; exit 1
fi

# Mismos -f y --env-file que el Makefile de la raíz => mismo proyecto compose.
COMPOSE=(docker compose)
if [[ -f "${REPO_ROOT}/.env" ]]; then
  COMPOSE+=(--env-file "${REPO_ROOT}/.env")
fi
COMPOSE+=(-f "${INFRA_DIR}/docker-compose.yml" -f "${INFRA_DIR}/docker-compose.tenants.yml")

cd "${REPO_ROOT}"
# `up -d mcp-<slug>` levanta el servicio del tenant y sus dependencias
# (falkordb, que normalmente ya corre) sin tocar los demás tenants.
"${COMPOSE[@]}" up -d "mcp-${SLUG}"

echo "Tenant '${SLUG}' aprovisionado. MCP upstream: http://127.0.0.1:${PORT}/mcp"
