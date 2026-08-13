#!/usr/bin/env bash
# Instalador del CLI `brain`.
#
#   curl -fsSL https://mybrain.rlz.cl/install.sh | sh
#
# Deja el comando `brain` disponible desde cualquier carpeta. No pide ninguna
# clave de API: la extraccion de entidades ocurre en el servidor, con sus
# modelos. En este equipo solo corren la lectura de archivos, el OCR y el
# troceado, que no usan LLM.
#
# Que hace:
#   1. Instala uv si falta (gestor de Python; no toca tu Python del sistema).
#   2. Clona el repo en ~/.local/share/secondbrain (o lo actualiza).
#   3. Prepara el entorno desde uv.lock — versiones exactas, no "las ultimas".
#   4. Escribe el lanzador ~/.local/bin/brain.
#
# Idempotente: correrlo de nuevo actualiza en vez de duplicar.
set -euo pipefail

REPO_URL="${BRAIN_REPO_URL:-https://github.com/jpreyestCL/secondbrain.git}"
DESTINO="${BRAIN_HOME_DIR:-$HOME/.local/share/secondbrain}"
BIN_DIR="${BRAIN_BIN_DIR:-$HOME/.local/bin}"
# Servidor sugerido para `brain login`. Se puede fijar al servir el script.
SERVIDOR="${BRAIN_SERVER:-https://mybrain.rlz.cl}"

rojo()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
info()  { printf '  %s\n' "$*"; }
paso()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

paso "1/4  Comprobando dependencias"

if ! command -v git >/dev/null 2>&1; then
  rojo "Falta git. En macOS: xcode-select --install"
  exit 1
fi
info "git    $(git --version | awk '{print $3}')"

if ! command -v uv >/dev/null 2>&1; then
  info "uv     no encontrado, instalando..."
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
  # El instalador de uv deja el binario aqui pero no lo pone en el PATH de
  # ESTA shell; se agrega a mano para poder seguir sin reabrir la terminal.
  export PATH="$HOME/.local/bin:$PATH"
fi
if ! command -v uv >/dev/null 2>&1; then
  rojo "uv no quedo disponible. Reabre la terminal y vuelve a ejecutar."
  exit 1
fi
info "uv     $(uv --version | awk '{print $2}')"

paso "2/4  Descargando el CLI"

if [ -d "$DESTINO/.git" ]; then
  info "actualizando $DESTINO"
  git -C "$DESTINO" fetch --quiet origin
  git -C "$DESTINO" reset --quiet --hard origin/main
else
  info "clonando en $DESTINO"
  mkdir -p "$(dirname "$DESTINO")"
  git clone --quiet --depth 1 "$REPO_URL" "$DESTINO"
fi

paso "3/4  Preparando el entorno"
# --frozen: instala EXACTAMENTE lo que fija uv.lock. Sin esto, uv resolveria
# por su cuenta y traeria versiones no probadas del cliente de OpenAI.
# --all-extras: incluye el OCR nativo de macOS para PDFs escaneados.
( cd "$DESTINO/ingest" && uv sync --quiet --frozen --all-extras )
info "listo (versiones fijadas por uv.lock)"

paso "4/4  Instalando el comando"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/brain" <<SH
#!/usr/bin/env bash
# Lanzador del CLI \`brain\` (generado por install.sh).
set -euo pipefail
exec uv run --quiet --project "$DESTINO/ingest" --all-extras brain "\$@"
SH
chmod +x "$BIN_DIR/brain"
info "$BIN_DIR/brain"

printf '\n\033[32mInstalado.\033[0m\n\n'

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    rojo "OJO: $BIN_DIR no esta en tu PATH."
    echo  "     Agrega esta linea a tu ~/.bashrc o ~/.zshrc y reabre la terminal:"
    echo  "       export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo
    ;;
esac

cat <<FIN
Siguiente paso — vincular con tu cuenta (se hace una sola vez):

    brain login ${SERVIDOR}

Se abre el navegador para autenticarte. Despues, para ingerir una carpeta:

    brain add ~/Documentos/inbox

Eso lee los archivos (con OCR si hace falta), determina dominio, tipo y la
fecha REAL de cada documento, los trocea y los envia. Agrega --revisar si
quieres mirar la clasificacion antes de que se envie.

No necesitas ninguna clave de API: la extraccion la hace el servidor.
Ver en que va todo:  brain status
FIN
