#!/usr/bin/env bash
# Despliegue del second brain en el servidor de dev (mybrain.rlz.cl).
# Se ejecuta DESDE el Mac:  bash infra/deploy/deploy.sh root@178.62.201.63
#
# Variables opcionales (se leen del entorno al ejecutar):
#   DEEPSEEK_API_KEY   clave para el extractor LLM (api.deepseek.com). Si falta,
#                      se despliega igual y queda pendiente en /opt/secondbrain/.env
#                      (se envia por stdin al servidor, nunca como argv: no
#                      queda visible en `ps` ni en el history remoto)
#   REGISTRATION_CODE  codigo de invitacion para /registro (default: se genera)
#
# Notas de red (Ubuntu):
#   - Ollama por defecto escucha en 127.0.0.1: los contenedores no lo alcanzan
#     via host-gateway (172.17.0.1). El paso [4/7] instala un drop-in systemd
#     con OLLAMA_HOST=0.0.0.0 y, si ufw esta activo, permite el puerto 11434
#     SOLO desde las subredes docker (172.16.0.0/12).
set -euo pipefail

TARGET="${1:?uso: deploy.sh user@host}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REMOTE_DIR=/opt/secondbrain

echo "==> [1/7] Sincronizando repo a ${TARGET}:${REMOTE_DIR}"
ssh "$TARGET" "mkdir -p ${REMOTE_DIR}"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude '*.sqlite*' \
  --exclude gateway/data --exclude gateway/dist --exclude gateway/gateway.log \
  --exclude infra/data --exclude backups --exclude archive --exclude inbox \
  --exclude .env --exclude gateway/.env --exclude gateway/tenants.json \
  --exclude 'infra/tenants/*.env' --exclude infra/falkordb/users.acl \
  --exclude infra/docker-compose.tenants.yml --exclude gateway/.owner-password.txt \
  "$REPO_ROOT"/ "$TARGET":"$REMOTE_DIR"/

echo "==> [2/7] Instalando dependencias del sistema (docker, node, nginx, make)"
ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; }
command -v make >/dev/null || apt-get install -y -q make
command -v nginx >/dev/null || apt-get install -y -q nginx
command -v rsync >/dev/null || apt-get install -y -q rsync
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
systemctl enable --now docker
REMOTE

echo "==> [3/7] Configurando .env raiz y del gateway"
# Los secretos viajan por STDIN (2 primeras lineas), no como argv remoto:
# un argv es visible en `ps aux` para cualquier usuario del servidor.
{
  printf '%s\n%s\n' "${DEEPSEEK_API_KEY:-}" "${REGISTRATION_CODE:-}"
  cat <<'REMOTE'
set -euo pipefail
cd /opt/secondbrain
if [ ! -f .env ]; then
  [ -n "${REG_CODE}" ] || REG_CODE=$(openssl rand -hex 8)
  cat > .env <<EOF
# Password del usuario 'default' de FalkorDB (admin/healthcheck/backups).
# Obligatorio; los tenants usan sus propios usuarios ACL.
FALKORDB_PASSWORD=$(openssl rand -hex 24)
SEMAPHORE_LIMIT=10
# --- LLM: DeepSeek (API OpenAI-compatible) ---
LLM_PROVIDER=openai
MODEL_NAME=deepseek-chat
OPENAI_API_KEY=${DS_KEY:-PENDIENTE_DEEPSEEK_API_KEY}
OPENAI_API_URL=https://api.deepseek.com/v1
ANTHROPIC_API_KEY=
# --- Embeddings: Ollama local del servidor (DeepSeek no ofrece embeddings) ---
EMBEDDER_PROVIDER=openai
EMBEDDER_MODEL=mxbai-embed-large
EMBEDDER_DIMENSIONS=1024
EMBEDDER_API_URL=http://host.docker.internal:11434/v1
VOYAGE_API_KEY=
EOF
  echo "creado .env raiz"
fi
# Migracion: .env de despliegues anteriores con FALKORDB_PASSWORD vacio
if grep -q '^FALKORDB_PASSWORD=$' .env; then
  sed -i "s/^FALKORDB_PASSWORD=$/FALKORDB_PASSWORD=$(openssl rand -hex 24)/" .env
  echo "FALKORDB_PASSWORD generado en .env (antes estaba vacio)"
fi
if [ ! -f gateway/.env ]; then
  cat > gateway/.env <<EOF
BASE_URL=https://mybrain.rlz.cl
AUTH_SECRET=$(openssl rand -hex 32)
PORT=8787
HOST=127.0.0.1
ALLOW_SIGNUP=false
REGISTRATION_CODE=${REG_CODE}
BRAIN_REPO_ROOT=/opt/secondbrain
EOF
  echo "creado gateway/.env (codigo de registro: ${REG_CODE})"
fi
REMOTE
} | ssh "$TARGET" 'IFS= read -r DS_KEY; IFS= read -r REG_CODE; export DS_KEY REG_CODE; exec bash -s'

