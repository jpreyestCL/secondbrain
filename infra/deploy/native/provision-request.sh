#!/usr/bin/env bash
# Solicita el aprovisionamiento de un tenant SIN privilegios.
#
# Por qué existe: el gateway corre como servicio de sistema endurecido
# (NoNewPrivileges + namespaces), así que no puede usar sudo NI hablar con el
# systemd de usuario — systemd le da un /run/user privado donde el bus no
# existe. En vez de debilitar ese aislamiento, se separan privilegios:
#
#   gateway (secondbrain)  ->  deja una solicitud en spool/
#   brain-provision.path   ->  la detecta y la ejecuta con privilegios
#   este script            ->  espera el resultado y devuelve su código
#
# Uso: provision-request.sh <slug> <puerto>
set -euo pipefail

BRAIN_ROOT="${BRAIN_ROOT:-/opt/secondbrain-native}"
SPOOL="${BRAIN_ROOT}/spool"
TIMEOUT="${PROVISION_TIMEOUT:-180}"

SLUG="${1:-}"; PORT="${2:-}"
[[ -n "${SLUG}" && -n "${PORT}" ]] || { echo "uso: $0 <slug> <puerto>" >&2; exit 2; }
# Validación defensiva: el lado con privilegios vuelve a validar, pero no se
# escribe una solicitud con formato inesperado.
[[ "${SLUG}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "slug invalido: ${SLUG}" >&2; exit 2; }
[[ "${PORT}" =~ ^[0-9]+$ ]] || { echo "puerto invalido: ${PORT}" >&2; exit 2; }

mkdir -p "${SPOOL}"
REQ="${SPOOL}/${SLUG}.request"
RES="${SPOOL}/${SLUG}.result"
rm -f "${RES}"

printf '%s %s\n' "${SLUG}" "${PORT}" > "${REQ}.tmp"
mv "${REQ}.tmp" "${REQ}"          # atómico: el .path dispara con el rename
echo ">> solicitud enviada (${SLUG}:${PORT}); esperando al aprovisionador..."

for _ in $(seq 1 "${TIMEOUT}"); do
  if [[ -f "${RES}" ]]; then
    STATUS="$(head -1 "${RES}")"
    sed -n '2,$p' "${RES}"
    rm -f "${RES}"
    [[ "${STATUS}" == "OK" ]] && exit 0 || exit 1
  fi
  sleep 1
done

echo "ERROR: el aprovisionador no respondió en ${TIMEOUT}s (¿está activo brain-provision.path?)" >&2
exit 1
