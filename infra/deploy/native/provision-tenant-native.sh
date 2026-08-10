#!/usr/bin/env bash
# Aprovisiona un tenant del "second brain" en el deploy NATIVO (sin Docker).
# Equivalente de infra/scripts/provision-tenant.sh, pero contra systemd +
# FalkorDB nativo en /opt/secondbrain-native.
#
# Uso:  provision-tenant-native.sh <slug> <puerto>      (ej: ... maria 9022)
#       BRAIN_ROOT=/otra/ruta provision-tenant-native.sh maria 9022
#
# Pasos:
#   1. Valida slug y puerto (rango, puertos reservados, colision con otro tenant).
#   2. Crea el usuario ACL tenant_<slug> en users.acl + ACL LOAD en caliente.
#   3. Escribe tenants/<slug>.env y tenants/<slug>/config.yaml (puerto propio).
#   4. Instancia el unit template brain-mcp@<slug> y espera /health.
#   5. Reaplica el firewall local para que el puerto nuevo quede restringido.
#
# IDEMPOTENTE: re-ejecutar con el mismo slug+puerto no duplica lineas ACL ni
# regenera el password; solo re-verifica y reinicia si hace falta.
#
# Requiere root (escribe en /etc/systemd/system y en archivos de secondbrain).
set -euo pipefail

BRAIN_ROOT="${BRAIN_ROOT:-/opt/secondbrain-native}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ACL_FILE="${BRAIN_ROOT}/users.acl"
SHARED_ENV="${BRAIN_ROOT}/mcp.env"
TENANTS_DIR="${BRAIN_ROOT}/tenants"
REDIS_CLI="${BRAIN_ROOT}/bin/redis-cli"
FIREWALL_SH="${BRAIN_ROOT}/firewall-local.sh"
FALKORDB_PORT="${FALKORDB_PORT:-6380}"
SERVICE_USER="${SERVICE_USER:-secondbrain}"

# Puertos que nunca puede tomar un tenant.
RESERVED_PORTS=(6379 6380 8021 8787 11434)

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo ">> $*"; }

# --- 0. Argumentos ------------------------------------------------------------
SLUG="${1:-}"; PORT="${2:-}"
if [[ -z "${SLUG}" || -z "${PORT}" ]]; then
  echo "Uso: $0 <slug> <puerto>   (ej: $0 maria 9022)" >&2; exit 1