echo "==> [4/7] Ollama para embeddings (nativo, accesible desde docker)"
ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
command -v ollama >/dev/null || { curl -fsSL https://ollama.com/install.sh | sh; }
# En Ubuntu el systemd de ollama escucha en 127.0.0.1: inalcanzable desde los
# contenedores via host-gateway (172.17.0.1). Drop-in con OLLAMA_HOST=0.0.0.0
# + regla ufw que limita 11434 a las subredes docker (172.16.0.0/12).
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/10-listen-all.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
EOF
systemctl daemon-reload
systemctl enable ollama 2>/dev/null || true
systemctl restart ollama
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw allow from 172.16.0.0/12 to any port 11434 proto tcp comment 'ollama solo desde docker' >/dev/null
  echo "ufw: 11434 permitido solo desde 172.16.0.0/12"
fi
sleep 2
ollama pull mxbai-embed-large 2>&1 | tail -1
REMOTE

echo "==> [5/7] Levantando stack: falkordb + tenant jpreyest + gateway + backup timer"
ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
cd /opt/secondbrain
# LLM=DeepSeek (OPENAI_API_URL) + embeddings=Ollama local (EMBEDDER_API_URL).
[ -f infra/tenants/jpreyest.env ] || bash infra/scripts/add-tenant.sh jpreyest 9021
make up
# Build del gateway: npm ci COMPLETO (tsc es devDependency; --omit=dev romperia
# `npm run build`), compilar y recien despues podar las deps de desarrollo.
cd gateway
npm ci
npm run build
npm prune --omit=dev
cd ..
install -m 644 infra/deploy/brain-gateway.service /etc/systemd/system/brain-gateway.service
# Respaldo diario 03:30 via systemd timer (backup.sh, retiene 30 dias)
install -m 644 infra/deploy/brain-backup.service /etc/systemd/system/brain-backup.service
install -m 644 infra/deploy/brain-backup.timer /etc/systemd/system/brain-backup.timer
systemctl daemon-reload
systemctl enable --now brain-gateway
systemctl restart brain-gateway
systemctl enable --now brain-backup.timer
sleep 2 && curl -fsS http://127.0.0.1:8787/health
REMOTE

echo "==> [6/7] nginx + TLS self-signed (Cloudflare modo Full)"
ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
mkdir -p /etc/nginx/ssl /etc/nginx/snippets
[ -f /etc/nginx/ssl/mybrain.key ] || openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/mybrain.key -out /etc/nginx/ssl/mybrain.crt \
  -days 3650 -subj "/CN=mybrain.rlz.cl"
# Snippet real-ip de Cloudflare: se genera desde las listas oficiales; si la
# descarga falla se cae a la lista fija conocida (2026) para no romper deploy.
TMP4=$(mktemp); TMP6=$(mktemp)
if curl -fsS -m 10 https://www.cloudflare.com/ips-v4 -o "$TMP4" \
   && curl -fsS -m 10 https://www.cloudflare.com/ips-v6 -o "$TMP6" \
   && grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$' "$TMP4"; then
  {
    echo "# GENERADO por deploy.sh $(date -u +%Y-%m-%d) desde cloudflare.com/ips-v4 + ips-v6"
    grep -hE '^[0-9a-fA-F:.]+/[0-9]+$' "$TMP4" "$TMP6" | sed 's/^/set_real_ip_from /; s/$/;/'
    echo "real_ip_header CF-Connecting-IP;"
  } > /etc/nginx/snippets/cloudflare-real-ip.conf
  echo "snippet cloudflare-real-ip.conf generado desde cloudflare.com"
else
  cat > /etc/nginx/snippets/cloudflare-real-ip.conf <<'EOF'
# FALLBACK: lista fija de rangos Cloudflare (la descarga en deploy fallo).
# Fuente: https://www.cloudflare.com/ips/
set_real_ip_from 173.245.48.0/20;
set_real_ip_from 103.21.244.0/22;
set_real_ip_from 103.22.200.0/22;
set_real_ip_from 103.31.4.0/22;
set_real_ip_from 141.101.64.0/18;
set_real_ip_from 108.162.192.0/18;
set_real_ip_from 190.93.240.0/20;
set_real_ip_from 188.114.96.0/20;
set_real_ip_from 197.234.240.0/22;
set_real_ip_from 198.41.128.0/17;
set_real_ip_from 162.158.0.0/15;
set_real_ip_from 104.16.0.0/13;
set_real_ip_from 104.24.0.0/14;
set_real_ip_from 172.64.0.0/13;
set_real_ip_from 131.0.72.0/22;
set_real_ip_from 2400:cb00::/32;
set_real_ip_from 2606:4700::/32;
set_real_ip_from 2803:f800::/32;
set_real_ip_from 2405:b500::/32;
set_real_ip_from 2405:8100::/32;
set_real_ip_from 2a06:98c0::/29;
set_real_ip_from 2c0f:f248::/32;
real_ip_header CF-Connecting-IP;
EOF
  echo "AVISO: no se pudo descargar la lista de IPs de Cloudflare; usando fallback fijo"
fi
rm -f "$TMP4" "$TMP6"
install -m 644 /opt/secondbrain/infra/deploy/nginx-mybrain.conf /etc/nginx/sites-available/mybrain.conf
ln -sf /etc/nginx/sites-available/mybrain.conf /etc/nginx/sites-enabled/mybrain.conf
nginx -t && systemctl reload nginx
REMOTE

echo "==> [7/7] Smoke test post-deploy"
ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
fail() { echo ""; echo "SMOKE TEST FALLO: $*" >&2; exit 1; }
curl -fsS -m 5 http://127.0.0.1:8787/health >/dev/null \
  || fail "gateway /health no responde. Revisar: systemctl status brain-gateway ; journalctl -u brain-gateway -n 50"
echo "  gateway /health OK"
curl -fsS -m 10 http://127.0.0.1:9021/health >/dev/null \
  || fail "MCP jpreyest /health no responde. Revisar: docker logs brain-mcp-jpreyest --tail 50 ; make status"
echo "  MCP jpreyest /health OK"
docker exec -i brain-mcp-jpreyest python3 - <<'PY' \
  || fail "embeddings de Ollama INACCESIBLES desde el contenedor. Remediar: (1) systemctl cat ollama (debe tener OLLAMA_HOST=0.0.0.0 y estar reiniciado), (2) si ufw esta activo: ufw allow from 172.16.0.0/12 to any port 11434 proto tcp, (3) ollama list debe incluir mxbai-embed-large"
import json, urllib.request
req = urllib.request.Request(
    "http://host.docker.internal:11434/v1/embeddings",
    data=json.dumps({"model": "mxbai-embed-large", "input": "smoke test"}).encode(),
    headers={"Content-Type": "application/json"},
)
resp = json.load(urllib.request.urlopen(req, timeout=60))
dim = len(resp["data"][0]["embedding"])
assert dim > 0
print(f"  embeddings Ollama OK (dim={dim})")
PY
echo "Smoke test OK: gateway, MCP y embeddings responden"
REMOTE

echo "==> Despliegue OK. Pendientes manuales:"
echo "    1) Cloudflare: registro A mybrain.rlz.cl -> IP del server (proxied) + SSL mode 'Full'"
echo "    2) Crear owner:  ssh $TARGET 'cd /opt/secondbrain/gateway && npm run create-owner -- email pass'"
echo "    3) Si falto DEEPSEEK_API_KEY, editarla en /opt/secondbrain/.env y 'make up'"
