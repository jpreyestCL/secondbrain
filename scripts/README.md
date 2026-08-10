# `scripts/`

Utilidades operativas del second brain. Sin dependencias: todo corre con la
librería estándar de Python 3.12+ (o con `uv run`).

## `healthcheck.py` — sonda end-to-end

Hace un **round trip real** contra una instancia desplegada. No mockea nada: si
sale `0`, el sistema completo (gateway, OAuth, proxy multi-tenant, MCP,
Graphiti, FalkorDB, LLM y embedder) está funcionando.

Pasos:

| # | Paso | Qué verifica |
|---|---|---|
| 1 | `GET /.well-known/oauth-authorization-server` | descubrimiento RFC 8414 |
| 2 | `POST /api/auth/sign-in/email` | login email+password → cookie de sesión |
| 3 | `POST /api/auth/mcp/register` | registro dinámico de cliente (DCR, RFC 7591) |
| 4 | `GET /api/auth/mcp/authorize` | PKCE **S256** → código de autorización |
| 5 | `POST /api/auth/mcp/token` | canje del código → `access_token` |
| 6 | `POST /mcp` `initialize` + `notifications/initialized` | handshake MCP, `Mcp-Session-Id`, tenant resuelto |
| 7 | `tools/call add_memory` | escribe un **canario** con marcador único y `reference_time` |
| 8 | poll `get_episodes` + `search_memory_facts` | el canario se persiste **y** se vuelve buscable (cola de ingesta + extracción + embeddings vivos) |
| 9 | `tools/call delete_episode` | **limpia el canario** para no ensuciar el grafo |

Detalles importantes:

- El `redirect_uri` debe estar en la **allowlist del gateway**
  (`ALLOWED_REDIRECT_HOSTS`, por defecto `claude.ai,claude.com,anthropic.com`
  más loopback). El default del script es
  `https://claude.ai/api/mcp/auth_callback`, que es el callback real de
  claude.ai. **El script nunca sigue ese redirect** — lee el `code` del header
  `Location` del 302, así que el código jamás sale hacia claude.ai.
- `add_memory` es **asíncrono** (encola y responde de inmediato), por eso el
  paso 8 hace polling acotado por `BRAIN_TIMEOUT`.
- La limpieza (paso 9) se ejecuta **siempre**, incluso si la sonda falló, para
  que un run roto no deje canarios en el grafo. Si no logra borrarlo, lo avisa.
- Los errores distinguen causa raíz: 401 (token), 403 (usuario sin tenant en
  `tenants.json`), 502 (upstream Graphiti caído), «nunca apareció en
  `get_episodes`» (cola atascada) vs. «existe pero no es buscable» (extracción
  o embedder fallando).
- Nunca llama a `clear_graph`.
- El paso 4 asume que `/api/auth/mcp/authorize`, con una sesión válida y sin
  `prompt=consent`, responde **302 directo con el `code`** (sin pantalla de
  consentimiento) y que `/api/auth/sign-in/email` **no exige token CSRF**. Si el
  gateway incorpora una pantalla de consentimiento o CSRF, el script falla con
  un mensaje explícito («authorize returned HTTP 200 (an HTML page)…») y hay que
  enseñarle a enviar ese formulario.

### Configuración

| Variable | Flag | Default | Descripción |
|---|---|---|---|
| `BRAIN_URL` | `--url` | — (obligatoria) | URL pública del gateway, p. ej. `https://mybrain.rlz.cl` |
| `BRAIN_EMAIL` | `--email` | — (obligatoria) | Correo de la cuenta |
| `BRAIN_PASSWORD` | `--password` | — (obligatoria) | Contraseña |
| `BRAIN_TIMEOUT` | `--timeout` | `180` | Segundos de espera a que el canario sea buscable |
| `BRAIN_HTTP_TIMEOUT` | `--http-timeout` | `60` | Timeout por petición HTTP |
| `BRAIN_POLL_INTERVAL` | `--poll-interval` | `5` | Segundos entre polls |
| `BRAIN_REDIRECT_URI` | `--redirect-uri` | `https://claude.ai/api/mcp/auth_callback` | Debe estar en la allowlist |
| `BRAIN_MCP_PATH` | `--mcp-path` | `/mcp` | Ruta del endpoint MCP |
| `BRAIN_CLIENT_ID` | `--client-id` | — | Reutiliza un cliente OAuth ya registrado y **omite el DCR** |
| `BRAIN_CLIENT_SECRET` | `--client-secret` | — | Solo si ese cliente es confidencial |

