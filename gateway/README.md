# Second Brain Gateway (OAuth 2.1 · multi-tenant)

Gateway en TypeScript que expone servidores MCP locales de **Graphiti** como un
**conector remoto MCP** para claude.ai, Claude Desktop y Claude móvil, protegido
con OAuth 2.1 (Better Auth + plugin MCP).

Es **multi-tenant con aislamiento duro**: cada persona tiene su **propia
instancia de Graphiti** (contenedor y grafo FalkorDB separados). El gateway
autentica al usuario y enruta cada petición `/mcp` **exclusivamente** al
upstream de ese usuario. No existe ningún upstream por defecto: un usuario sin
mapeo recibe `403`.

```
Claude (claude.ai / Desktop / móvil)
        │  HTTPS (túnel)
        ▼
┌─────────────────────────────┐
│  Gateway :8787              │
│  · Better Auth (OAuth 2.1)  │
│  · SQLite data/auth.sqlite  │
│  · tenants.json             │
└──────┬──────────────┬───────┘
       │ usuario A    │ usuario B
       ▼              ▼
 Graphiti MCP    Graphiti MCP
 :8021 (grafo A) :8022 (grafo B)
```

## Cómo funciona el flujo OAuth

1. Agregas el conector en claude.ai con la URL `https://<túnel>/mcp`.
2. Claude llama a `/mcp` sin token y recibe `401` con la cabecera
   `WWW-Authenticate` apuntando a los metadatos del recurso protegido
   (RFC 9728).
3. Claude descubre el servidor de autorización vía
   `/.well-known/oauth-authorization-server` (RFC 8414) y se registra solo
   mediante **registro dinámico de clientes** (`/api/auth/mcp/register`).
4. Claude abre el navegador en `/api/auth/mcp/authorize` con **PKCE (S256,
   obligatorio)**. Si no hay sesión, el gateway redirige a la página de login
   (`/login`, en español). Tras iniciar sesión, el gateway muestra **su propia
   pantalla de consentimiento** (`/consentimiento`) con qué aplicación pide
   acceso y a qué; solo al pulsar «Autorizar» se emite el código. La decisión
   se recuerda por (usuario, `client_id`), así que las reconexiones del mismo
   cliente no vuelven a preguntar.
5. Claude canjea el código en `/api/auth/mcp/token` y a partir de ahí llama a
   `/mcp` con `Authorization: Bearer …`.
6. El gateway valida el token, resuelve el tenant del usuario en
   `tenants.json` y hace proxy (JSON y SSE, con `Mcp-Session-Id` en ambos
   sentidos) hacia SU Graphiti.

## Endpoints

| Ruta | Descripción |
|---|---|
| `/.well-known/oauth-authorization-server` | Metadatos OAuth (RFC 8414) |
| `/.well-known/oauth-protected-resource` (y `/mcp` sufijado) | Metadatos del recurso (RFC 9728) |
| `/api/auth/mcp/authorize` · `token` · `register` | Autorización, tokens y registro dinámico |
| `/api/auth/*` | Resto de Better Auth (sign-in, sesión, jwks…) |
| `/login` | Página de inicio de sesión (español) |
| `/registro` | Registro self-service (español). Sin código en modo `open`; con código en `invite` |
| `/registro/validar-codigo` | Solo en modo `invite`: valida el código y emite la cookie `registro_ok` (registro vía Google) |
| `/post-google` | Post-callback de Google: hace cumplir `REGISTRATION_MODE` y el tope `MAX_TENANTS` |
| `/api/auth/callback/google` | Callback OAuth de Google (Better Auth); redirige a `/post-google` |
| `/verificado` | Aterrizaje del enlace de verificación de correo (español, shell del dashboard) |
| `/reenviar-verificacion` | Reenvía la verificación sin sesión (POST, respuesta neutra, rate limit) |
| `/cuenta/reenviar-verificacion` | Reenvía la verificación desde el panel (POST, same-origin + CSRF) |
| `/olvide-password` | Pide el enlace de recuperación de contraseña (GET formulario · POST envío) |
| `/restablecer-password` | Elige una contraseña nueva con el token del correo (GET formulario · POST guardar) |
| `/consentimiento` | Decide la pantalla de consentimiento propia (POST, CSRF) |
| `/cuenta` | Panel de cuenta: sesiones, apps autorizadas, exportación (español) |
| `/guia` | Guía de uso. **Pública**, dentro del mismo shell del dashboard |
| `/cuenta/cerrar-sesion` · `/cuenta/cerrar-sesiones` · `/cuenta/revocar-cliente` | Acciones del panel (POST, same-origin + token CSRF) |
| `/export` | Descarga JSON de toda tu memoria (requiere sesión) |
| `/mcp` | Endpoint MCP protegido (proxy por tenant) |
| `/health` | Chequeo simple |

