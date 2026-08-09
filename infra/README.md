# Infraestructura del "second brain" (multi-tenant)

Stack local (macOS + colima + docker compose) que da memoria de largo plazo a
agentes via el protocolo MCP, con **aislamiento duro por tenant**: cada tenant
tiene su propio grafo en FalkorDB y su propio proceso MCP server.

## Arquitectura

```
Cliente MCP (Claude, etc.)
        │  HTTPS + OAuth
        ▼
  Gateway OAuth  (componente aparte, en gateway/)
        │  enruta al usuario autenticado a SU puerto (loopback)
        ├────────────────────────┬─────────────────────────┐
        ▼                        ▼                         ▼
  MCP jpreyest             MCP tenant2                MCP tenant3
  127.0.0.1:8021/mcp/      127.0.0.1:8022/mcp/        127.0.0.1:8023/mcp/
        │                        │                         │
        └────────────┬───────────┴─────────────────────────┘
                     ▼   redis://tenant_<n>:<pass>@falkordb:6379 (red interna compose)
              FalkorDB (una instancia, 127.0.0.1:6379)
                grafo jpreyest │ tenant2 │ tenant3   (grafo == tenant)
                     │
                     ▼
              infra/data/falkordb  (RDB + AOF de TODOS los grafos)
```

| Servicio | Imagen (pineada) | Puerto host |
|---|---|---|
| FalkorDB (compartido) | `falkordb/falkordb:v4.20.2` | `127.0.0.1:6379` |
| MCP por tenant (`brain-mcp-<tenant>`) | `zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2-standalone` | `127.0.0.1:8021, 8022, ...` (8000 interno) |

Endpoints por tenant:

- MCP (HTTP streamable): `http://127.0.0.1:<puerto>/mcp/`
- Salud: `http://127.0.0.1:<puerto>/health`

**Todos** los puertos escuchan solo en loopback; el unico punto de entrada
externo es el gateway OAuth, que decide a que puerto (tenant) va cada usuario.

## Modelo multi-tenant y garantias de aislamiento

Cada tenant se define en `infra/tenants/<nombre>.env` (plantilla:
`infra/tenants/tenant.env.example`). El script
`infra/scripts/gen-tenants-compose.sh` regenera
`infra/docker-compose.tenants.yml` (archivo **generado, no editar**) con un
servicio MCP por tenant; `make up/down/logs/status` lo regeneran siempre antes
de invocar docker compose.

Garantias:

1. **Grafo separado (grafo == tenant)**: el server Graphiti usa el `group_id`
   como nombre del grafo (clave Redis) en FalkorDB, asi que la convencion es
   grafo == `GRAPHITI_GROUP_ID` == `FALKORDB_DATABASE` == nombre del tenant.
   Los patches de `infra/graphiti/patches/` fuerzan ademas que toda tool MCP
   opere solo con el group_id del tenant.
2. **ACL de FalkorDB por tenant (segunda capa)**: ver seccion siguiente.
3. **Proceso separado**: un contenedor MCP por tenant (`brain-mcp-<tenant>`),
   con su propio `GRAPHITI_GROUP_ID` y su propio puerto loopback. Un crash o
   saturacion (SEMAPHORE_LIMIT) de un tenant no afecta a los demas.
4. **Enrutamiento en el gateway**: los MCP servers no tienen auth y no son
   alcanzables desde fuera de la maquina; solo el gateway OAuth, tras
   autenticar al usuario, reenvia su trafico al puerto de SU tenant.

## ACL de FalkorDB por tenant

Aunque los patches del MCP ya fuerzan el group_id, hay una segunda defensa a
nivel de Redis: `infra/scripts/gen-falkordb-acl.sh` genera
`infra/falkordb/users.acl` (archivo **generado, con passwords: no commitear**)
a partir de `infra/tenants/*.env`:

- Por cada tenant se crea el usuario `tenant_<nombre>` con password
  `FALKORDB_TENANT_PASSWORD` (del `.env` del tenant) y regla
  `~<nombre> +@all -@admin -@dangerous +info +client|setinfo`: solo puede
  tocar la clave/grafo `<nombre>`; nada de FLUSHALL, KEYS, CONFIG, etc.
  (`+info` y `+client|setinfo` se re-permiten porque el cliente falkordb-py
  los usa en el handshake y son inofensivos).
- El usuario `default` queda `on nopass ~* &* +@all` para administracion y
  backups; es aceptable porque el 6379 solo se publica en loopback.
- El compose monta el directorio `infra/falkordb/` en el contenedor y arranca
  redis con `--aclfile`; el generador hace `ACL LOAD` en caliente si el
  contenedor ya corre. `make up` regenera compose de tenants + ACL siempre.