> **Rate limit:** el gateway limita el DCR a **20/min por IP**
> (`DCR_RATE_LIMIT`). Para ejecuciones frecuentes o desde varias máquinas
> detrás de la misma IP, registra el cliente una vez y fija `BRAIN_CLIENT_ID`.

### Códigos de salida

| Código | Significado |
|---|---|
| `0` | `HEALTHCHECK OK` — el round trip completo funcionó |
| `1` | `HEALTHCHECK FAILED: <motivo>` en stderr (cualquier fallo, incluido el canario no encontrado o no borrado) |
| `2` | Configuración inválida o faltante (uso incorrecto) |

### Uso

```bash
export BRAIN_URL=https://mybrain.rlz.cl
export BRAIN_EMAIL=tu@correo.cl
export BRAIN_PASSWORD='tu-contraseña'

python3 scripts/healthcheck.py            # silencioso salvo los pasos
python3 scripts/healthcheck.py --verbose  # + una línea por petición HTTP
python3 scripts/healthcheck.py --help     # opciones

# Con uv (misma cosa; no hace falta ninguna dependencia):
uv run --python 3.12 scripts/healthcheck.py
```

La cuenta debe existir de antes (`npm run create-owner` / `npm run add-user` en
`gateway/`, o el registro self-service). `ALLOW_SIGNUP=false` es el default y el
script **no** intenta crear cuentas.

### Ejecutar desde cron

`crontab -e` (cada 15 minutos, con las credenciales fuera del crontab):

```cron
# /etc/cron.d/brain-healthcheck  —  o `crontab -e` del usuario
SHELL=/bin/bash
*/15 * * * *  set -a; . /etc/brain/healthcheck.env; set +a; \
  /usr/bin/python3 /opt/secondbrain/scripts/healthcheck.py \
  >> /var/log/brain-healthcheck.log 2>&1 || \
  echo "brain healthcheck FAILED $(date -Is)" | mail -s "brain DOWN" tu@correo.cl
```

`/etc/brain/healthcheck.env` (permisos `0600`, dueño root):

```sh
BRAIN_URL=https://mybrain.rlz.cl
BRAIN_EMAIL=tu@correo.cl
BRAIN_PASSWORD=tu-contraseña
BRAIN_TIMEOUT=180
```

En macOS usa `launchd` en vez de cron; el patrón es el mismo (un
`.plist` con `StartInterval` y `EnvironmentVariables`).

### Ejecutar desde un systemd timer

`/etc/systemd/system/brain-healthcheck.service`:

```ini
[Unit]
Description=Second brain end-to-end healthcheck
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/brain/healthcheck.env
ExecStart=/usr/bin/python3 /opt/secondbrain/scripts/healthcheck.py
# Endurecimiento básico: el script solo hace peticiones HTTP salientes.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
```

`/etc/systemd/system/brain-healthcheck.timer`:

```ini
[Unit]
Description=Ejecuta el healthcheck del second brain cada 6 horas

[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo install -m 0600 -o root -g root healthcheck.env /etc/brain/healthcheck.env
sudo systemctl daemon-reload
sudo systemctl enable --now brain-healthcheck.timer
systemctl list-timers brain-healthcheck.timer   # próxima ejecución
journalctl -u brain-healthcheck.service -n 50   # último resultado
```

Como el servicio es `Type=oneshot`, un exit code distinto de `0` deja la unidad
en estado `failed`, que se puede alertar con `OnFailure=` apuntando a una unidad
de notificación.

## CI: workflows de GitHub Actions

Están en `.github/workflows/`.

### `ci.yml` (push y pull request)

| Job | Qué corre |
|---|---|
| `ingest` | `cd ingest && uv sync --frozen && uv run pytest -q` |
| `gateway` | `cd gateway && npm ci && npm run build && npm test` |
| `audit` | `pip-audit` sobre el lockfile de `ingest` y `npm audit --audit-level=high` sobre `gateway` |

