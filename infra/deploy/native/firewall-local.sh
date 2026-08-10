#!/usr/bin/env bash
# Restringe el acceso LOCAL a los MCP de cada tenant y al gateway (8787): solo
# los usuarios secondbrain (servicios), root (admin) y www-data (nginx ->
# gateway) pueden conectarse. Necesario porque el server es compartido: sin
# esto, cualquier usuario local hablaria con un MCP saltandose el OAuth.
#
# Los puertos de MCP NO estan hardcodeados: se descubren de
# /opt/secondbrain-native/tenants/*.env (MCP_PORT=...), mas el puerto base del
# tenant historico (jpreyest, 8021), que sale de mcp.env.
#
# RECONCILIA: primero BORRA todas las reglas que este script haya creado y
# despues las vuelve a poner segun los tenants que existen ahora. Asi, al
# eliminar un tenant, su puerto deja de tener reglas huerfanas.
# Idempotente: correrlo N veces deja siempre el mismo estado.
set -euo pipefail

BRAIN_ROOT="${BRAIN_ROOT:-/opt/secondbrain-native}"
TENANTS_DIR="${BRAIN_ROOT}/tenants"
SHARED_ENV="${BRAIN_ROOT}/mcp.env"
GATEWAY_PORT="${GATEWAY_PORT:-8787}"

# --- Purga de reglas propias --------------------------------------------------
# Solo se borran reglas de OUTPUT con EXACTAMENTE la forma que genera este
# script (loopback + tcp + dport + (owner ACCEPT | REJECT)). Las cadenas de ufw
# cuelgan de saltos -j ufw-* y no matchean, asi que no se tocan.
purge() {
  local rule
  while read -r rule; do
    [[ -z "${rule}" ]] && continue
    # shellcheck disable=SC2086
    iptables -D OUTPUT ${rule} 2>/dev/null || true
  done < <(iptables -S OUTPUT | sed -n \
    -e 's/^-A OUTPUT \(-o lo -p tcp -m tcp --dport [0-9]\+ -m owner --uid-owner [0-9]\+ -j ACCEPT\)$/\1/p' \
    -e 's/^-A OUTPUT \(-o lo -p tcp -m tcp --dport [0-9]\+ -j REJECT --reject-with icmp-port-unreachable\)$/\1/p')
}

apply() {
  local PORT=$1; shift
  # El REJECT va primero y luego se insertan los ACCEPT por encima: las reglas
  # se meten al INICIO de OUTPUT porque ufw acepta loopback antes.
  iptables -I OUTPUT 1 -o lo -p tcp --dport "$PORT" -j REJECT
  for u in "$@"; do
    id -u "$u" >/dev/null 2>&1 || { echo "AVISO: usuario '$u' no existe; se omite" >&2; continue; }
    iptables -I OUTPUT 1 -o lo -p tcp --dport "$PORT" -m owner --uid-owner "$u" -j ACCEPT
  done
}

# --- Descubrir los puertos MCP ------------------------------------------------
declare -a MCP_PORTS=()
add_port() {
  local p="${1:-}"
  [[ "$p" =~ ^[0-9]+$ ]] || return 0
  local e; for e in "${MCP_PORTS[@]:-}"; do [[ "$e" == "$p" ]] && return 0; done
  MCP_PORTS+=("$p")
}

# Puerto base: el tenant historico lo sirve brain-mcp.service leyendo el
# config.yaml al que apunta CONFIG_PATH en mcp.env.
if [[ -f "${SHARED_ENV}" ]]; then
  add_port "$(sed -n 's/^MCP_PORT=//p' "${SHARED_ENV}" | tail -1)"
  BASE_CFG="$(sed -n 's/^CONFIG_PATH=//p' "${SHARED_ENV}" | tail -1)"
  if [[ -n "${BASE_CFG}" && -f "${BASE_CFG}" ]]; then
    add_port "$(sed -n 's/^[[:space:]]*port:[[:space:]]*\([0-9]\+\).*/\1/p' "${BASE_CFG}" | head -1)"
  fi
fi
add_port 8021   # fallback explicito del tenant base

shopt -s nullglob
for envfile in "${TENANTS_DIR}"/*.env; do
  add_port "$(sed -n 's/^MCP_PORT=//p' "${envfile}" | tail -1)"
done
shopt -u nullglob

# --- Reconciliar --------------------------------------------------------------
purge
for p in "${MCP_PORTS[@]}"; do
  apply "$p" secondbrain root
done
apply "${GATEWAY_PORT}" secondbrain root www-data

echo "firewall-local: MCP restringido en puertos: ${MCP_PORTS[*]}; gateway ${GATEWAY_PORT}"
