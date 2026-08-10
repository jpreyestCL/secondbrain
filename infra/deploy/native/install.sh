#!/usr/bin/env bash
# Instalador reproducible del deploy NATIVO (sin Docker) del "second brain".
# Objetivo: desde un clone limpio del repo, en un Ubuntu 24.04, dejar corriendo
# FalkorDB + Graphiti MCP + firewall + backups, con un primer tenant listo.
#
# Uso (como root, desde el clone del repo):
#   infra/deploy/native/install.sh                       # tenant por defecto
#   TENANT=maria TENANT_PORT=9022 infra/deploy/native/install.sh
#   MCP_SRC_DIR=/ruta/a/mcp_server infra/deploy/native/install.sh
#
# IDEMPOTENTE: se puede re-ejecutar tantas veces como haga falta. Cada paso
# comprueba si ya esta hecho (binarios, usuario, dirs, secretos, units) y solo
# actua si falta o cambio. NO regenera passwords existentes ni pisa mcp.env.
#
# Lo que NO hace (queda manual, ver README.md): nginx + TLS, Cloudflare,
# secretos reales (API key del LLM), y el build/deploy del gateway OAuth.
set -euo pipefail

# ============================ Parametros ====================================
BRAIN_ROOT="${BRAIN_ROOT:-/opt/secondbrain-native}"
SERVICE_USER="${SERVICE_USER:-secondbrain}"
REDIS_VERSION="${REDIS_VERSION:-8.6.5}"
FALKORDB_VERSION="${FALKORDB_VERSION:-4.20.2}"
FALKORDB_PORT="${FALKORDB_PORT:-6380}"
TENANT="${TENANT:-jpreyest}"
TENANT_PORT="${TENANT_PORT:-8021}"
# Imagen oficial pineada de la que salen las fuentes del Graphiti MCP server.
MCP_IMAGE="${MCP_IMAGE:-zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2-standalone}"
MCP_IMAGE_SRC_PATH="${MCP_IMAGE_SRC_PATH:-/app}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
PATCHES_DIR="${REPO_ROOT}/infra/graphiti/patches"

die() { echo "ERROR: $*" >&2; exit 1; }
step() { echo; echo "=== $* ==="; }
info() { echo "  -> $*"; }
skip() { echo "  ok (ya estaba): $*"; }

as_user() { install -o "${SERVICE_USER}" -g "${SERVICE_USER}" "$@"; }

# ============================ 0. Preflight ==================================
step "0. Preflight"
[[ "${EUID}" -eq 0 ]] || die "hay que correr como root"
[[ -d "${PATCHES_DIR}" ]] || die "no encuentro los patches en ${PATCHES_DIR} (¿el script no esta dentro del repo?)"
command -v apt-get >/dev/null || die "este instalador asume Debian/Ubuntu (apt-get)"
ARCH="$(uname -m)"
[[ "${ARCH}" == "x86_64" ]] || die "falkordb-x64.so es x86_64; esta maquina es ${ARCH}"
info "repo: ${REPO_ROOT}"
info "destino: ${BRAIN_ROOT}"

# ============================ 1. Dependencias de build ======================
step "1. Dependencias de sistema"
DEPS=(build-essential pkg-config libssl-dev curl ca-certificates tar iptables procps)
MISSING=()
for p in "${DEPS[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if (( ${#MISSING[@]} )); then
  info "instalando: ${MISSING[*]}"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${MISSING[@]}"
else
  skip "todas las dependencias presentes"
fi

# ============================ 2. Usuario de sistema =========================
step "2. Usuario de sistema '${SERVICE_USER}'"
# Usuario propio (sin shell, sin home real): en un server compartido evita que
# otro proyecto comprometido lea los secretos del brain o hable con el MCP.
if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  skip "uid=$(id -u "${SERVICE_USER}")"
else
  info "useradd -r ${SERVICE_USER}"
  useradd -r -M -s /usr/sbin/nologin -d "${BRAIN_ROOT}" "${SERVICE_USER}"
fi

