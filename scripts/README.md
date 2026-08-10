# `scripts/`

Utilidades operativas del second brain. Sin dependencias: todo corre con la
librería estándar de Python 3.12+ (o con `uv run`).

Única excepción: el OCR de los adjuntos de Apple Notes usa `ocrmac` (Apple
Vision). No es una dependencia de estos scripts — el exportador busca un
intérprete que ya lo tenga (el venv de `ingest/`) y lo lanza como subproceso;
si no lo encuentra, avisa y exporta igual, sin OCR.

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

---

# Importar Apple Notes al second brain

871 notas de Apple Notes (844 con texto + 27 que eran solo una foto) → grafo,
separando señal de ruido y **sin perder la fecha real de cada nota** (regla #1
de `CLAUDE.md`: la fecha del hecho manda, nunca la de ingesta).

Tres scripts, cada uno con una responsabilidad:

| Script | Qué hace | Destruye algo? |
|---|---|---|
| `notes-export.py` | `NoteStore.sqlite` → un `.md` por nota con front-matter, **más los adjuntos** (copia + OCR + tablas) | no (abre una copia; jamás escribe en la DB de Notes; los adjuntos se leen in situ) |
| `notes-attachments.py` | módulo que usa el exportador: resuelve adjuntos → archivo, OCR (Apple Vision) y tablas de Apple → Markdown | no (solo lectura del contenedor de Notes) |
| `notes-triage.py` | etiqueta cada nota `guardar` / `descartar` / `dudoso` | no (solo escribe `triage.json` + `triage.md`) |
| `notes-apply.py` | copia **solo** las `guardar` a una carpeta lista para `brain scan` y rellena el manifest de `brain classify` | no (copia; el export completo se queda intacto) |

## Flujo completo

```bash
# 1. Exportar (lectura pura de la base de Notes).
#    Incluye adjuntos: copia los originales a /tmp/notas-export/adjuntos/<note_id>/,
#    les pasa OCR y decodifica las tablas de Apple. La primera corrida tarda
#    ~20 min (una pasada de Vision por imagen); las siguientes son instantáneas
#    gracias a la cache por hash.
scripts/notes-export.py --out /tmp/notas-export
# ...sin OCR (rápido: solo copia adjuntos y decodifica tablas):
scripts/notes-export.py --out /tmp/notas-export --no-ocr

# 2. Layer 0: filtro determinista y gratis
scripts/notes-triage.py --in /tmp/notas-export --work /tmp/notas-triage

# 3. Layer 0 + Layer 1 (LLM). Primero en seco, para ver qué se enviaría:
scripts/notes-triage.py --in /tmp/notas-export --work /tmp/notas-triage \
    --llm --dry-run
# ...y cuando convenza, gastando llamadas (reanudable):
scripts/notes-triage.py --in /tmp/notas-export --work /tmp/notas-triage --llm

# 4. Revisar A MANO /tmp/notas-triage/triage.md (todos los `dudoso` y una
#    muestra de `descartar`) y corregir el campo `decision` en triage.json.

# 5. Construir la carpeta de ingesta
scripts/notes-apply.py --triage /tmp/notas-triage/triage.json \
    --out ~/notas-guardar --prefill

# 6. Pipeline normal del CLI brain (ver más abajo)
```

## `notes-export.py`

Lee `~/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite`.

**El cuerpo de las notas no es texto**: vive en `ZICNOTEDATA.ZDATA` como
**protobuf comprimido con gzip**. Descomprimir y decodificar como UTF-8 "casi"
funciona, pero deja la basura del framing protobuf mezclada con la prosa
(`( ( ( " L8U$K[O+`). Este script recorre el protobuf de verdad. Estructura
verificada empíricamente en esta base (proto "1.5"):

```
NoteStoreProto { Document document = 2 }
Document       { Note note = 3 }
Note           { string note_text = 2      <- el texto limpio
                 <metadata CRDT>      = 3  <- ignorado
                 repeated AttributeRun = 5 }
AttributeRun   { uint32 length = 1; ParagraphStyle paragraph_style = 2 }
ParagraphStyle { uint32 style_type = 1; uint32 indent = 3; Checklist = 5 }
```

Los `AttributeRun` se usan solo para reconstruir títulos, viñetas y checkboxes
como Markdown (`--plain` los ignora y emite el texto crudo).

**Seguridad de la base**: por defecto copia `NoteStore.sqlite` (+ `-wal`/`-shm`)
a un directorio temporal y consulta la copia, así el WAL pendiente se aplica y
el archivo original nunca se abre en escritura. `--no-copy` usa
`mode=ro&immutable=1` sobre el original (más rápido, pero ignora el WAL y puede
perder ediciones recientes).

