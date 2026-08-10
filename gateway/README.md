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
   (`/login`, en español). Tras iniciar sesión se reanuda la autorización y se
   emite el código.
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
| `/registro` | Registro self-service con código de invitación (español) |
| `/registro/validar-codigo` | Valida el código y emite la cookie `registro_ok` (registro vía Google) |
| `/post-google` | Post-callback de Google: hace cumplir el gate de invitación (ver «Habilitar Google») |
| `/api/auth/callback/google` | Callback OAuth de Google (Better Auth); redirige a `/post-google` |
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
| `REGISTRATION_CODE` | — (vacío) | Código de invitación para `/registro`. **Vacío ⇒ registro deshabilitado.** |
| `BRAIN_REPO_ROOT` | `..` (relativo a `gateway/`) | Raíz del repo (contiene `infra/`). Ahí se escanean `infra/tenants/*.env` y se ejecuta `PROVISION_CMD`. |
| `PROVISION_CMD` | `bash infra/scripts/provision-tenant.sh {slug} {port}` | Comando de aprovisionamiento (`{slug}`/`{port}` se sustituyen; sin placeholders se agregan como args). |
| `TENANT_PORT_BASE` | `9021` | Primer puerto MCP considerado al asignar puerto a un tenant nuevo. |
| `REGISTRO_RATE_LIMIT` | `5` | Máximo de `POST /registro` por IP por minuto. |
| `DCR_RATE_LIMIT` | `20` | Máximo de registros de cliente OAuth (`/api/auth/mcp/register`, DCR) por IP por minuto. |
| `GOOGLE_CLIENT_ID` | — (vacío) | Client ID de Google OAuth. **Vacío ⇒ Google deshabilitado.** Ver «Habilitar Google». |
| `GOOGLE_CLIENT_SECRET` | — (vacío) | Client secret de Google OAuth. Requiere también `GOOGLE_CLIENT_ID`. |

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

## Registro self-service (`/registro`)

Con `REGISTRATION_CODE` definido en `.env`, cualquier persona con el código
puede crear su cuenta en `https://<túnel>/registro` (correo, contraseña,
confirmación y código de invitación; validación en el servidor). La página de
login muestra el enlace «¿No tienes cuenta? Regístrate» solo cuando el código
está definido. Si `REGISTRATION_CODE` está vacío, `/registro` muestra
«Registro deshabilitado».

**Interacción con `ALLOW_SIGNUP`**: son independientes.

- `ALLOW_SIGNUP` gobierna el registro **abierto** (sin código) por el endpoint
  público `/api/auth/sign-up/*`. Déjalo en `false`.
- `REGISTRATION_CODE` gobierna el registro **con código** en `/registro`, que
  funciona aunque `ALLOW_SIGNUP=false`: el gateway crea el usuario del lado
  del servidor tras validar el código. (Internamente Better Auth tiene el
  sign-up habilitado y el endpoint público se bloquea en la capa HTTP según
  `ALLOW_SIGNUP`.)

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

Si el aprovisionamiento falla, la cuenta queda creada pero **sin tenant**: la
página pide contactar al administrador, el error completo queda en el log del
gateway y `/mcp` responde `403` (nunca datos de otra persona). El
administrador puede terminar a mano: `bash infra/scripts/provision-tenant.sh
<slug> <puerto>` + mapeo en `tenants.json`.

Al terminar, la página de éxito guía a la persona: agregar el conector
`https://<BASE_URL>/mcp` en claude.ai (Ajustes → Conectores → Agregar conector
personalizado) e iniciar sesión la primera vez con el mismo correo y
contraseña del registro.

Los CLIs `create-owner` y `add-user` siguen funcionando igual.

## Habilitar Google ("Continuar con Google")

Google es **opcional** y respeta el gate de invitación: **nunca** crea un tenant
sin un código válido. Si `GOOGLE_CLIENT_ID` o `GOOGLE_CLIENT_SECRET` faltan, el
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
- **Usuario nuevo con Google**: el flujo obliga a validar primero el código de
  invitación. En `/registro` el botón de Google está deshabilitado hasta que se
  ingresa un código; al validarlo (`POST /registro/validar-codigo`, comparación
  en tiempo constante) se emite una cookie httpOnly de vida corta
  (`registro_ok`, 10 min, valor = HMAC del código con `AUTH_SECRET`).
- Tras el callback de Google, el gateway redirige a `/post-google`, que:
  - si el usuario ya tiene tenant → login normal;
  - si no tiene tenant **y** la cookie `registro_ok` es válida → aprovisiona el
    tenant (mismo flujo serializado que `/registro`) y lo mapea;
  - si no tiene tenant **y no** hay cookie válida → **no aprovisiona**, cierra la
    sesión y muestra una página en español pidiendo un código de invitación.
- **Invariante**: jamás se crea un mapeo de tenant sin un código válido; un
  usuario sin mapeo sigue recibiendo `403` en `/mcp`.

Si rotas `REGISTRATION_CODE`, las cookies `registro_ok` emitidas con el código
anterior dejan de validar automáticamente (el HMAC deja de coincidir).

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
- **Rota `REGISTRATION_CODE`** periódicamente y cuando termines una tanda de
  invitaciones; déjalo vacío para cerrar el registro (basta reiniciar el
  gateway con el `.env` actualizado). Trátalo como una contraseña: quien lo
  tenga puede crear cuentas y contenedores en tu máquina.
- El gateway escucha solo en `127.0.0.1`; la única puerta es el túnel HTTPS.
- Los upstreams de Graphiti deben escuchar **solo en localhost** (o red
  interna de Docker): nadie debe poder saltarse el gateway.
- Aislamiento por diseño: sin mapeo no hay upstream (403), y cada tenant vive
  en su propio contenedor/grafo.
- `AUTH_SECRET`, `data/` (SQLite con hashes y tokens) y `tenants.json` no se
  versionan (ver `.gitignore`). Haz backup de `data/` y `tenants.json`.
- Contraseñas: mínimo 10 caracteres (usa una larga y única).

## Tests

```bash
npm test
```

Cubren: metadatos OAuth, `401 + WWW-Authenticate` sin token, página de login,
flujo OAuth completo (registro dinámico → login → authorize PKCE → token),
enrutamiento multi-tenant a upstreams distintos, `403` para usuario sin
tenant, rechazo de authorize sin PKCE, y el registro self-service: código
ausente/incorrecto, registro deshabilitado sin `REGISTRATION_CODE`, registro
exitoso con aprovisionamiento (stub de `PROVISION_CMD`) + mapeo + flujo OAuth
completo hasta `/mcp`, colisión de slugs, correo duplicado, bloqueo del
sign-up público y rate limit. Además, «Continuar con Google»: botón ausente y
proveedor no cableado cuando faltan las credenciales (callback seguro), botón
presente y proveedor cableado con credenciales, y el invariante del gate de
invitación (usuario de Google sin cookie `registro_ok` válida ⇒ no se aprovisiona
y se cierra la sesión; con cookie válida ⇒ se aprovisiona y mapea), sin llamadas
de red reales a Google.
