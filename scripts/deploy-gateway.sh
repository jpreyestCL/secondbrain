#!/usr/bin/env bash
# Despliega el gateway al servidor nativo.
#
#   scripts/deploy-gateway.sh [usuario@host]
#
# Existe porque hacerlo a mano ya costo dos incidentes:
#
#   1. Un `rsync --delete` de src/ borro `tenants.json`, que vive en el mismo
#      directorio del servidor pero NO existe en el repo. El gateway se quedo
#      sin el mapa de usuarios y respondio 403 a todo: la ingesta del dueno
#      murio a mitad de un lote. Aqui `--delete` no se usa nunca, y ademas se
#      comprueba que el archivo siga ahi ANTES de reiniciar.
#
#   2. `install.sh` vive en `scripts/` y el despliegue solo copiaba `src/` y
#      `dist/`, asi que `curl https://.../install.sh` respondia 503 desde el
#      primer dia. Nadie lo noto porque nadie lo probo despues de desplegar.
#
# Por eso al final verifica contra el servidor lo que un usuario haria.
set -euo pipefail

DESTINO="${1:-root@37.27.190.92}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTO="/opt/secondbrain-native/gateway"

cd "$RAIZ/gateway"

echo "==> tests"
npx tsc --noEmit
npx vitest run --silent

echo "==> build"
npm run build

echo "==> subiendo fuentes y dist"
# SIN --delete: en el servidor conviven archivos que no estan en el repo
# (tenants.json, .env, data/). Borrarlos deja el servicio inservible.
rsync -az \
  --exclude data --exclude dist --exclude node_modules \
  --exclude '.env*' --exclude '.owner-password.txt' --exclude 'tenants.json' \
  src/ "$DESTINO:$REMOTO/"
rsync -az dist/ "$DESTINO:$REMOTO/dist/"

echo "==> subiendo el instalador del CLI"
# El gateway lo busca en dist/../install.sh; en el repo vive en scripts/.
rsync -az "$RAIZ/scripts/install.sh" "$DESTINO:$REMOTO/install.sh"

echo "==> comprobando que el estado del servidor sigue intacto"
ssh "$DESTINO" "test -s $REMOTO/tenants.json" \
  || { echo "ABORTADO: falta tenants.json en el servidor (sin el, 403 para todos)"; exit 1; }
ssh "$DESTINO" "test -s $REMOTO/.env" \
  || { echo "ABORTADO: falta .env en el servidor"; exit 1; }

echo "==> reiniciando"
ssh "$DESTINO" "chown -R secondbrain:secondbrain $REMOTO/install.sh $REMOTO/dist && systemctl restart brain-gateway"
sleep 4
ssh "$DESTINO" "systemctl is-active brain-gateway"

echo "==> verificando como lo haria un usuario"
BASE="$(ssh "$DESTINO" "grep -m1 '^BASE_URL=' $REMOTO/.env | cut -d= -f2-" | tr -d '\r')"
BASE="${BASE:-https://mybrain.rlz.cl}"
fallos=0
for ruta in / /guia /login /install.sh; do
  codigo="$(curl -s -o /dev/null -w '%{http_code}' "$BASE$ruta")"
  printf '    %-14s %s\n' "$ruta" "$codigo"
  [ "$codigo" = "200" ] || fallos=$((fallos + 1))
done
[ "$fallos" -eq 0 ] || { echo "HAY $fallos ruta(s) que no responden 200"; exit 1; }

echo "listo: $BASE"
