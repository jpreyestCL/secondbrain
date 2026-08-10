#!/usr/bin/env bash
# Restringe el acceso LOCAL al MCP (8021) y al gateway (8787): solo los usuarios
# dev (servicios), root (admin) y www-data (nginx -> gateway) pueden conectarse.
# Necesario porque el server es compartido: sin esto, cualquier usuario local
# hablaria con el MCP sin pasar por el OAuth del gateway.
set -euo pipefail
apply() {
  local PORT=$1; shift
  for u in "$@"; do
    while iptables -D OUTPUT -o lo -p tcp --dport "$PORT" -m owner --uid-owner "$u" -j ACCEPT 2>/dev/null; do :; done
  done
  while iptables -D OUTPUT -o lo -p tcp --dport "$PORT" -j REJECT 2>/dev/null; do :; done
  iptables -I OUTPUT 1 -o lo -p tcp --dport "$PORT" -j REJECT
  for u in "$@"; do
    iptables -I OUTPUT 1 -o lo -p tcp --dport "$PORT" -m owner --uid-owner "$u" -j ACCEPT
  done
}
apply 8021 secondbrain root
apply 8787 secondbrain root www-data
