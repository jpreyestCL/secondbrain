#!/usr/bin/env bash
# Regenera infra/falkordb/users.acl a partir de infra/tenants/*.env.
# Segunda capa de aislamiento multi-tenant: cada usuario tenant_<nombre> solo
# puede tocar la clave Redis "<nombre>" (el grafo FalkorDB del tenant, ya que
# grafo == group_id == tenant).
# Idempotente: ejecutar siempre antes de `docker compose up`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${INFRA_DIR}/.." && pwd)"
TENANTS_DIR="${INFRA_DIR}/tenants"
OUT_DIR="${INFRA_DIR}/falkordb"
OUT="${OUT_DIR}/users.acl"
ENV_FILE="${REPO_ROOT}/.env"
CONTAINER="brain-falkordb"

# Password del usuario 'default' (administracion/backups). OBLIGATORIO: sin el,
# cualquier contenedor de la red compose podria conectarse como default y leer
# TODOS los grafos. Se lee de .env en la raiz del repo.
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: no existe ${ENV_FILE} (cp .env.example .env y define FALKORDB_PASSWORD)" >&2
  exit 1
fi
FALKORDB_PASSWORD="$(sed -n 's/^FALKORDB_PASSWORD=//p' "${ENV_FILE}" | tail -1)"
if [[ -z "${FALKORDB_PASSWORD}" ]]; then
  echo "ERROR: FALKORDB_PASSWORD vacio en ${ENV_FILE} (generar: openssl rand -hex 24)" >&2
  exit 1
fi
if [[ ! "${FALKORDB_PASSWORD}" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "ERROR: FALKORDB_PASSWORD en ${ENV_FILE} solo admite [A-Za-z0-9_-]" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

# NOTA: el formato aclfile de Redis NO admite comentarios — cada linea debe
# ser una regla "user ...". Toda la documentacion vive en este script.
#
# Usuario 'default' CON password (FALKORDB_PASSWORD del .env raiz): se usa para
# administracion, healthcheck y backups. Los contenedores MCP de tenants usan
# su usuario tenant_<nombre> con ACL y NUNCA reciben FALKORDB_PASSWORD.
echo "user default on >${FALKORDB_PASSWORD} ~* &* +@all" > "${TMP}"

shopt -s nullglob
declare -a NAMES=()
COUNT=0

# El glob *.env NO matchea la plantilla tenant.env.example (termina en
# .example), asi que no hay nada que saltar: todo <nombre>.env es un tenant
# real — incluso uno literalmente llamado "tenant".
for envfile in "${TENANTS_DIR}"/*.env; do
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
  if [[ ! "${PASSWORD}" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "ERROR: FALKORDB_TENANT_PASSWORD en ${envfile} solo admite [A-Za-z0-9_-] (va embebido en la URI redis://)" >&2
    exit 1
  fi

  # Solo la clave del grafo propio (grafo == nombre del tenant); sin comandos
  # de administracion ni peligrosos (FLUSHALL, KEYS, CONFIG, etc.).
  # +info y +client|setinfo se re-permiten porque el cliente falkordb-py los
  # usa en el handshake (INFO server) y son de solo lectura/inofensivos.
  # -scan -graph.list: evita enumerar los NOMBRES de los grafos de otros
  # tenants (SCAN/GRAPH.LIST listan el keyspace completo aunque ~<tenant>
  # impida leer su contenido).
  echo "user tenant_${TENANT_NAME} on >${PASSWORD} ~${TENANT_NAME} +@all -@admin -@dangerous +info +client|setinfo -scan -graph.list" >> "${TMP}"
  NAMES+=("${TENANT_NAME}"); COUNT=$((COUNT+1))
done

install -m 600 "${TMP}" "${OUT}"
rm -f "${TMP}"
trap - EXIT
echo "Generado ${OUT} con ${COUNT} tenant(s): ${NAMES[*]:-ninguno}"

# Si FalkorDB ya esta corriendo, recargar las ACL en caliente. Distinguir:
#   - docker/contenedor no disponible -> aviso (arranque las leera del aclfile)
#   - ACL LOAD fallo (-ERR)           -> error duro (el aclfile quedo invalido
#     o la instancia quedaria desincronizada respecto del archivo generado)
# redis-cli -e hace que un reply de error devuelva exit code != 0.
if ! command -v docker >/dev/null 2>&1; then
  echo "AVISO: docker no disponible; las ACL se cargaran al arrancar el contenedor"
elif [[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null || echo false)" != "true" ]]; then
  echo "AVISO: ${CONTAINER} no esta corriendo; las ACL se cargaran al arrancar"
else
  # Intento autenticado (estado normal). Si falla la auth (p.ej. la instancia
  # aun corre con la config vieja sin password), reintenta sin password.
  if OUT_LOAD="$(docker exec -e REDISCLI_AUTH="${FALKORDB_PASSWORD}" "${CONTAINER}" redis-cli -e ACL LOAD 2>&1)"; then
    echo "ACL recargadas en ${CONTAINER} (ACL LOAD)"
  elif OUT_LOAD2="$(docker exec "${CONTAINER}" redis-cli -e ACL LOAD 2>&1)"; then
    echo "ACL recargadas en ${CONTAINER} (ACL LOAD, transicion desde instancia sin password)"
  else
    echo "ERROR: ACL LOAD fallo en ${CONTAINER}:" >&2
    echo "  con password: ${OUT_LOAD}" >&2
    echo "  sin password: ${OUT_LOAD2}" >&2
    exit 1
  fi
fi
