#!/usr/bin/env bash
# Regenera infra/docker-compose.tenants.yml a partir de infra/tenants/*.env.
# Un servicio MCP por tenant, cada uno:
#   - imagen pineada zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2-standalone
#   - puerto SOLO loopback 127.0.0.1:<MCP_PORT>:8000
#   - su propio grafo FalkorDB via FALKORDB_DATABASE (env_file del tenant)
# Idempotente: se puede ejecutar siempre antes de `docker compose up`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TENANTS_DIR="${INFRA_DIR}/tenants"
OUT="${INFRA_DIR}/docker-compose.tenants.yml"
IMAGE="zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2-standalone"

TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

{
  echo "# ARCHIVO GENERADO — no editar a mano. Contiene credenciales: NO commitear."
  echo "# Fuente: infra/tenants/*.env ; generador: infra/scripts/gen-tenants-compose.sh"
  echo "services:"
} > "${TMP}"

shopt -s nullglob
declare -a SEEN_PORTS=() SEEN_NAMES=()
COUNT=0

for envfile in "${TENANTS_DIR}"/*.env; do
  base="$(basename "${envfile}" .env)"
  [[ "${base}" == "tenant.env" || "${base}" == "tenant" ]] && continue

  # Leer solo las claves que necesita el generador
  TENANT_NAME="$(sed -n 's/^TENANT_NAME=//p' "${envfile}" | tail -1)"
  MCP_PORT="$(sed -n 's/^MCP_PORT=//p' "${envfile}" | tail -1)"
  FALKORDB_TENANT_PASSWORD="$(sed -n 's/^FALKORDB_TENANT_PASSWORD=//p' "${envfile}" | tail -1)"

  if [[ -z "${TENANT_NAME}" || -z "${MCP_PORT}" ]]; then
    echo "ERROR: ${envfile} debe definir TENANT_NAME y MCP_PORT" >&2; exit 1
  fi
  if [[ -z "${FALKORDB_TENANT_PASSWORD}" ]]; then
    echo "ERROR: ${envfile} debe definir FALKORDB_TENANT_PASSWORD (generar: openssl rand -hex 24)" >&2
    exit 1
  fi
  if [[ ! "${TENANT_NAME}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    echo "ERROR: TENANT_NAME invalido '${TENANT_NAME}' en ${envfile} (usar [a-z0-9_-])" >&2; exit 1
  fi
  if [[ "${TENANT_NAME}" != "${base}" ]]; then
    echo "ERROR: TENANT_NAME=${TENANT_NAME} no coincide con el archivo ${base}.env" >&2; exit 1
  fi
  if [[ ! "${MCP_PORT}" =~ ^[0-9]{4,5}$ ]]; then
    echo "ERROR: MCP_PORT invalido '${MCP_PORT}' en ${envfile}" >&2; exit 1
  fi
  for p in "${SEEN_PORTS[@]:-}"; do
    [[ "${p}" == "${MCP_PORT}" ]] && { echo "ERROR: puerto ${MCP_PORT} duplicado (${envfile})" >&2; exit 1; }
  done
  SEEN_PORTS+=("${MCP_PORT}"); SEEN_NAMES+=("${TENANT_NAME}"); COUNT=$((COUNT+1))

  cat >> "${TMP}" <<EOF

  mcp-${TENANT_NAME}:
    image: ${IMAGE}
    container_name: brain-mcp-${TENANT_NAME}
    restart: unless-stopped
    depends_on:
      falkordb:
        condition: service_healthy
    ports:
      # Solo loopback: el gateway OAuth es el unico punto de entrada externo
      - "127.0.0.1:${MCP_PORT}:8000"
    env_file:
      # 1) claves/ajustes globales (.env raiz), 2) overrides del tenant
      - path: ../.env
        required: false
      - path: tenants/${TENANT_NAME}.env
        required: true
    environment:
      # Credenciales ACL del tenant (segunda capa de aislamiento): el usuario
      # tenant_<nombre> solo puede tocar el grafo <nombre> en FalkorDB.
      - FALKORDB_URI=redis://tenant_${TENANT_NAME}:${FALKORDB_TENANT_PASSWORD}@falkordb:6379
      - FALKORDB_DATABASE=${TENANT_NAME}
      - GRAPHITI_TELEMETRY_ENABLED=false
      - CONFIG_PATH=/app/mcp/config/config.yaml
    volumes:
      - ./graphiti/config.yaml:/app/mcp/config/config.yaml:ro
      # PATCH: backport de upstream para que la rama LLM 'openai' respete api_url
      # (Ollama). Ver infra/graphiti/patches/factories.py. Quitar al subir a una
      # imagen que ya incluya el fix.
      - ./graphiti/patches/factories.py:/app/mcp/src/services/factories.py:ro
      # PATCH: exponer reference_time en add_memory y propagarlo a la cola
      # (la imagen 1.0.2 fija datetime.now(), rompiendo el modelo bi-temporal).
      - ./graphiti/patches/graphiti_mcp_server.py:/app/mcp/src/graphiti_mcp_server.py:ro
      - ./graphiti/patches/queue_service.py:/app/mcp/src/services/queue_service.py:ro
    command: ["uv", "run", "main.py"]
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          curl -fsS http://localhost:8000/health ||
          wget -qO- http://localhost:8000/health ||
          python3 -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/health',timeout=3)"
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 30s
EOF
done

if [[ ${COUNT} -eq 0 ]]; then
  # Compose valido aunque no haya tenants ('services: {}')
  {
    echo "# ARCHIVO GENERADO — no editar a mano. (sin tenants en infra/tenants/)"
    echo "services: {}"
  } > "${TMP}"
fi

mv "${TMP}" "${OUT}"
trap - EXIT
echo "Generado ${OUT} con ${COUNT} tenant(s): ${SEEN_NAMES[*]:-ninguno}"