**Fechas**: en este esquema la columna de creación poblada es
`ZCREATIONDATE3` (`ZCREATIONDATE1` está NULL en las 874 filas) y la de
modificación es `ZMODIFICATIONDATE1`. Ambas en epoch Apple (`+978307200`).
El `created` del front-matter es lo que después será el `reference_time` de
Graphiti.

Salida: `NNNN-slug.md`, numeración por fecha de creación ascendente, sin
colisiones. Como el número depende de cuántas notas hay, una corrida **completa**
(sin `--limit` / `--since` / `--only-note`) borra al final los `.md` y las
carpetas de `adjuntos/` que sobraron de la numeración anterior, e informa
cuántos: si no, el triage leería la misma nota dos veces. Front-matter:

```yaml
---
title: "VPS al mundo"
created: "2017-03-16T19:57:54.743485"
modified: "2017-03-20T20:39:43.411926"
folder: "Notes"
source: "apple-notes"
note_id: "430DF38C-69F1-424B-BAB0-D178C915D56A"
attachments: ["adjuntos/430DF38C-.../IMG_5152.png"]
attachments_text_chars: 412
---
```

| Flag | Default | Qué hace |
|---|---|---|
| `--out` | `/tmp/notas-export` | directorio de salida |
| `--db` | ruta estándar de Notes | otra `NoteStore.sqlite` |
| `--limit` | `0` | corta después de N notas |
| `--only-note` | — | exporta **solo** esa nota (UUID `ZIDENTIFIER` o `Z_PK`) |
| `--since` | — | solo notas creadas desde `YYYY-MM-DD` |
| `--dry-run` | — | no escribe nada; imprime estadísticas y 3 muestras |
| `--plain` | — | no reconstruye viñetas/títulos en Markdown |
| `--keep-empty` | — | exporta también las notas sin cuerpo, sin adjuntos y sin texto recuperado |
| `--no-copy` | — | lee la DB viva con `immutable=1` en vez de copiarla |
| `--no-attachments` | — | ignora los adjuntos por completo (comportamiento antiguo) |
| `--no-ocr` | — | copia adjuntos y decodifica tablas, pero no ejecuta Vision (usa el `ZOCRSUMMARY` que Apple ya tenía guardado) |
| `--no-copy-attachments` | — | hace OCR pero no copia los originales |
| `--ocr-languages` | `es-ES,en-US` | pistas de idioma para Apple Vision |

Notas protegidas con contraseña: están cifradas (no son gzip) y se saltan con
aviso.

## Adjuntos: `notes-attachments.py`

Antes, los adjuntos se perdían: Apple los referencia en el cuerpo con el
carácter `￼`, que se eliminaba, así que las notas cuyo contenido real era una
foto salían vacías y el triage las tiraba como `casi_vacio` (`#pasaporte`,
`RUT JP scan ->`, `#niños #rut`). Ahora se recuperan.

**Esquema (verificado en esta máquina).** No existe ninguna tabla
`ZICATTACHMENT`; todo vive en `ZICCLOUDSYNCINGOBJECT`:

* fila de adjunto = `ZTYPEUTI` no nulo + `ZNOTE` → `Z_PK` de la nota;
* `ZMEDIA` → fila de *media* (`Z_ENT` 10) con `ZIDENTIFIER` (nombre de
  directorio) y `ZFILENAME`;
* el archivo **no** está en `Media/<ZIDENTIFIER>/<ZFILENAME>`: Apple mete un
  directorio de generación en medio
  (`Media/<ZIDENTIFIER>/<N>_<UUID>/<ZFILENAME>`). Por eso el resolvedor
  recorre el directorio de media en vez de armar la ruta a mano —
  así resuelven **584/584**.

Adjuntos sin fila de media:

| UTI | de dónde sale |
|---|---|
| `com.apple.notes.gallery` | **contenedor**: sus hijos son filas `public.jpeg` normales que ya apuntan a la nota. Se salta el contenedor, no se pierde nada |
| `com.apple.paper.doc.scan` | `FallbackPDFs/<id>/<ZFALLBACKPDFGENERATION>/FallbackPDF.pdf` |
| `com.apple.paper` | `FallbackImages/<id>/<ZFALLBACKIMAGEGENERATION>/FallbackImage.png` |
| `com.apple.drawing.2` | `FallbackImages/<id>.jpg` |
| `com.apple.notes.table` | protobuf CRDT comprimido en `ZMERGEABLEDATA1` (ver abajo) |

