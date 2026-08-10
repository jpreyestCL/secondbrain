#!/usr/bin/env bash
# Lado CON privilegios del aprovisionamiento (lo dispara brain-provision.path).
#
# Lee las solicitudes que dejó el gateway en spool/, las valida OTRA VEZ (nunca
# se confía en el contenido del spool) y ejecuta el aprovisionamiento real como
# el usuario del servicio, que es quien puede hablar con su systemd --user.
#
# El gateway solo puede pedir "crea el tenant <slug> en el puerto <port>"; no
# puede ejecutar nada arbitrario.
set -euo pipefail

BRAIN_ROOT="${BRAIN_ROOT:-/opt/secondbrain-native}"
SPOOL="${BRAIN_ROOT}/spool"
SERVICE_USER="${SERVICE_USER:-secondbrain}"
PROVISION="${BRAIN_ROOT}/provision-tenant-native.sh"
UID_SB="$(id -u "${SERVICE_USER}")"

shopt -s nullglob
for REQ in "${SPOOL}"/*.request; do
  SLUG_FILE="$(basename "${REQ}" .request)"
  read -r SLUG PORT < "${REQ}" || true
  RES="${SPOOL}/${SLUG_FILE}.result"
  rm -f "${REQ}"

  {
    # Validación en el lado privilegiado: el spool es escribible por el gateway.
    if [[ ! "${SLUG:-}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || [[ "${SLUG}" != "${SLUG_FILE}" ]]; then
      echo "ERROR"; echo "slug invalido o no coincide con el archivo: '${SLUG:-}' vs '${SLUG_FILE}'"
    elif [[ ! "${PORT:-}" =~ ^[0-9]+$ ]] || (( PORT < 9000 || PORT > 9999 )); then
      # Rango 9000-9999: es el que cubre la regla de firewall instalada una vez.
      echo "ERROR"; echo "puerto fuera del rango permitido 9000-9999: '${PORT:-}'"
    else
      OUT="$(sudo -u "${SERVICE_USER}" \
              env HOME="${BRAIN_ROOT}" \
                  XDG_RUNTIME_DIR="/run/user/${UID_SB}" \
                  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${UID_SB}/bus" \
                  "${PROVISION}" "${SLUG}" "${PORT}" 2>&1)" && ST=0 || ST=$?
      if [[ ${ST} -eq 0 ]]; then echo "OK"; else echo "ERROR"; fi
      echo "${OUT}"
    fi
  } > "${RES}.tmp"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${RES}.tmp"
  mv "${RES}.tmp" "${RES}"
done
