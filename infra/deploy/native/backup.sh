#!/usr/bin/env bash
# Backup del grafo FalkorDB del deploy nativo. Lo dispara brain-backup.timer
# (diario 03:30) y tambien se puede correr a mano.
# Una sola instancia FalkorDB sirve a TODOS los tenants, asi que un dump cubre
# todos los grafos.
# Instalado en /opt/secondbrain-native/backup.sh (secondbrain:secondbrain 0750).
set -euo pipefail
umask 077   # los backups contienen el grafo completo: solo secondbrain
DIR="${BRAIN_ROOT:-/opt/secondbrain-native}"
PORT="${FALKORDB_PORT:-6380}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

# Password del usuario admin (default) desde el aclfile.
ADMIN=$(grep '^user default' "$DIR/users.acl" | grep -oE '>[^ ]+' | head -1 | tr -d '>')
[ -n "$ADMIN" ] || { echo "ERROR: no pude leer el password admin de $DIR/users.acl" >&2; exit 1; }

# BGSAVE es asincrono: esperamos a que rdb_bgsave_in_progress vuelva a 0.
"$DIR/bin/redis-cli" -p "$PORT" -a "$ADMIN" --no-auth-warning BGSAVE >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  INPROG=$("$DIR/bin/redis-cli" -p "$PORT" -a "$ADMIN" --no-auth-warning INFO persistence 2>/dev/null \
           | sed -n 's/^rdb_bgsave_in_progress:\([0-9]*\).*/\1/p')
  [ "${INPROG:-1}" = "0" ] && break
  sleep 1
done

TS=$(date +%Y%m%d-%H%M%S)
tar czf "$DIR/backups/falkor-$TS.tar.gz" -C "$DIR/data" dump.rdb 2>/dev/null || true
[ -s "$DIR/backups/falkor-$TS.tar.gz" ] || { echo "ERROR: backup vacio o no creado" >&2; exit 1; }
find "$DIR/backups" -name 'falkor-*.tar.gz' -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true
echo "backup $TS OK ($(du -h "$DIR/backups/falkor-$TS.tar.gz" | cut -f1))"