Último recurso para cualquier adjunto que no resuelva: `Previews/<id>-*`
(están reescalados hacia abajo, por eso solo se usan si falta el original).

**OCR.** Apple Vision vía `ocrmac`, con pistas `es-ES,en-US`. Como `ocrmac` no
es stdlib, el script busca un intérprete que pueda importarlo (el venv de
`ingest/`) y lanza *este mismo archivo* como subproceso worker que habla JSONL.
Los PDFs se rasterizan página a página con PDFKit a 2× y se pasan por Vision
(los 6 `FallbackPDF.pdf` son escaneos sin capa de texto).
Los resultados se cachean en `<out>/.adjuntos-cache.json` **por SHA-256 del
archivo**: volver a correr el exportador es idempotente y reanudable, y nunca
repite un OCR ya hecho.

La base tiene además el OCR propio de Apple en `ZOCRSUMMARY`, pero guarda
*todos* los candidatos separados por tabuladores (`REAL\n\talt1\n\talt2`); se
limpia y se usa solo como respaldo cuando el archivo no aparece o Vision no
devuelve nada.

**Tablas de Apple.** `ZMERGEABLEDATA1` es `gzip(MergableDataProto)`, un CRDT.
Se decodifica a Markdown: el `custom_map` de tipo `com.apple.notes.ICTable` da
`crRows` / `crColumns` (OrderedSets) y `cellColumns` (diccionario columna →
diccionario fila → celda). El orden sale en dos saltos: los replicas del
`Array` dan los UUID de los nodos del CRTree en orden de pantalla, y
`Ordering.contents` mapea cada nodo al objeto UUID que se usa como clave en
`cellColumns`. Funciona en las 21 tablas de esta base (las columnas sobrantes
vacías que Apple deja al final se recortan). El orden de columnas es el que
declara el CRDT; en tablas editadas muchas veces puede no ser exactamente el
que se ve en pantalla.

**Números reales de esta base** (844 → **871** notas exportadas; las 27 nuevas
son notas cuyo cuerpo estaba vacío porque *eran* una foto):

| | |
|---|---:|
| notas con adjuntos | 84 |
| adjuntos totales | 664 |
| resueltos a un archivo | 629 |
| contenedores `gallery` (se saltan a propósito) | 31 |
| sin resolver | 4 |
| tablas → Markdown | 18 ok, 3 vacías de verdad |
| OCR ejecutado | 597 imágenes/PDFs, 388,6 s en total, 0 fallos |
| OCR sin texto (fotos sin letras) | 46 |
| notas nuevas con texto recuperado | 18 |
| notas que salen de `casi_vacio` | 8 |
| notas que llegan a Layer 1 | 804 → **827** |
| segunda corrida (todo cacheado) | 1,5 s |

Los 4 sin resolver son filas de adjunto sin `ZMEDIA`, con `ZFILESIZE = 0` y sin
generación de fallback: nunca se materializaron en este Mac, no hay nada que
recuperar.

**Salida por nota.** Los originales se copian a
`<out>/adjuntos/<note_id>/<archivo>` y se listan en el front-matter
(`attachments`), y el texto recuperado se anexa al cuerpo:

```markdown
## Tablas de la nota

### Tabla 1

| Rige Desde | Rige Hasta | Prima |
|---|---|---|
| 13/09/2024 | 31/03/2025 | 21,000 |

## Texto reconocido de adjuntos

### 31D682B4-D995-410F-A840-D5D0186FAD00.jpg

REPUBLICA DE CHILE
SERVICIO DE REGISTRO CIVIL E IDENTIFICACIÓN
...
```

Los encabezados dejan claro que ese texto **salió de un OCR**, no de algo que
se escribió a mano: puede tener errores de reconocimiento.

`notes-apply.py` reescribe `attachments` a rutas absolutas al copiar la nota,
para que la referencia siga apuntando a los originales del export (no se
duplican 255 MB ni se meten imágenes en la carpeta que va a `brain scan`).

## `notes-triage.py`

**Layer 0 — determinista, gratis, sin LLM.** Motivos emitidos por nota:
`vacio`, `casi_vacio` (< `--min-chars`, default 15), `solo_url`,
`solo_numeros`, `duplicado_exacto` (hash del contenido normalizado; sobrevive
la copia más antigua).

**Adjuntos.** Si el front-matter trae `attachments_text_chars > 0`, ese texto
(OCR de una foto o una tabla decodificada) **es** el contenido de la nota: esa
nota nunca se marca `vacio` ni `casi_vacio`. Además cada fila de `triage.json`
lleva `tiene_adjuntos` (bool), `adjuntos` (lista de rutas) y `adjuntos_chars`,
y `triage.md` muestra una sección de adjuntos y una columna `adj` con cuántos
tiene cada nota.