- Cada contenedor MCP se conecta con
  `FALKORDB_URI=redis://tenant_<nombre>:<password>@falkordb:6379` (el
  generador de compose embebe las credenciales; por eso
  `docker-compose.tenants.yml` tambien esta en `.gitignore`).

Formato aclfile: no admite comentarios, cada linea es una regla `user ...`.

Nota: el aislamiento de datos es a nivel de grafo dentro de una unica
instancia FalkorDB (mismo proceso de base de datos). Si algun dia se requiere
aislamiento a nivel de motor, se puede pasar a un contenedor FalkorDB por
tenant, a costa de mas memoria.

## Uso diario

```bash
cp .env.example .env      # una sola vez; completar claves (compartidas por tenants)
make up                   # falkordb + TODOS los MCP de tenants
make status               # contenedores + salud por tenant
make logs                 # logs en vivo
make down                 # detiene todo
```

## Tenants

### Agregar

```bash
make add-tenant NAME=maria PORT=8022
make up
```

Crea `infra/tenants/maria.env` con `FALKORDB_DATABASE=maria`, password ACL autogenerado y
`GRAPHITI_GROUP_ID=maria`, regenera el compose y (tras `make up`) levanta
`brain-mcp-maria` en `127.0.0.1:8022`. Luego hay que registrar el mapeo
usuario→puerto en el gateway OAuth.

En el `.env` del tenant se pueden sobreescribir ajustes globales
(p. ej. `MODEL_NAME`, `SEMAPHORE_LIMIT`) — el env del tenant gana sobre el
`.env` raiz.

### Quitar

```bash
docker rm -f brain-mcp-maria        # o make down primero
rm infra/tenants/maria.env
make up                             # regenera el compose sin ese tenant
```

Los datos del tenant quedan en el grafo `maria` dentro de FalkorDB; para
borrarlos definitivamente:
`docker exec brain-falkordb redis-cli GRAPH.DELETE maria`.

## Respaldos

`infra/scripts/backup.sh` (tambien `make backup`):

1. Ejecuta `BGSAVE` en FalkorDB y espera a que el snapshot termine.
2. Empaqueta `infra/data/falkordb` (RDB + AOF) en
   `backups/falkor-YYYYMMDD-HHMMSS.tar.gz`. Los archivos RDB/AOF contienen la
   instancia completa, es decir **los grafos de todos los tenants** en un solo
   respaldo.
3. Borra respaldos con mas de 30 dias.

Ademas del RDB, el contenedor corre con **AOF activado**
(`appendonly yes`, `appendfsync everysec`), asi que ante un corte se pierde a
lo mas ~1 s de escrituras.

### Respaldo automatico diario (launchd)

```bash
make install-launchd
```

Instala `com.jpreyest.brain-backup` en `~/Library/LaunchAgents` y lo carga:
corre el respaldo todos los dias a las **03:30** y deja log en
`backups/backup.log`. Para desinstalar:

```bash
launchctl bootout gui/$(id -u)/com.jpreyest.brain-backup
rm ~/Library/LaunchAgents/com.jpreyest.brain-backup.plist
```

### Restaurar

```bash
make restore BACKUP=backups/falkor-20260809-033000.tar.gz
```

Detiene el stack, mueve los datos actuales a
`infra/data/falkordb.pre-restore` (por si acaso), extrae el respaldo y vuelve
a levantar. **Importante**: como FalkorDB es compartido, el restore repone los
grafos de TODOS los tenants al momento del respaldo (no hay restore por
tenant con este mecanismo).

## Arranque automatico al iniciar sesion (colima + compose)

No usamos un launchd propio para colima; el camino soportado es:

1. **Colima al login** (via homebrew services):

   ```bash
   brew services start colima
   ```

   Esto registra el LaunchAgent oficial de homebrew que ejecuta
   `colima start` al iniciar sesion. Verificar con `brew services list`.

2. **Contenedores**: todos los servicios usan `restart: unless-stopped`, de
   modo que cuando colima levanta el daemon de docker, los contenedores del
   stack (FalkorDB y todos los MCP de tenants) se levantan solos, siempre que
   la ultima vez hayan quedado corriendo con `make up`.

Comprobacion rapida tras un reinicio:

```bash
make status                                # contenedores + salud por tenant
curl -s http://127.0.0.1:8021/health       # tenant jpreyest
```

## Notas de seguridad

- 6379 y todos los puertos MCP (8021+) solo en `127.0.0.1`; nada del stack es
  alcanzable desde la LAN.
- Los MCP servers corren **sin autenticacion**: nunca abrir sus puertos hacia
  afuera; la autenticacion y el enrutamiento por tenant los aporta el gateway
  OAuth.
- `FALKORDB_PASSWORD` es opcional (loopback), pero si se define aplica a
  FalkorDB y a todos los MCP servers.
- Telemetria de Graphiti desactivada (`GRAPHITI_TELEMETRY_ENABLED=false`).