## Configuración (`.env`)

Copia `.env.example` a `.env`:

| Variable | Default | Descripción |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:8787` | URL **pública** del gateway (la del túnel). Debe coincidir con la que usa Claude. |
| `AUTH_SECRET` | — (obligatorio) | Secreto ≥32 chars. Genera con `openssl rand -hex 32`. |
| `GRAPHITI_MCP_URL` | `http://127.0.0.1:8020/mcp` | Solo semilla del mapeo del **primer** dueño en `create-owner`. `/mcp` jamás lo usa como fallback. |
| `TENANTS_FILE` | `gateway/tenants.json` | Registro usuario → upstream. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listener local. |
| `ALLOW_SIGNUP` | `false` | Registro **abierto** (sin código) vía `/api/auth/sign-up/*`. Mantener en `false`. No afecta a `/registro`. |
| `DB_PATH` | `gateway/data/auth.sqlite` | Base SQLite de Better Auth. |
| `REGISTRATION_MODE` | `open` | `open` (cualquiera se registra, sin código) · `invite` (hace falta `REGISTRATION_CODE`) · `closed` (`/registro` responde 403). Si no se define pero sí hay `REGISTRATION_CODE`, el modo efectivo es `invite`. |
| `REGISTRATION_CODE` | — (vacío) | Código de invitación. Solo se usa en modo `invite`. |
| `MAX_TENANTS` | `5` | **Válvula de seguridad**: tope duro de tenants. Al alcanzarlo el registro se cierra temporalmente (ver abajo). |
| `BRAIN_REPO_ROOT` | `..` (relativo a `gateway/`) | Raíz del repo (contiene `infra/`). Ahí se escanean `infra/tenants/*.env` y se ejecuta `PROVISION_CMD`. |
| `PROVISION_CMD` | `bash infra/scripts/provision-tenant.sh {slug} {port}` | Comando de aprovisionamiento (`{slug}`/`{port}` se sustituyen; sin placeholders se agregan como args). |
| `TENANT_PORT_BASE` | `9021` | Primer puerto MCP considerado al asignar puerto a un tenant nuevo. |
| `REGISTRO_RATE_LIMIT` | `5` | Máximo de `POST /registro` por IP por minuto. |
| `DCR_RATE_LIMIT` | `20` | Máximo de registros de cliente OAuth (`/api/auth/mcp/register`, DCR) por IP por minuto. |
| `GOOGLE_CLIENT_ID` | — (vacío) | Client ID de Google OAuth. **Vacío ⇒ Google deshabilitado.** Ver «Habilitar Google». |
| `GOOGLE_CLIENT_SECRET` | — (vacío) | Client secret de Google OAuth. Requiere también `GOOGLE_CLIENT_ID`. |
| `SESSION_MAX_AGE_DAYS` | `2` | Duración de la cookie de sesión, en días (antes 7 fijos). |
| `SESSION_UPDATE_AGE_MINUTES` | `60` | Cada cuántos minutos de uso se renueva la expiración de la sesión. `0` ⇒ en cada petición. |
| `RESEND_API_KEY` | — (vacío) | Clave de [Resend](https://resend.com/api-keys). **Vacía ⇒ correo deshabilitado** (sin verificación ni recuperación); el registro sigue funcionando y avisa. |
| `MAIL_FROM` | `Second Brain <onboarding@resend.dev>` | Remitente. El dominio debe estar **verificado** en Resend. |
| `MAIL_DEBUG` | `0` | `1` ⇒ los correos se escriben en el log y **no** se envían (dev/tests). |
| `EMAIL_VERIFICATION_EXPIRES_IN` | `86400` (24 h) | Vigencia del enlace de verificación, en segundos. |
| `PASSWORD_RESET_EXPIRES_IN` | `3600` (1 h) | Vigencia del enlace de recuperación, en segundos. |
| `MAIL_RATE_LIMIT` | `5` | Correos disparados por IP por minuto (recuperación + reenvío de verificación). |
| `EXPORT_MAX_EPISODES` | `1000` | Tope de episodios que pide `/export` al MCP del tenant. |
| `EXPORT_MAX_NODES` | `500` | Tope de entidades/hechos que pide `/export` al MCP del tenant. |

## Puesta en marcha

```bash
cd gateway
npm install
cp .env.example .env        # y rellena AUTH_SECRET
npm run create-owner -- jpreyest@gmail.com "una-contraseña-larga"
npm run dev                 # o: npm run build && npm start
```

`create-owner` crea el primer (y único) dueño y escribe su mapeo en
`tenants.json` usando `GRAPHITI_MCP_URL`. Se niega si ya existe un usuario.

## Multi-tenant: `tenants.json` y alta de personas

`tenants.json` mapea **email o userId** (en minúsculas) → URL del upstream MCP
de esa persona (ver `tenants.json.example`):

```json
{
  "jpreyest@gmail.com": "http://127.0.0.1:8021/mcp",
  "otra@persona.cl": "http://127.0.0.1:8022/mcp"
}
```

El archivo se recarga solo al cambiar (no hace falta reiniciar). Reglas de
aislamiento:

- **Nunca** hay fallback: usuario autenticado sin mapeo ⇒ `403`.
- Cada entrada debe apuntar a una instancia de Graphiti **dedicada**
  (contenedor y grafo FalkorDB propios). No apuntes dos personas al mismo
  upstream salvo que quieran compartir memoria.
- El proxy es sin estado: los `Mcp-Session-Id` que emite el upstream de A solo
  pueden volver al upstream de A, porque el destino se resuelve por token en
  cada petición.

Para invitar a alguien hay dos caminos: el **registro self-service** (abajo) o
el alta manual por CLI:

```bash
# 1. Levanta SU instancia de Graphiti (p. ej. en el puerto 8022, grafo propio)
# 2. Crea su usuario (sin tenant todavía):
npm run add-user -- otra@persona.cl "su-contraseña-larga"
# 3. Edita tenants.json y agrega:
#    "otra@persona.cl": "http://127.0.0.1:8022/mcp"
# 4. La persona agrega el conector en su claude.ai con la misma URL /mcp
```

## Registro self-service (`/registro`) y `REGISTRATION_MODE`

El registro tiene **tres modos**, gobernados por `REGISTRATION_MODE`:

| Modo | `/registro` | Google |
|---|---|---|
| `open` (**default**) | Formulario **sin** campo de código: correo, contraseña y confirmación. Se crea la cuenta y se aprovisiona el tenant en el acto. | Botón «Continuar con Google» habilitado desde el primer momento; un usuario nuevo obtiene tenant automáticamente en `/post-google`. |
| `invite` | Formulario **con** código de invitación (`REGISTRATION_CODE`), comparado en tiempo constante. | Botón deshabilitado hasta canjear el código por la cookie `registro_ok`. |
| `closed` | 403 «Registro deshabilitado»; `/login` no enlaza a `/registro`. | Un usuario nuevo por Google no se aprovisiona nunca: se cierra su sesión. |

**Compatibilidad hacia atrás**: si `REGISTRATION_MODE` no está definido pero
`REGISTRATION_CODE` sí, el modo efectivo es `invite` (el comportamiento
anterior). Sin ninguna de las dos, el modo es `open`.

### Válvula de seguridad: `MAX_TENANTS` (default 5)

**Antes de crear ninguna cuenta**, el gateway cuenta las entradas de
`tenants.json`. Si ya se alcanzó `MAX_TENANTS`, el registro se rechaza con una
página en español («Registro cerrado temporalmente», HTTP 503), se escribe un
aviso en el log y **no se crea usuario ni se aprovisiona nada**. El mismo tope
se aplica al alta por Google.

Por qué existe: el servidor tiene **~1 GB de RAM libre** y el MCP de cada tenant
corre con **`MemoryMax=500M`**. Con el registro abierto, un puñado de altas
seguidas basta para dejar la máquina sin memoria — y en ese mismo equipo viven
las apps de producción del dueño, así que un OOM no solo rompería el second
brain. `MAX_TENANTS` es el límite duro que hace que «registro abierto» siga
siendo seguro; súbelo solo cuando haya RAM que lo respalde.

El `POST /registro` conserva su **rate limit por IP** (`REGISTRO_RATE_LIMIT`,
default 5/min) y el alta por Google en `/post-google` usa **el mismo limitador**.

**Interacción con `ALLOW_SIGNUP`**: son independientes.

- `ALLOW_SIGNUP` gobierna el endpoint HTTP público `/api/auth/sign-up/*`.
  Déjalo en `false`.
- `REGISTRATION_MODE` gobierna `/registro`, que funciona aunque
  `ALLOW_SIGNUP=false`: el gateway crea el usuario del lado del servidor.
  (Internamente Better Auth tiene el sign-up habilitado y el endpoint público
  se bloquea en la capa HTTP según `ALLOW_SIGNUP`.)

Tras un registro exitoso el gateway **aprovisiona el tenant automáticamente**:

1. Deriva el **slug** de la parte local del correo (minúsculas, `[a-z0-9_-]`;
   colisiones se resuelven con sufijo numérico: `ana`, `ana-2`, …).
2. Asigna el **siguiente puerto MCP libre** desde `TENANT_PORT_BASE` (9021)
   escaneando `infra/tenants/*.env` bajo `BRAIN_REPO_ROOT`.
3. Ejecuta `PROVISION_CMD` (default
   `bash infra/scripts/provision-tenant.sh <slug> <puerto>` con
   `cwd=BRAIN_REPO_ROOT`), que crea `infra/tenants/<slug>.env`, regenera el
   compose de tenants y las ACL de FalkorDB (recarga en caliente) y levanta
   **solo** el contenedor `mcp-<slug>` con docker compose (mismo proyecto que
   el Makefile). El script es idempotente para el mismo slug+puerto.
4. Escribe el mapeo en `tenants.json`:
   `correo → http://127.0.0.1:<puerto>/mcp` (escritura atómica).

Los aprovisionamientos concurrentes se **serializan** en proceso (cola +
reserva de slug/puerto), así dos registros simultáneos nunca comparten puerto.

Si el aprovisionamiento **falla**, el gateway hace *rollback*: **borra el
usuario recién creado** (con sus sesiones y su fila de `account`) y muestra la
página de error. Así el correo no queda «quemado» —un reintento con el mismo
correo funciona— y no queda una cuenta que inicia sesión pero no tiene memoria
detrás. El error completo queda en el log del gateway. Se mantiene la
invariante de siempre: un usuario sin mapeo en `tenants.json` recibe `403` en
`/mcp`, nunca los datos de otra persona.

Al terminar, la página de éxito guía a la persona: agregar el conector
`https://<BASE_URL>/mcp` en claude.ai (Ajustes → Conectores → Agregar conector
personalizado) e iniciar sesión la primera vez con el mismo correo y
contraseña del registro.

Los CLIs `create-owner` y `add-user` siguen funcionando igual.

## Habilitar Google ("Continuar con Google")

Google es **opcional** y respeta `REGISTRATION_MODE`: en `invite` **nunca** crea
un tenant sin un código válido; en `open` sí aprovisiona a un usuario nuevo
(sujeto al rate limit y a `MAX_TENANTS`); en `closed` no aprovisiona a nadie. Si `GOOGLE_CLIENT_ID` o `GOOGLE_CLIENT_SECRET` faltan, el
proveedor social no se registra y el botón no se muestra en ninguna página (sin
crash).

### 1. Crear el OAuth 2.0 Client ID en Google Cloud Console

1. Entra a <https://console.cloud.google.com/> y selecciona (o crea) un proyecto.
2. **APIs & Services → OAuth consent screen**: configúralo (tipo *External*),
   agrega tu correo de soporte y publica/añade usuarios de prueba según necesites.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
4. **Application type: `Web application`**.
5. En **Authorized redirect URIs** agrega **exactamente** la URL de callback del
   gateway (esquema + host + `/api/auth/callback/google`), que se deriva de
   `BASE_URL`. Para producción en `https://mybrain.rlz.cl`:

   ```
   https://mybrain.rlz.cl/api/auth/callback/google
   ```

   Si usas un túnel de prueba con URL aleatoria, registra la URL de ese túnel con
   el mismo sufijo `/api/auth/callback/google` (y reajústala si cambia). Para
   desarrollo local también puedes añadir
   `http://127.0.0.1:8787/api/auth/callback/google`.
6. Crea el cliente y copia el **Client ID** y el **Client secret**.

### 2. Configurar el gateway

En `gateway/.env`:

```bash
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=yyyyyyyy
```

Reinicia el gateway (`npm run dev` o `npm run build && npm start`). El botón
«Continuar con Google» aparecerá en `/login` y `/registro`.

### 3. Cómo se preserva el gate de invitación con Google

- **Usuario existente** (ya en `tenants.json`) que entra con Google → inicia
  sesión normal.
- **Usuario nuevo con Google en modo `open`**: el botón está habilitado desde
  el principio y no hay cookie que canjear. Tras el callback, `/post-google`
  aprovisiona su tenant directamente (con el rate limit por IP de `/registro` y
  el tope `MAX_TENANTS` aplicados).
- **Usuario nuevo con Google en modo `invite`**: el flujo obliga a validar
  primero el código. En `/registro` el botón de Google está deshabilitado hasta
  que se ingresa un código; al validarlo (`POST /registro/validar-codigo`,
  comparación en tiempo constante) se emite una cookie httpOnly de vida corta
  (`registro_ok`, 10 min, valor = HMAC del código con `AUTH_SECRET`).
- Tras el callback de Google, el gateway redirige a `/post-google`, que:
  - si el usuario ya tiene tenant → login normal;
  - si no tiene tenant y el modo lo permite (`open`, o `invite` con cookie
    `registro_ok` válida) → aprovisiona el tenant (mismo flujo serializado que
    `/registro`) y lo mapea;
  - si no tiene tenant y el modo **no** lo permite (`closed`, o `invite` sin
    cookie válida) → **no aprovisiona**, cierra la sesión y lo explica;
  - si el tope `MAX_TENANTS` está alcanzado → **no aprovisiona**, cierra la
    sesión y muestra la página de capacidad.
- **Invariante**: un usuario sin mapeo sigue recibiendo `403` en `/mcp`, y en
  modo `invite` jamás se crea un mapeo sin un código válido.

Si rotas `REGISTRATION_CODE`, las cookies `registro_ok` emitidas con el código
anterior dejan de validar automáticamente (el HMAC deja de coincidir).

## Correo: verificación de la dirección y recuperación de contraseña

El correo lo manda **Resend** con un cliente propio de ~150 líneas sobre `fetch`
(`src/mailer.ts`): la API de Resend es un `POST` JSON a
`https://api.resend.com/emails`, así que añadir el SDK solo sumaba una
dependencia y superficie de ataque. El payload es exactamente:

```jsonc
// POST https://api.resend.com/emails
// Authorization: Bearer $RESEND_API_KEY
{
  "from": "Second Brain <hola@rlz.cl>",   // MAIL_FROM
  "to": ["persona@ejemplo.cl"],           // SIEMPRE arreglo
  "subject": "Confirma tu correo en mybrain.rlz.cl",
  "html": "…",
  "text": "…"
}
```

La clave vive en `gateway/.env` (que está en `.gitignore`). Si la tienes en el
archivo `../.resend-key` del repo, pásala así sin dejarla en el historial del
shell:

```bash
printf 'RESEND_API_KEY=%s\n' "$(cat ../.resend-key)" >> gateway/.env
```

Los dos correos van en **español**, con parte HTML y parte de texto plano, y
dicen por qué llegan («recibes este correo porque alguien creó una cuenta en
mybrain.rlz.cl con esta dirección») y qué hacer si no fuiste tú (ignorarlo).

### Flujos

- **Verificación**: el alta (`/registro` y `/api/auth/sign-up/*`) dispara el
  correo. El enlace va a `/api/auth/verify-email` y aterriza en `/verificado`,
  que confirma que la cuenta está lista y enlaza a `/cuenta` y `/guia`. Enlace
  caducado o inválido ⇒ página que lo explica y ofrece pedir otro.
- **Estado en `/cuenta`**: «verificado ✅» o «pendiente ⚠️» con un botón
  **reenviar verificación**.
- **Recuperación**: `/olvide-password` → correo → `/restablecer-password?token=…`
  → contraseña nueva. El token vale **una vez** y una hora, y al cambiarla se
  **cierran las demás sesiones** (`revokeSessionsOnPasswordReset`). Antes de
  esto, quien olvidaba su contraseña no tenía ninguna salida.
- Todas las respuestas públicas son **neutras**: nunca dicen si una dirección
  tiene cuenta (si no, el formulario sería un enumerador de usuarios).

### Degradación cuando el correo falla o está apagado

Es el caso normal mientras el dominio siga pendiente de DNS en Resend. Sin
`RESEND_API_KEY`, o si Resend devuelve un error, el registro **no se rompe**:

1. se crea la cuenta y se aprovisiona el tenant (eso **nunca** se deshace por un
   fallo de correo);
2. la página de éxito dice «Cuenta creada · **verificación pendiente**» y trae un
   botón **reenviar correo**;
3. el motivo real queda en el log del servidor (`[mail] FALLÓ…`), no en pantalla.

Por eso `requireEmailVerification` está en `false`: si exigiera verificación
para iniciar sesión, una caída del correo dejaría fuera hasta a la gente ya
aprovisionada.

### `requireLocalEmailVerified` debe quedarse en su default (`true`)

Better Auth se niega a enlazar una cuenta social con una cuenta local cuyo
correo no esté verificado (`node_modules/better-auth/dist/oauth2/link-account.mjs`).
Esa es la razón de fondo de todo lo anterior: con la verificación funcionando,
«Continuar con Google» funciona para todo el mundo sin tocar nada.

**No bajes `account.accountLinking.requireLocalEmailVerified` a `false`.** Con
`REGISTRATION_MODE=open` eso habilita un **secuestro de cuenta**: quien quiera
registra con contraseña el correo de otra persona (sin verificarlo, porque ya no
haría falta), y cuando esa persona entra con Google, Google la deja caer *dentro
de la cuenta del atacante* — que sigue conociendo la contraseña. El default
seguro es `true`; lo que hay que arreglar es el correo, no la política.

### Verificar el dominio en Resend (DNS)

Mientras `rlz.cl` esté en estado *pending*, enviar desde `@rlz.cl` falla y
`onboarding@resend.dev` solo puede escribirle a la dirección dueña de la cuenta
de Resend. Para verificarlo, en Resend → *Domains* → `rlz.cl` se muestran los
registros exactos a copiar en el DNS; son de estas tres clases:

| Tipo | Nombre (host) | Valor | Para qué |
|---|---|---|---|
| `MX` | `send.rlz.cl` | `feedback-smtp.<región>.amazonses.com` (prioridad `10`) | Rebotes y quejas (Return-Path). |
| `TXT` | `send.rlz.cl` | `v=spf1 include:amazonses.com ~all` | SPF: autoriza a Resend a enviar por tu dominio. |
| `TXT` | `resend._domainkey.rlz.cl` | `p=MIGfMA0GCSq…` (clave pública que da Resend) | DKIM: firma los mensajes. |

Recomendado además (no lo exige Resend, sí los buzones grandes):

| Tipo | Nombre | Valor |
|---|---|---|
| `TXT` | `_dmarc.rlz.cl` | `v=DMARC1; p=none; rua=mailto:dmarc@rlz.cl` |

Copia los valores **de la consola de Resend**, no de esta tabla: la región del
`MX` y la clave DKIM son específicas de cada cuenta. Tras añadirlos, pulsa
*Verify* (la propagación suele tardar minutos, a veces horas). Con el dominio
verificado, pon `MAIL_FROM=Second Brain <hola@rlz.cl>` y reinicia el gateway.

## Panel de cuenta (`/cuenta`) y exportación (`/export`)

`/cuenta` (requiere sesión de navegador, en español) muestra:

- el correo de la cuenta y a qué servidor de memoria (upstream MCP) está enrutada;
- las **sesiones activas** con su último uso, IP y navegador, y un botón
  «cerrar todas las demás sesiones»;
- las **aplicaciones OAuth autorizadas** (las que pasaron por la pantalla de
  consentimiento o tienen tokens vivos), cada una con un botón «revocar».

Revocar una app borra su consentimiento y sus tokens **de esa persona**; si no
le queda consentimiento ni token a nadie, se borra también el registro del
cliente (los clientes se crean por DCR, uno por conexión). La próxima vez que
la app intente conectarse volverá a pedirse consentimiento.

### Shell compartido del dashboard

`/cuenta` y `/guia` se renderizan dentro del **mismo layout**
(`src/dashboard-layout.ts`): un solo `<head>`, un solo bloque CSS (antes estaba
duplicado en las dos páginas) y una barra superior con el nombre del producto y
las secciones **Cuenta · Guía · Exportar**, marcando la activa con
`aria-current="page"`. Con sesión, la barra muestra el correo y un botón
«Cerrar sesión»; sin sesión (la guía es pública) muestra «Iniciar sesión». La
barra envuelve y se apila en móvil, así que no desborda.

«Cerrar sesión» es un **POST** a `/cuenta/cerrar-sesion` protegido igual que el
resto de acciones del panel (same-origin + token CSRF) y redirige a `/`; como
`GET` sería activable desde cualquier página de terceros.

Los POST del panel (`/cuenta/cerrar-sesion`, `/cuenta/cerrar-sesiones`,
`/cuenta/revocar-cliente`)
y el de `/consentimiento` exigen **same-origin** (cabecera `Origin`/`Referer`
del propio gateway) **y** un token CSRF `HMAC(idDeSesión, AUTH_SECRET)`
incrustado en el formulario. Sin cabecera `Origin` se rechaza.

### `GET /export`

Devuelve un JSON descargable con la memoria completa del usuario autenticado:

```json
{ "exportedAt": "...", "user": {...}, "upstream": "...",
  "episodes": [...], "entities": [...], "facts": [...], "warnings": [] }
```

- `episodes`: el **texto original** de cada episodio (`get_episodes`).
- `entities`: entidades del grafo (`search_nodes`).
- `facts`: hechos con `valid_at` / `invalid_at`, incluidos los ya
  invalidados (`search_memory_facts` con `only_current=false`).

Todo se obtiene **a través del MCP del propio tenant**, nunca contra la base
del grafo: el aislamiento es exactamente el mismo que aplica a Claude, así que
un error aquí no puede alcanzar el grafo de otra persona. Sin sesión responde
`401` (o redirige a `/login` si el `Accept` es HTML); si la cuenta aún no
tiene tenant asignado responde `409`.

Limitación conocida: `search_nodes` y `search_memory_facts` son búsquedas
híbridas **top-N**, no un volcado; con la consulta amplia y los topes de
`EXPORT_MAX_NODES` cubren de sobra un grafo personal, pero la fuente completa
e íntegra son los episodios (todo hecho se derivó de uno, y se exportan todos).
Si necesitas un volcado literal del grafo, hazlo desde el contenedor Graphiti
del tenant con las herramientas de FalkorDB.

## Exponer públicamente

claude.ai necesita alcanzar el gateway por HTTPS. Recomendado: **cloudflared**.

Túnel rápido (URL aleatoria, ideal para probar):

```bash
brew install cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
# → https://algo-aleatorio.trycloudflare.com
```

Túnel con nombre y dominio propio (estable, recomendado para uso real):

```bash
cloudflared tunnel login
cloudflared tunnel create secondbrain
cloudflared tunnel route dns secondbrain brain.tudominio.com
cloudflared tunnel run --url http://127.0.0.1:8787 secondbrain
```

Pon la URL resultante en `BASE_URL` del `.env` y **reinicia el gateway** (las
URLs de los metadatos OAuth se generan a partir de `BASE_URL`).

Alternativa con Tailscale (solo expone a Internet vía tu tailnet):

```bash
tailscale funnel 8787
```

## Conectar en claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. URL: `https://<tu-túnel>/mcp` (p. ej. `https://brain.tudominio.com/mcp`).
3. Claude abrirá la página de login del gateway: entra con tu correo y
   contraseña y autoriza.
4. El conector queda disponible también en Claude Desktop y móvil (misma
   cuenta).

## Seguridad

- OAuth 2.1: PKCE **obligatorio** (solo S256), tokens de acceso de 1 h,
  refresh tokens de 30 días, registro dinámico de clientes.
- Registro abierto **deshabilitado** (`ALLOW_SIGNUP=false`); altas por CLI o
  por `/registro` con código de invitación.
- `/registro`: el código se compara en **tiempo constante** y hay **rate limit
  en memoria** (`REGISTRO_RATE_LIMIT`, 5/min/IP por defecto; usa
  `X-Forwarded-For`, así que el túnel debe ponerla, como hace cloudflared).
  Es un límite básico en proceso: se reinicia con el gateway y no sustituye a
  un rate limit real en el borde si esperas abuso.
- **`MAX_TENANTS` es la contención del registro abierto**: cada tenant levanta
  un MCP con `MemoryMax=500M` sobre ~1 GB de RAM libre, compartida con las apps
  de producción del dueño. Con `REGISTRATION_MODE=open` es lo único que separa
  un registro legítimo de un OOM de la máquina completa. Súbelo solo con RAM
  que lo respalde; para cerrar del todo usa `REGISTRATION_MODE=closed`.
- Si usas `REGISTRATION_MODE=invite`, **rota `REGISTRATION_CODE`**
  periódicamente y al terminar una tanda de invitaciones. Trátalo como una
  contraseña: quien lo tenga puede crear cuentas y contenedores en tu máquina.
- El gateway escucha solo en `127.0.0.1`; la única puerta es el túnel HTTPS.
- Los upstreams de Graphiti deben escuchar **solo en localhost** (o red
  interna de Docker): nadie debe poder saltarse el gateway.
- Aislamiento por diseño: sin mapeo no hay upstream (403), y cada tenant vive
  en su propio contenedor/grafo.
- `AUTH_SECRET`, `data/` (SQLite con hashes y tokens) y `tenants.json` no se
  versionan (ver `.gitignore`). Haz backup de `data/` y `tenants.json`.
- Contraseñas: mínimo 10 caracteres (usa una larga y única).
- **Pantalla de consentimiento propia**: el plugin MCP de Better Auth decide
  pedir consentimiento mirando `prompt=consent`, es decir, lo decide el
  cliente. El gateway interpone la suya en `/api/auth/mcp/authorize`: con
  sesión iniciada y sin consentimiento previo para ese `client_id` **no se
  llama a Better Auth**, así que no se genera ningún código; «Cancelar»
  devuelve al cliente con `error=access_denied`. Es defensa en profundidad
  sobre la allowlist de `redirect_uri`, no un reemplazo.
- **Sesiones cortas con rotación**: la cookie dura `SESSION_MAX_AGE_DAYS`
  (2 días por defecto, antes 7) y se renueva con el uso cada
  `SESSION_UPDATE_AGE_MINUTES`. Cada persona puede cerrar sus otras sesiones
  desde `/cuenta`.
- Los formularios autenticados llevan protección CSRF (same-origin + token
  HMAC ligado a la sesión).

## Tests

```bash
npm test
```

Cubren: metadatos OAuth, `401 + WWW-Authenticate` sin token, página de login,
flujo OAuth completo (registro dinámico → login → authorize PKCE → token),
enrutamiento multi-tenant a upstreams distintos, `403` para usuario sin
tenant, rechazo de authorize sin PKCE, y el registro self-service: código
ausente/incorrecto, `REGISTRATION_MODE=closed` ⇒ 403, registro exitoso con
aprovisionamiento (stub de `PROVISION_CMD`) + mapeo + flujo OAuth completo
hasta `/mcp`, colisión de slugs, correo duplicado, bloqueo del sign-up público
y rate limit. Los tres modos de registro tienen su propia suite: `open`
(sin campo de código, POST sin código ⇒ cuenta creada y tenant aprovisionado,
Google sin cookie `registro_ok`), `invite` (el código sigue siendo obligatorio,
también para Google) y `closed`; más la válvula `MAX_TENANTS` (al tope ⇒ 503,
**ninguna** fila de usuario creada, ni por formulario ni por Google) y el
rollback (provisión fallida ⇒ el usuario se borra y el reintento con el mismo
correo funciona). El shell del dashboard tiene la suya: mismo bloque CSS en
`/cuenta` y `/guia`, sección activa correcta, barra con correo + «Cerrar
sesión» con sesión y «Iniciar sesión» sin ella, y el POST de cerrar sesión
(CSRF y cross-origin ⇒ 403). Además, «Continuar con Google»: botón ausente y
proveedor no cableado cuando faltan las credenciales (callback seguro), botón
presente y proveedor cableado con credenciales, y el invariante del gate de
invitación (usuario de Google sin cookie `registro_ok` válida ⇒ no se aprovisiona
y se cierra la sesión; con cookie válida ⇒ se aprovisiona y mapea), sin llamadas
de red reales a Google.

También cubren la pantalla de consentimiento (el primer `authorize` la muestra
y **no** emite código ni deja verificaciones en la base; autorizar sí lo emite;
el segundo intento del mismo cliente no vuelve a preguntar; cancelar devuelve
`access_denied`; cross-origin y token CSRF inválido ⇒ 403), la configuración de
sesión (`SESSION_MAX_AGE_DAYS`/`SESSION_UPDATE_AGE_MINUTES`), `/export`
(401/redirect sin sesión, JSON con `episodes`/`entities`/`facts` contra un MCP
upstream simulado, 409 sin tenant), el panel `/cuenta` (render, revocar cliente
⇒ desaparece de la base, cerrar sesiones ⇒ queda solo la actual, POST
cross-origin y CSRF ⇒ 403) y la landing (contraste WCAG, `aria-live`, nombre
accesible del deslizador, rama alcanzable y escape de `BASE_URL`).

El correo tiene tres suites, **ninguna toca la red** (`globalThis.fetch` se
sustituye por un doble y los flujos usan un mailer de mentira):

- `mailer.test.ts`: el payload exacto que se le manda a Resend, el remitente por
  defecto, `MAIL_DEBUG=1` ⇒ cero llamadas de red, sin `RESEND_API_KEY` ⇒
  `MailError{code:"mail_disabled"}`, y los 4xx/5xx/fallos de red convertidos en
  `MailError` con el mensaje de la API.
- `verificacion.test.ts`: el alta manda el correo (con motivo y enlace al
  gateway), el enlace pone `emailVerified=1` y muestra la página de cuenta
  lista, token inválido y token **caducado** se distinguen, el reenvío funciona
  y está limitado por IP, `/cuenta` muestra pendiente ⇄ verificado, y —lo
  importante— con Resend fallando o **sin `RESEND_API_KEY`** el registro sigue
  creando cuenta + tenant y muestra la página de «verificación pendiente» en vez
  de un 500.
- `password-reset.test.ts`: camino feliz completo (pedir → correo → token →
  contraseña nueva → entrar con ella; la vieja da 401), token de un solo uso,
  enlaces rotos, validaciones del formulario, respuesta neutra ante direcciones
  desconocidas y rate limit por IP.