Detalle importante: los tests corren sobre **título + cuerpo juntos**. Apple
guarda el título como primera línea del cuerpo, pero no siempre; si se mira
solo el cuerpo, una nota titulada `banco santander` cuyo cuerpo son puros
dígitos cae en `solo_numeros` — y es un dato bancario real. El criterio no es
"¿está bien escrita?" sino "¿es un dato de mi vida que querría recuperar?".

**Layer 1 — LLM por lotes.** 40 notas por llamada (título + primeros 400
caracteres), endpoint compatible con OpenAI y salida estructurada
`json_schema`. Cada nota recibe `decision` (`guardar|descartar|dudoso`),
`dominio` (`personal|salud|finanzas|trabajo|proyectos`), `doc_date` (solo si el
**texto** menciona una fecha; nunca la de creación) y una `razon` breve.

* **Reanudable**: cada nota clasificada se anexa a
  `<work>/checkpoint.jsonl`. Volver a correr el script solo envía los lotes
  que faltan.
* **Consciente del costo**: imprime cuántas llamadas hará antes de hacerlas, y
  los tokens de cada una. Con 804 notas pendientes son **21 llamadas**.
* **`--dry-run`** imprime el payload exacto del primer lote (system prompt,
  user prompt y schema) y no gasta nada.
* **Secretos**: el `.md` local puede tener contraseñas, pero el extracto que
  se envía a la API se limpia antes — si la nota habla de claves/tokens, los
  tokens alfanuméricos se reemplazan por `[REDACTADO]` (regla #2 de
  `CLAUDE.md`). Los `.md` locales quedan tal cual; `redact.py` de `ingest/`
  los limpia otra vez antes del grafo. La limpieza corre sobre **todo** el
  cuerpo, que ahora incluye el OCR de los adjuntos: una clave fotografiada en
  un pantallazo se tapa igual que una escrita. Los números de identidad (RUT,
  pasaporte, serie) **no** son credenciales: se quedan en la nota, que para
  eso se recuperaron.

| Flag | Default | Qué hace |
|---|---|---|
| `--in` | `/tmp/notas-export` | carpeta del exportador |
| `--work` | `/tmp/notas-triage` | dónde van `triage.json`, `triage.md`, checkpoint |
| `--min-chars` | `15` | umbral de `casi_vacio` |
| `--llm` | — | ejecuta Layer 1 |
| `--dry-run` | — | con `--llm`: muestra el lote 1 y no gasta |
| `--batch-size` | `40` | notas por llamada |
| `--model` | `$MODEL_NAME` | modelo (necesita `json_schema`) |
| `--api-url` | `$OPENAI_API_URL` | endpoint compatible OpenAI |
| `--api-key` | `$OPENAI_API_KEY` | clave |
| `--env-file` | `<repo>/.env` | de dónde leer esas variables (las del entorno mandan) |
| `--checkpoint` | `<work>/checkpoint.jsonl` | archivo de reanudación |

Usa las **mismas variables que el resto del proyecto**. Con el `.env` del repo
apunta a NVIDIA NIM (`https://integrate.api.nvidia.com/v1`,
`meta/llama-3.1-70b-instruct`). DeepSeek **no** sirve: no soporta
`json_schema`.

Salida:

* `triage.json` — una fila por nota con `decision`, `razon`, `dominio`,
  `doc_date`, `layer`, `path`, `hash`, `tiene_adjuntos`, `adjuntos` y
  `adjuntos_chars`. **Este es el archivo que se edita a mano** tras la
  revisión.
* `triage.md` — resumen legible: totales, tabla de motivos de Layer 0, **todos**
  los `dudoso` y una muestra de 40 de `descartar` y `guardar`.

## `notes-apply.py`

Copia a `--out` solo las notas con `decision` en `--include` (default
`guardar`) y les añade al front-matter `dominio`, `doc_date` y `doc_type`, para
no volver a decidir lo mismo dos veces. `doc_date` usa la fecha que dio el LLM
y, si no hay, la fecha de creación de la nota — nunca hoy.

`sensitivity_flags` se deduce: `salud → medical`, `finanzas → financial`, más
`credentials` si el texto menciona claves/tokens y `pii` si aparece un RUT.