# ============================ 3. Layout de directorios ======================
step "3. Directorios y permisos"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 755 "${BRAIN_ROOT}"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 755 "${BRAIN_ROOT}/bin"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 755 "${BRAIN_ROOT}/falkordb"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 700 "${BRAIN_ROOT}/data"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 700 "${BRAIN_ROOT}/backups"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 700 "${BRAIN_ROOT}/tenants"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 755 "${BRAIN_ROOT}/mcp"
install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 700 "${BRAIN_ROOT}/.cache"
info "dirs listos (data/backups/tenants en 700)"

# ============================ 4. Redis compilado ============================
step "4. Redis ${REDIS_VERSION} (compilado de fuente)"
# FalkorDB v4.20.2 exige redis >= 8.0; el redis del sistema (7.0.x) ademas
# ocupa el 6379 de produccion. Por eso un redis propio en ${FALKORDB_PORT}.
NEED_REDIS=1
if [[ -x "${BRAIN_ROOT}/bin/redis-server" ]]; then
  CUR="$("${BRAIN_ROOT}/bin/redis-server" --version 2>/dev/null | sed -n 's/.*v=\([0-9.]*\).*/\1/p')"
  [[ "${CUR}" == "${REDIS_VERSION}" ]] && { NEED_REDIS=0; skip "redis-server v${CUR}"; }
fi
if (( NEED_REDIS )); then
  TARBALL="${BRAIN_ROOT}/redis-${REDIS_VERSION}.tar.gz"
  SRCDIR="${BRAIN_ROOT}/redis-${REDIS_VERSION}"
  if [[ ! -s "${TARBALL}" ]]; then
    info "descargando redis ${REDIS_VERSION}"
    curl -fSL --retry 3 -o "${TARBALL}" \
      "https://download.redis.io/releases/redis-${REDIS_VERSION}.tar.gz" \
      || curl -fSL --retry 3 -o "${TARBALL}" \
         "https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz" \
      || die "no pude descargar redis ${REDIS_VERSION}"
  fi
  [[ -d "${SRCDIR}" ]] || { info "extrayendo"; tar xzf "${TARBALL}" -C "${BRAIN_ROOT}"; }
  info "compilando (make -j$(nproc)) — puede tardar varios minutos"
  make -C "${SRCDIR}" -j"$(nproc)" >/tmp/redis-build.log 2>&1 \
    || { tail -40 /tmp/redis-build.log >&2; die "fallo el build de redis (log completo: /tmp/redis-build.log)"; }
  as_user -m 755 "${SRCDIR}/src/redis-server" "${BRAIN_ROOT}/bin/redis-server"
  as_user -m 755 "${SRCDIR}/src/redis-cli"    "${BRAIN_ROOT}/bin/redis-cli"
  info "instalado $("${BRAIN_ROOT}/bin/redis-server" --version | head -c 60)"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${BRAIN_ROOT}/bin"

# ============================ 5. Modulo FalkorDB ============================
step "5. Modulo FalkorDB v${FALKORDB_VERSION}"
SO="${BRAIN_ROOT}/falkordb/falkordb-x64.so"
if [[ -s "${SO}" && -x "${SO}" ]]; then
  skip "$(basename "${SO}") ($(du -h "${SO}" | cut -f1))"
else
  info "descargando falkordb-x64.so v${FALKORDB_VERSION}"
  curl -fSL --retry 3 -o "${SO}" \
    "https://github.com/FalkorDB/FalkorDB/releases/download/v${FALKORDB_VERSION}/falkordb-x64.so" \
    || die "no pude descargar el modulo FalkorDB"
  chmod +x "${SO}"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${SO}"
fi

# ============================ 6. falkordb.conf + users.acl ==================
step "6. falkordb.conf y users.acl"
CONF="${BRAIN_ROOT}/falkordb.conf"
if [[ -f "${CONF}" ]]; then
  skip "${CONF}"
else
  info "generando ${CONF}"
  TMP="$(mktemp)"
  cat > "${TMP}" <<EOF
port ${FALKORDB_PORT}
bind 127.0.0.1 -::1
loadmodule ${BRAIN_ROOT}/falkordb/falkordb-x64.so
dir ${BRAIN_ROOT}/data
appendonly yes
appendfsync everysec
save 900 1
save 300 100
aclfile ${BRAIN_ROOT}/users.acl
maxmemory 500mb
maxmemory-policy noeviction
EOF
  as_user -m 600 "${TMP}" "${CONF}"; rm -f "${TMP}"
