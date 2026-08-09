#!/usr/bin/env bash
# Crea un tenant nuevo del "second brain" y regenera el compose de tenants.
# Uso: add-tenant.sh <nombre> <puerto>     (ej: add-tenant.sh maria 8022)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TENANTS_DIR="${INFRA_DIR}/tenants"

NAME="${1:-}"; PORT="${2:-}"
if [[ -z "${NAME}" || -z "${PORT}" ]]; then
  echo "Uso: $0 <nombre> <puerto>   (ej: $0 maria 8022)" >&2; exit 1
fi
if [[ ! "${NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "ERROR: nombre invalido '${NAME}' (usar [a-z0-9_-], minusculas)" >&2; exit 1
fi
# Rango valido 1024-65535, excluyendo puertos reservados del stack:
# 6379 (FalkorDB), 8787 (gateway), 11434 (Ollama). Mismo criterio que
# gen-tenants-compose.sh.
if [[ ! "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "ERROR: puerto invalido '${PORT}' (rango 1024-65535)" >&2; exit 1
fi
case "${PORT}" in
  6379|8787|11434)
    echo "ERROR: puerto ${PORT} reservado (falkordb/gateway/ollama)" >&2; exit 1;;
esac

ENVFILE="${TENANTS_DIR}/${NAME}.env"
if [[ -e "${ENVFILE}" ]]; then
  echo "ERROR: el tenant '${NAME}' ya existe (${ENVFILE})" >&2; exit 1
fi
if grep -hs "^MCP_PORT=${PORT}$" "${TENANTS_DIR}"/*.env >/dev/null 2>&1; then
  echo "ERROR: el puerto ${PORT} ya esta usado por otro tenant" >&2; exit 1
fi

mkdir -p "${TENANTS_DIR}"
# Password del usuario ACL del tenant en FalkorDB (segunda capa de aislamiento)
FALKORDB_TENANT_PASSWORD="$(openssl rand -hex 24)"
cat > "${ENVFILE}" <<EOF
# Tenant: ${NAME}
TENANT_NAME=${NAME}
MCP_PORT=${PORT}
# Grafo == tenant (el group_id nombra el grafo en FalkorDB)
FALKORDB_DATABASE=${NAME}
GRAPHITI_GROUP_ID=${NAME}
# Password del usuario ACL tenant_${NAME} en FalkorDB (openssl rand -hex 24)
FALKORDB_TENANT_PASSWORD=${FALKORDB_TENANT_PASSWORD}
EOF

echo "Creado ${ENVFILE}"
bash "${SCRIPT_DIR}/gen-tenants-compose.sh"
bash "${SCRIPT_DIR}/gen-falkordb-acl.sh"
echo "Tenant '${NAME}' listo. Levantar con: make up"
echo "Endpoint MCP (via gateway): http://127.0.0.1:${PORT}/mcp/"