fi
[[ "${SLUG}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
  || die "slug invalido '${SLUG}' (usar [a-z0-9_-] en minusculas, empezando por [a-z0-9])"
[[ "${PORT}" =~ ^[0-9]+$ ]] || die "puerto invalido '${PORT}' (no numerico)"
(( PORT >= 1024 && PORT <= 65535 )) || die "puerto ${PORT} fuera de rango (1024-65535)"
for rp in "${RESERVED_PORTS[@]}"; do
  [[ "${PORT}" == "${rp}" ]] && die "puerto ${PORT} reservado (falkordb/mcp base/gateway/ollama)"
done

[[ "${EUID}" -eq 0 ]] || die "hay que correr como root (escribe units systemd y archivos de ${SERVICE_USER})"
[[ -d "${BRAIN_ROOT}" ]] || die "no existe ${BRAIN_ROOT} (¿corriste install.sh?)"
[[ -f "${ACL_FILE}" ]] || die "no existe ${ACL_FILE}"
[[ -f "${SHARED_ENV}" ]] || die "no existe ${SHARED_ENV} (env compartido con LLM/embedder)"
[[ -x "${REDIS_CLI}" ]] || die "no existe ${REDIS_CLI}"

install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 700 "${TENANTS_DIR}"

ENVFILE="${TENANTS_DIR}/${SLUG}.env"
CONFDIR="${TENANTS_DIR}/${SLUG}"
CONFFILE="${CONFDIR}/config.yaml"

# --- 1. Colisiones de puerto con otros tenants --------------------------------
shopt -s nullglob
for other in "${TENANTS_DIR}"/*.env; do
  other_slug="$(basename "${other}" .env)"
  [[ "${other_slug}" == "${SLUG}" ]] && continue
  other_port="$(sed -n 's/^MCP_PORT=//p' "${other}" | tail -1)"
  [[ "${other_port}" == "${PORT}" ]] \
    && die "puerto ${PORT} ya lo usa el tenant '${other_slug}' (${other})"
done
shopt -u nullglob

# Si el tenant ya existe con OTRO puerto, abortar sin tocar nada.
if [[ -f "${ENVFILE}" ]]; then
  EXISTING_PORT="$(sed -n 's/^MCP_PORT=//p' "${ENVFILE}" | tail -1)"
  if [[ -n "${EXISTING_PORT}" && "${EXISTING_PORT}" != "${PORT}" ]]; then
    die "el tenant '${SLUG}' ya existe con puerto ${EXISTING_PORT} (pedido: ${PORT}). No se toca nada; revisa ${ENVFILE}"
  fi
  info "tenant '${SLUG}' ya existe con puerto ${PORT}; re-run idempotente"
fi

# --- 2. Password ACL del tenant ----------------------------------------------
# Password admin (usuario default) para poder hacer ACL LOAD.
ADMIN_PASS="$(grep -E '^user default ' "${ACL_FILE}" | grep -oE '>[^ ]+' | head -1 | tr -d '>')"
[[ -n "${ADMIN_PASS}" ]] || die "no pude leer el password admin (linea 'user default' de ${ACL_FILE})"

ACL_LINE_RE="^user tenant_${SLUG} "
if grep -qE "${ACL_LINE_RE}" "${ACL_FILE}"; then
  # Reutilizar el password existente: no romper el .env ni sesiones activas.
  TENANT_PASS="$(grep -E "${ACL_LINE_RE}" "${ACL_FILE}" | grep -oE '>[^ ]+' | head -1 | tr -d '>')"
  [[ -n "${TENANT_PASS}" ]] || die "linea ACL de tenant_${SLUG} sin password legible en ${ACL_FILE}"
  info "usuario ACL tenant_${SLUG} ya existe; reutilizo su password"
  ACL_CHANGED=0
else
  TENANT_PASS="$(openssl rand -hex 24)"
  ACL_CHANGED=1
fi

# La ACL: solo la clave del grafo propio (grafo == slug), sin comandos de
# administracion ni peligrosos. +info y +client|setinfo los necesita el
# handshake de falkordb-py. -scan -graph.list evitan enumerar grafos ajenos.
ACL_LINE="user tenant_${SLUG} on >${TENANT_PASS} ~${SLUG} +@all -@admin -@dangerous +info +client|setinfo -scan -graph.list"

if [[ "${ACL_CHANGED}" == "1" ]]; then
  info "agregando usuario ACL tenant_${SLUG} a ${ACL_FILE}"
  cp -a "${ACL_FILE}" "${ACL_FILE}.bak"
  printf '%s\n' "${ACL_LINE}" >> "${ACL_FILE}"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${ACL_FILE}"
  chmod 600 "${ACL_FILE}"
fi

# Hot-reload de las ACL. -e hace que un reply de error devuelva exit != 0.
# Si FalkorDB no corre, avisamos (las leera al arrancar); si corre y falla,
# es error duro: el aclfile quedaria desincronizado de la instancia.
if "${REDIS_CLI}" -p "${FALKORDB_PORT}" --no-auth-warning -a "${ADMIN_PASS}" PING >/dev/null 2>&1; then
  if OUT_LOAD="$("${REDIS_CLI}" -p "${FALKORDB_PORT}" --no-auth-warning -a "${ADMIN_PASS}" -e ACL LOAD 2>&1)"; then
    info "ACL recargadas en caliente (ACL LOAD): ${OUT_LOAD}"
  else
    echo "ERROR: ACL LOAD fallo: ${OUT_LOAD}" >&2
    if [[ "${ACL_CHANGED}" == "1" ]]; then
      echo "       revirtiendo ${ACL_FILE} desde .bak" >&2
      mv -f "${ACL_FILE}.bak" "${ACL_FILE}"
      chown "${SERVICE_USER}:${SERVICE_USER}" "${ACL_FILE}"; chmod 600 "${ACL_FILE}"
    fi
    exit 1
  fi
else
  echo "AVISO: FalkorDB no responde en ${FALKORDB_PORT}; las ACL se cargaran al arrancar" >&2
fi
rm -f "${ACL_FILE}.bak"

# Verificar que el usuario ACL realmente quedo activo.
if "${REDIS_CLI}" -p "${FALKORDB_PORT}" --no-auth-warning -a "${ADMIN_PASS}" PING >/dev/null 2>&1; then
  "${REDIS_CLI}" -p "${FALKORDB_PORT}" --no-auth-warning -a "${ADMIN_PASS}" -e ACL GETUSER "tenant_${SLUG}" >/dev/null \
    || die "tenant_${SLUG} no aparece en la instancia tras ACL LOAD"
fi

# --- 3. env del tenant --------------------------------------------------------
# Hereda LLM/embedder del mcp.env compartido (el unit carga los dos archivos,
# el del tenant al final, asi que solo definimos aqui lo especifico del tenant).
info "escribiendo ${ENVFILE}"
TMP_ENV="$(mktemp)"
cat > "${TMP_ENV}" <<EOF
# Tenant '${SLUG}' — deploy nativo. Generado por provision-tenant-native.sh.
# Se carga DESPUES de ${SHARED_ENV} en el unit brain-mcp@${SLUG}, por lo que
# las variables de LLM/embedder/API keys se heredan de ahi y aqui solo va lo
# propio del tenant. NO editar a mano el password: vive en ${ACL_FILE}.
TENANT_NAME=${SLUG}
MCP_PORT=${PORT}

# Credenciales del usuario ACL propio (no el admin). La auth va embebida en la
# URI; FALKORDB_PASSWORD queda vacio a proposito (el server usa la URI).
FALKORDB_URI=redis://tenant_${SLUG}:${TENANT_PASS}@127.0.0.1:${FALKORDB_PORT}
FALKORDB_PASSWORD=
FALKORDB_DATABASE=${SLUG}

# Namespace de Graphiti dentro del grafo propio.
GRAPHITI_GROUP_ID=${SLUG}

# config.yaml propio: es el UNICO sitio de donde el server lee su puerto.
CONFIG_PATH=${CONFFILE}
EOF
install -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 600 "${TMP_ENV}" "${ENVFILE}"
rm -f "${TMP_ENV}"

# --- 4. config.yaml del tenant ------------------------------------------------
# El server Graphiti lee el puerto SOLO del YAML (src/config/schema.py resuelve
# CONFIG_PATH); no hay variable de entorno para el puerto. Por eso generamos un
# config.yaml por tenant desde la plantilla del repo.
TEMPLATE="${CONFIG_TEMPLATE:-}"
if [[ -z "${TEMPLATE}" ]]; then
  for cand in "${BRAIN_ROOT}/config.yaml.template" "${SCRIPT_DIR}/config.yaml.template"; do
    [[ -f "${cand}" ]] && { TEMPLATE="${cand}"; break; }
  done
fi
[[ -n "${TEMPLATE}" && -f "${TEMPLATE}" ]] \
  || die "no encuentro config.yaml.template (busque en ${BRAIN_ROOT}/ y ${SCRIPT_DIR}/; o define CONFIG_TEMPLATE)"

info "escribiendo ${CONFFILE} (host 127.0.0.1, puerto ${PORT}) desde ${TEMPLATE}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 700 "${CONFDIR}"
TMP_CFG="$(mktemp)"
sed -e "s/__MCP_PORT__/${PORT}/g" -e "s/__MCP_HOST__/127.0.0.1/g" "${TEMPLATE}" > "${TMP_CFG}"
grep -q '__MCP_' "${TMP_CFG}" && die "quedaron placeholders sin sustituir en la plantilla ${TEMPLATE}"
install -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 600 "${TMP_CFG}" "${CONFFILE}"
rm -f "${TMP_CFG}"

# --- 5. Unit systemd (instancia del template) ---------------------------------
UNIT_SRC="${SCRIPT_DIR}/brain-mcp@.service"
UNIT_DST="/etc/systemd/system/brain-mcp@.service"
if [[ -f "${UNIT_SRC}" ]]; then
  if ! cmp -s "${UNIT_SRC}" "${UNIT_DST}" 2>/dev/null; then
    info "instalando ${UNIT_DST}"
    install -m 644 "${UNIT_SRC}" "${UNIT_DST}"
  fi
fi
[[ -f "${UNIT_DST}" ]] || die "falta el unit template ${UNIT_DST} (y no esta ${UNIT_SRC} para instalarlo)"

info "systemctl daemon-reload && enable --now brain-mcp@${SLUG}"
systemctl daemon-reload
systemctl enable "brain-mcp@${SLUG}" >/dev/null
# restart (no start) para que un re-run tome cambios de env/config.
systemctl restart "brain-mcp@${SLUG}"

# --- 6. Firewall local: el puerto nuevo tambien restringido por uid -----------
# Mantener sincronizada la copia instalada con la del repo: la version vieja
# tenia el puerto 8021 hardcodeado y dejaria el puerto nuevo SIN restringir.
if [[ -f "${SCRIPT_DIR}/firewall-local.sh" ]] && ! cmp -s "${SCRIPT_DIR}/firewall-local.sh" "${FIREWALL_SH}"; then
  info "actualizando ${FIREWALL_SH} desde el repo"
  install -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 700 "${SCRIPT_DIR}/firewall-local.sh" "${FIREWALL_SH}"
fi
if [[ -x "${FIREWALL_SH}" ]]; then
  info "reaplicando firewall local (${FIREWALL_SH})"
  "${FIREWALL_SH}" || echo "AVISO: firewall-local.sh fallo; revisa iptables" >&2
else
  echo "AVISO: no existe ${FIREWALL_SH}; el puerto ${PORT} NO queda restringido por uid" >&2
fi

# --- 7. Health check ----------------------------------------------------------
info "esperando health en 127.0.0.1:${PORT}/health ..."
HEALTH_OK=0
for _ in $(seq 1 60); do
  if curl -fsS -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
  if ! systemctl is-active --quiet "brain-mcp@${SLUG}"; then break; fi
  sleep 2
done

if [[ "${HEALTH_OK}" != "1" ]]; then
  echo "ERROR: brain-mcp@${SLUG} no respondio /health en 127.0.0.1:${PORT}" >&2
  echo "--- systemctl status ---" >&2
  systemctl status "brain-mcp@${SLUG}" --no-pager -l >&2 || true
  echo "--- journalctl (ultimas 60) ---" >&2
  journalctl -u "brain-mcp@${SLUG}" -n 60 --no-pager >&2 || true
  exit 1
fi

echo
echo "OK: tenant '${SLUG}' aprovisionado."
echo "    unit    : brain-mcp@${SLUG} ($(systemctl is-active "brain-mcp@${SLUG}"))"
echo "    env     : ${ENVFILE}"
echo "    config  : ${CONFFILE}"
echo "    upstream: http://127.0.0.1:${PORT}/mcp"
echo "    health  : $(curl -fsS -m 3 "http://127.0.0.1:${PORT}/health")"