fi

ACL_FILE="${BRAIN_ROOT}/users.acl"
if [[ -f "${ACL_FILE}" ]]; then
  skip "${ACL_FILE} ($(grep -c '^user ' "${ACL_FILE}") usuarios) — NO se regenera"
else
  # OJO: el formato aclfile de redis NO admite comentarios; cada linea es una
  # regla. El usuario 'default' es el admin (backups, ACL LOAD, healthcheck).
  info "generando ${ACL_FILE} con password admin nuevo"
  TMP="$(mktemp)"
  printf 'user default on >%s ~* &* +@all\n' "$(openssl rand -hex 24)" > "${TMP}"
  as_user -m 600 "${TMP}" "${ACL_FILE}"; rm -f "${TMP}"
fi

# ============================ 7. Fuentes del Graphiti MCP ===================
step "7. Fuentes del Graphiti MCP"
# Las fuentes vienen de la imagen PINEADA ${MCP_IMAGE} (no hay tarball oficial
# publicado del mcp_server para esa version). Tres formas de obtenerlas:
#   a) MCP_SRC_DIR=/ruta  -> copiar de un arbol ya existente (otro install).
#   b) docker disponible  -> docker create + docker cp de la imagen pineada.
#   c) ninguna            -> error con instrucciones para hacerlo a mano.
if [[ -f "${BRAIN_ROOT}/mcp/main.py" && -d "${BRAIN_ROOT}/mcp/src" ]]; then
  skip "fuentes ya presentes en ${BRAIN_ROOT}/mcp"
elif [[ -n "${MCP_SRC_DIR:-}" ]]; then
  [[ -f "${MCP_SRC_DIR}/main.py" ]] || die "MCP_SRC_DIR=${MCP_SRC_DIR} no contiene main.py"
  info "copiando fuentes desde ${MCP_SRC_DIR}"
  cp -a "${MCP_SRC_DIR}/." "${BRAIN_ROOT}/mcp/"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  info "extrayendo fuentes de la imagen ${MCP_IMAGE}"
  docker pull "${MCP_IMAGE}"
  CID="$(docker create "${MCP_IMAGE}")"
  trap 'docker rm -f "${CID}" >/dev/null 2>&1 || true' EXIT
  docker cp "${CID}:${MCP_IMAGE_SRC_PATH}/." "${BRAIN_ROOT}/mcp/"
  docker rm -f "${CID}" >/dev/null; trap - EXIT
else
  cat >&2 <<EOF
ERROR: no hay fuentes del Graphiti MCP en ${BRAIN_ROOT}/mcp y no puedo obtenerlas.
Vienen de la imagen pineada:
    ${MCP_IMAGE}
Opciones:
  1) En una maquina CON docker:
        docker pull ${MCP_IMAGE}
        CID=\$(docker create ${MCP_IMAGE})
        docker cp \$CID:${MCP_IMAGE_SRC_PATH} ./mcp_server
        docker rm \$CID
        tar czf mcp_server.tgz mcp_server && scp mcp_server.tgz root@<server>:/tmp/
     y en el server:  tar xzf /tmp/mcp_server.tgz -C /tmp && \\
        MCP_SRC_DIR=/tmp/mcp_server $0
  2) Copiar el arbol ${BRAIN_ROOT}/mcp de una instalacion existente y
     re-ejecutar este script.
EOF
  exit 1
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${BRAIN_ROOT}/mcp"

# --- Overlay de los 3 patches del repo ---
step "7b. Patches de infra/graphiti/patches/"
declare -A PATCH_MAP=(
  [graphiti_mcp_server.py]="src/graphiti_mcp_server.py"
  [queue_service.py]="src/services/queue_service.py"
  [factories.py]="src/services/factories.py"
)
PATCHED=0
for src in "${!PATCH_MAP[@]}"; do
  FROM="${PATCHES_DIR}/${src}"
  TO="${BRAIN_ROOT}/mcp/${PATCH_MAP[$src]}"
  [[ -f "${FROM}" ]] || die "falta el patch ${FROM}"
  [[ -d "$(dirname "${TO}")" ]] || die "el arbol MCP no tiene $(dirname "${TO}") (¿fuentes incompletas?)"
  if cmp -s "${FROM}" "${TO}"; then
    skip "${PATCH_MAP[$src]}"
  else
    info "aplicando ${src} -> ${PATCH_MAP[$src]}"
    as_user -m 644 "${FROM}" "${TO}"
    PATCHED=1
  fi
