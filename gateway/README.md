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
| `ALLOW_SIGNUP` | `false` | Mantener en `false`: los usuarios se crean por CLI. |
| `DB_PATH` | `gateway/data/auth.sqlite` | Base SQLite de Better Auth. |

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

Para invitar a alguien:

```bash
# 1. Levanta SU instancia de Graphiti (p. ej. en el puerto 8022, grafo propio)
# 2. Crea su usuario (sin tenant todavía):
npm run add-user -- otra@persona.cl "su-contraseña-larga"
# 3. Edita tenants.json y agrega:
#    "otra@persona.cl": "http://127.0.0.1:8022/mcp"
# 4. La persona agrega el conector en su claude.ai con la misma URL /mcp
```

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
- Registro de usuarios **deshabilitado** (`ALLOW_SIGNUP=false`); altas solo por
  CLI en la máquina host.
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
tenant y rechazo de authorize sin PKCE.