| Flag | Default | Qué hace |
|---|---|---|
| `--triage` | (obligatorio) | `triage.json` ya revisado |
| `--out` | `~/notas-guardar` | carpeta destino para `brain scan` |
| `--include` | `guardar` | decisiones a copiar (`guardar,dudoso` para incluir dudosas) |
| `--doc-type` | `nota` | `doc_type` del manifest |
| `--prefill` | — | escribe `prefill.json` (junto a `triage.json`, **nunca** dentro de `--out`) |
| `--merge-manifest` | — | rellena un `classify-<batch>.json` de `brain classify` |
| `--manifest-out` | — | escribe el manifest fusionado aparte en vez de in-place |
| `--dry-run` | — | no escribe nada |

## Ingesta al grafo

### 1. Pipeline local del CLI `brain`

```bash
cd ingest
uv sync --all-extras
uv run brain scan ~/notas-guardar
uv run brain extract
uv run brain classify                     # emite ~/.brain/jpreyest/work/classify-<batch>.json
```

En vez de clasificar a mano las cientos de notas otra vez, se rellena el
manifest con lo que ya decidió el triage:

```bash
scripts/notes-apply.py --triage /tmp/notas-triage/triage.json \
    --out ~/notas-guardar \
    --merge-manifest ~/.brain/jpreyest/work/classify-<batch>.json

cd ingest
uv run brain classify --apply ~/.brain/jpreyest/work/classify-<batch>.json
uv run brain chunk
```

El emparejamiento manifest ↔ nota es por `path` (y como respaldo, por nombre de
archivo); los documentos que no vengan de Notes quedan intactos.

### 2. Túnel SSH a FalkorDB

FalkorDB de producción escucha en `127.0.0.1:6380` del servidor
(`infra/deploy/native/`), nunca expuesto a internet. Para ingestar desde el Mac
hay que abrir un túnel:

```bash
ssh -N -L 16380:127.0.0.1:6380 root@178.62.201.63
# (dejar corriendo en otra terminal; -N = sin shell remota)
```

### 3. Entorno de ingesta

Con el túnel arriba, en la terminal donde corre `brain ingest-graph`:

```bash
export FALKORDB_HOST=127.0.0.1
export FALKORDB_PORT=16380
export FALKORDB_USERNAME=tenant_jpreyest
export FALKORDB_PASSWORD=<FALKORDB_TENANT_PASSWORD de infra/tenants/jpreyest.env>

# LLM de extracción (NVIDIA NIM; debe soportar json_schema)
export OPENAI_API_KEY=<clave NIM>
export OPENAI_API_URL=https://integrate.api.nvidia.com/v1
export MODEL_NAME=meta/llama-3.1-70b-instruct

# EMBEDDINGS: tienen que ser EXACTAMENTE los del servidor
export EMBEDDER_PROVIDER=openai
export EMBEDDER_MODEL=nvidia/nv-embed-v1
export EMBEDDER_DIMENSIONS=4096
export EMBEDDER_API_URL=https://integrate.api.nvidia.com/v1

cd ingest && uv run brain ingest-graph
uv run brain status
```

> ⚠️ **El embedder debe ser `nvidia/nv-embed-v1` con `EMBEDDER_DIMENSIONS=4096`.**
> Los vectores del grafo ya están en ese espacio de 4096 dimensiones. Ingestar
> con otro modelo (o con otras dimensiones) no da error inmediato: mete
> vectores incompatibles y **la búsqueda semántica deja de funcionar** para
> todo lo que se ingeste así. Si hay duda, verificar contra
> `infra/deploy/native/` antes de ingestar.

El grafo es `jpreyest` y `GRAPHITI_GROUP_ID=jpreyest` (regla #6: el `group_id`
es SIEMPRE el tenant, nunca el dominio; el dominio viaja como metadata).

### 4. Verificar

```bash
scripts/healthcheck.py --url https://mybrain.rlz.cl --email ... --password ...
```

o consultar con la skill `/consultar` algo que solo esté en las notas
importadas (p. ej. "¿qué pretensiones de sueldo pedía Carlos?").

## Notas operacionales

* Los tres scripts son **idempotentes**: volver a exportar sobre el mismo
  `--out` regenera los mismos nombres de archivo; el triage reanuda desde el
  checkpoint; `notes-apply` reescribe la carpeta destino.
* El ledger de `brain` evita duplicados por `(path, sha256)`, así que volver a
  correr `brain scan` sobre `~/notas-guardar` no re-ingesta nada que no haya
  cambiado.
* Nada de esto borra notas de Apple Notes ni del export. Lo único que se
  "descarta" es la decisión de no meterlas al grafo, siempre reversible
  editando `triage.json` y volviendo a correr `notes-apply.py`.