done
# Los .pyc viejos pueden ganarle al .py nuevo si el mtime queda raro.
(( PATCHED )) && find "${BRAIN_ROOT}/mcp/src" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true

# ============================ 8. uv + dependencias Python ===================
step "8. uv y dependencias Python"
if [[ -x /usr/local/bin/uv ]]; then
  skip "uv $(/usr/local/bin/uv --version | awk '{print $2}')"
else
  info "instalando uv en /usr/local/bin"
  curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh \
    || die "fallo la instalacion de uv"
fi
info "uv sync (como ${SERVICE_USER})"
setpriv --reuid="${SERVICE_USER}" --regid="${SERVICE_USER}" --clear-groups \
  env HOME="${BRAIN_ROOT}" UV_CACHE_DIR="${BRAIN_ROOT}/.cache/uv" XDG_CACHE_HOME="${BRAIN_ROOT}/.cache" \
  /usr/local/bin/uv sync --project "${BRAIN_ROOT}/mcp" \
  || die "uv sync fallo"

# ============================ 9. mcp.env compartido =========================
step "9. mcp.env (env compartido)"
SHARED_ENV="${BRAIN_ROOT}/mcp.env"
if [[ -f "${SHARED_ENV}" ]]; then
  skip "${SHARED_ENV} — NO se pisa (contiene secretos)"
else
  as_user -m 600 "${SCRIPT_DIR}/mcp.env.example" "${SHARED_ENV}"
  echo
  echo "  !! ${SHARED_ENV} se creo desde la plantilla. EDITALO antes de seguir:"
  echo "     - OPENAI_API_KEY (NVIDIA NIM: nvapi-...)"
  echo "     Luego re-ejecuta este script."
  exit 1
fi
grep -q 'CAMBIAR' "${SHARED_ENV}" && die "${SHARED_ENV} todavia tiene valores 'CAMBIAR'; completalo"

# ============================ 10. Scripts y units ===========================
step "10. Scripts, units systemd y timers"
as_user -m 700 "${SCRIPT_DIR}/firewall-local.sh" "${BRAIN_ROOT}/firewall-local.sh"
as_user -m 750 "${SCRIPT_DIR}/backup.sh"         "${BRAIN_ROOT}/backup.sh"
as_user -m 644 "${SCRIPT_DIR}/config.yaml.template" "${BRAIN_ROOT}/config.yaml.template"

for u in brain-falkordb.service brain-mcp@.service brain-firewall.service \
         brain-backup.service brain-backup.timer; do
  [[ -f "${SCRIPT_DIR}/${u}" ]] || die "falta ${SCRIPT_DIR}/${u}"
  if cmp -s "${SCRIPT_DIR}/${u}" "/etc/systemd/system/${u}"; then
    skip "${u}"
  else
    info "instalando ${u}"
    install -m 644 "${SCRIPT_DIR}/${u}" "/etc/systemd/system/${u}"
  fi
done
# El gateway se instala aparte (necesita el build de Node); si el unit del repo
# esta, lo dejamos alineado igual.
if [[ -f "${SCRIPT_DIR}/brain-gateway.service" && -d "${BRAIN_ROOT}/gateway" ]]; then
  cmp -s "${SCRIPT_DIR}/brain-gateway.service" /etc/systemd/system/brain-gateway.service \
    || install -m 644 "${SCRIPT_DIR}/brain-gateway.service" /etc/systemd/system/brain-gateway.service
fi

systemctl daemon-reload
systemctl enable --now brain-falkordb.service
systemctl enable --now brain-firewall.service
systemctl enable --now brain-backup.timer
info "brain-falkordb: $(systemctl is-active brain-falkordb.service)"