El job `audit` es **no bloqueante** (`continue-on-error: true`) pero **visible**:
cada auditoría publica su resultado y su salida completa en el *job summary* del
run. Cuando los hallazgos actuales estén triados, cambia los dos
`continue-on-error: true` a `false` para que empiecen a fallar el build.

> `pip-audit` corre sobre `uv export --frozen --no-dev`, con `--no-deps
> --disable-pip`: el export ya es un set totalmente resuelto y fijado, así que
> pip-audit no debe intentar re-resolver (crearía un venv desechable y falla).

### `healthcheck.yml` (programado, cada 6 horas)

Corre `scripts/healthcheck.py` contra la instancia desplegada, con cron
`0 */6 * * *` (UTC) y también a mano vía **Run workflow** (`workflow_dispatch`,
que acepta un `timeout` opcional). Si falla, emite un `::error` con título
explícito y el job queda en rojo.

**Secrets del repositorio que hay que crear** (Settings → Secrets and variables
→ Actions → New repository secret):

| Secret | Ejemplo | Descripción |
|---|---|---|
| `BRAIN_URL` | `https://mybrain.rlz.cl` | URL pública del gateway |
| `BRAIN_EMAIL` | `tu@correo.cl` | Cuenta ya existente en el gateway |
| `BRAIN_PASSWORD` | `…` | Contraseña de esa cuenta |

**El workflow queda inerte hasta que los tres secrets existan**: un primer paso
comprueba que estén definidos y, si falta alguno, publica un `::notice`
(«Healthcheck inert») y termina en verde sin ejecutar nada. Así se puede
mergear el workflow sin que empiece a fallar de inmediato. En cuanto se
configuran los secrets, el schedule empieza a sondear de verdad y falla
ruidosamente.

Consideraciones:

- Se ejecuta desde runners de GitHub, así que el gateway debe ser **alcanzable
  desde internet** (el túnel de cloudflared). Si la instancia es solo local, usa
  el timer de systemd de arriba en vez del workflow.
- Usa una **cuenta dedicada** al healthcheck si no quieres que los canarios
  toquen tu grafo personal: cada tenant tiene su propio grafo, así que basta
  crear un usuario aparte y darle su instancia.
- El schedule de GitHub Actions se **desactiva solo** tras 60 días de
  inactividad del repositorio; si eso pasa, reactívalo desde la pestaña Actions.


## Recomendado: correr el chequeo en el propio servidor (no en GitHub)

El healthcheck necesita tu correo y contraseña del gateway. Guardarlos como
*secrets* de GitHub le daría a GitHub Actions acceso a tu memoria personal
(datos médicos y financieros). Para un despliegue propio es preferible que las
credenciales **no salgan de la máquina**: se corre por systemd en el mismo
servidor.

Instalado en `mybrain.rlz.cl` así (ver `infra/deploy/native/brain-healthcheck.*`):

```bash
# credenciales solo locales, 600, propiedad del usuario del servicio
cat > /opt/secondbrain-native/healthcheck.env <<EOF
BRAIN_URL=https://mybrain.rlz.cl
BRAIN_EMAIL=tu@correo
BRAIN_PASSWORD=...
EOF
chmod 600 /opt/secondbrain-native/healthcheck.env
chown secondbrain:secondbrain /opt/secondbrain-native/healthcheck.env

install -m 644 infra/deploy/native/brain-healthcheck.service /etc/systemd/system/
install -m 644 infra/deploy/native/brain-healthcheck.timer   /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now brain-healthcheck.timer
```

Corre a las 00/06/12/18:15 UTC (con jitter). Ver resultados:

```bash
systemctl start brain-healthcheck.service      # corrida manual
journalctl -u brain-healthcheck -n 30 --no-pager
systemctl list-timers brain-* --no-pager
```

El workflow de GitHub Actions sigue disponible para quien prefiera esa vía
(queda inerte mientras no existan los secrets), pero **el timer de systemd es la
opción recomendada** para instancias con datos personales.