# Esperar a que FalkorDB acepte conexiones antes de aprovisionar.
ADMIN_PASS="$(grep -E '^user default ' "${ACL_FILE}" | grep -oE '>[^ ]+' | head -1 | tr -d '>')"
for _ in $(seq 1 30); do
  "${BRAIN_ROOT}/bin/redis-cli" -p "${FALKORDB_PORT}" --no-auth-warning -a "${ADMIN_PASS}" PING >/dev/null 2>&1 && break
  sleep 1
done

# ============================ 11. Primer tenant =============================
step "11. Tenant '${TENANT}' en el puerto ${TENANT_PORT}"
# Guarda de migracion: en la instalacion historica el tenant jpreyest lo sirve
# brain-mcp.service (unit NO template, leyendo mcp.env + mcp/config/config.yaml).
# Si ese unit sigue activo en el mismo puerto, aprovisionar brain-mcp@<slug>
# chocaria por puerto. En ese caso no tocamos nada y explicamos la migracion.
LEGACY_PORT=""
if systemctl is-active --quiet brain-mcp.service 2>/dev/null; then
  LEGACY_CFG="$(sed -n 's/^CONFIG_PATH=//p' "${SHARED_ENV}" | tail -1)"
  [[ -n "${LEGACY_CFG}" && -f "${LEGACY_CFG}" ]] && \
    LEGACY_PORT="$(sed -n 's/^[[:space:]]*port:[[:space:]]*\([0-9]\+\).*/\1/p' "${LEGACY_CFG}" | head -1)"
fi
if [[ -n "${LEGACY_PORT}" && "${LEGACY_PORT}" == "${TENANT_PORT}" ]]; then
  echo "  --   brain-mcp.service (unit legacy, NO template) ya sirve el puerto ${TENANT_PORT}."
  echo "       No se aprovisiona brain-mcp@${TENANT} para no chocar de puerto."
  echo "       Para migrar al unit template:"
  echo "         systemctl disable --now brain-mcp.service"
  echo "         ${SCRIPT_DIR}/provision-tenant-native.sh ${TENANT} ${TENANT_PORT}"
  echo "         # verificar /health y recien ahi: rm /etc/systemd/system/brain-mcp.service"
else
  BRAIN_ROOT="${BRAIN_ROOT}" FALKORDB_PORT="${FALKORDB_PORT}" SERVICE_USER="${SERVICE_USER}" \
    bash "${SCRIPT_DIR}/provision-tenant-native.sh" "${TENANT}" "${TENANT_PORT}"
fi

# ============================ 12. Smoke test ================================
step "12. Smoke test"
FAIL=0
check() { local n="$1"; shift; if "$@" >/dev/null 2>&1; then echo "  OK   ${n}"; else echo "  FAIL ${n}" >&2; FAIL=1; fi; }

PONG="$("${BRAIN_ROOT}/bin/redis-cli" -p "${FALKORDB_PORT}" --no-auth-warning -a "${ADMIN_PASS}" PING 2>/dev/null || true)"
[[ "${PONG}" == "PONG" ]] && echo "  OK   FalkorDB PING (auth admin, puerto ${FALKORDB_PORT})" \
                          || { echo "  FAIL FalkorDB PING -> '${PONG}'" >&2; FAIL=1; }

check "MCP /health (tenant ${TENANT}, puerto ${TENANT_PORT})" \
  curl -fsS -m 5 "http://127.0.0.1:${TENANT_PORT}/health"

if systemctl list-unit-files brain-gateway.service >/dev/null 2>&1 \
   && systemctl is-enabled brain-gateway.service >/dev/null 2>&1; then
  check "gateway /health (8787)" curl -fsS -m 5 "http://127.0.0.1:8787/health"
else
  echo "  --   gateway no instalado (paso manual, ver README)"
fi

check "backup.sh ejecutable por ${SERVICE_USER}" \
  setpriv --reuid="${SERVICE_USER}" --regid="${SERVICE_USER}" --clear-groups "${BRAIN_ROOT}/backup.sh"

echo
if (( FAIL )); then
  die "el smoke test fallo; revisa 'journalctl -u brain-mcp@${TENANT} -n 60'"
fi
echo "Instalacion completa. Estado:"
systemctl --no-pager --plain list-units 'brain-*' | sed 's/^/  /'
