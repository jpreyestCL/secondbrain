# Deploy nativo (sin Docker) — mybrain.rlz.cl

Servidor compartido de prod (Ubuntu 24.04, `ssh root@37.27.190.92`). Todo vive en
`/opt/secondbrain-native/` y corre por **systemd**, reutilizando el nginx existente.
NO usa Docker ni toca el redis/nginx de producción.

## Componentes

| Servicio systemd | Qué es | Puerto |
|---|---|---|
| `brain-falkordb` | redis 8.6.5 (compilado de fuente) + módulo `falkordb-x64.so` v4.20.2 | 127.0.0.1:6380 |
| `brain-mcp@<slug>` | **unit template**: un Graphiti MCP por tenant (uv), patches aplicados | 127.0.0.1:\<puerto del tenant\> |
| `brain-mcp` | unit legacy del tenant `jpreyest` (pre-multi-tenant, ver *Migración*) | 127.0.0.1:8021 |
| `brain-gateway` | Gateway OAuth (Node) | 127.0.0.1:8787 |
| `brain-firewall` | Restringe por uid el acceso local a los puertos MCP/gateway | — |
| `brain-backup.timer` | Backup diario 03:30 del grafo a `backups/` | — |

- **FalkorDB en 6380** porque el redis del sistema (prod) ocupa 6379. FalkorDB v4.20.2
  exige redis ≥ 8.0, por eso se compila un redis 8.6.5 propio (el del sistema es 7.0.15).
- **LLM + embeddings: NVIDIA NIM** (`integrate.api.nvidia.com/v1`), cero RAM local:
  `meta/llama-3.1-70b-instruct` (extracción) + `nvidia/nv-embed-v1` (embeddings, 4096).
- **nginx**: `sites-available/mybrain.rlz.cl.conf` → `proxy_pass 127.0.0.1:8787` (SSE-friendly).

---

## 1. Instalación reproducible desde un clone limpio

```bash
git clone <repo> /root/secondbrain && cd /root/secondbrain
sudo infra/deploy/native/install.sh
```

`install.sh` es **idempotente**: se puede re-ejecutar siempre. Cada paso comprueba si
ya está hecho y solo actúa si falta o cambió. Nunca regenera passwords existentes ni
pisa `mcp.env`.

Qué hace, en orden:

| Paso | Acción |
|---|---|
| 1 | `apt-get install` de las build-deps (`build-essential`, `libssl-dev`, `iptables`, …) |
| 2 | Crea el usuario de sistema `secondbrain` (`useradd -r -M -s /usr/sbin/nologin`) |
| 3 | Layout de dirs: `data/`, `backups/`, `tenants/` en **700**; secretos en **600** |
| 4 | Descarga y **compila redis 8.6.5** → `bin/redis-server`, `bin/redis-cli` |
| 5 | Descarga `falkordb-x64.so` v4.20.2 desde el release de GitHub + `chmod +x` |
| 6 | Genera `falkordb.conf` y `users.acl` (password admin `openssl rand -hex 24`) si no existen |
| 7 | Obtiene las fuentes del Graphiti MCP y **superpone los 3 patches** de `infra/graphiti/patches/` |
| 8 | Instala `uv` en `/usr/local/bin` y corre `uv sync` como `secondbrain` |
| 9 | Crea `mcp.env` desde `mcp.env.example` (y **te para** para que pongas la API key) |
| 10 | Instala scripts, units systemd y timers; arranca falkordb + firewall + backup.timer |
| 11 | Aprovisiona el primer tenant (`TENANT`/`TENANT_PORT`, por defecto `jpreyest`/`8021`) |
| 12 | Smoke test: `PING` autenticado a FalkorDB, `/health` del MCP, `/health` del gateway, backup |

Variables útiles: `BRAIN_ROOT`, `TENANT`, `TENANT_PORT`, `MCP_SRC_DIR`, `REDIS_VERSION`,
`FALKORDB_VERSION`.

### De dónde salen las fuentes del Graphiti MCP

No hay tarball oficial publicado del `mcp_server` para esta versión: las fuentes vienen
de la **imagen pineada**

```
zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2-standalone
```

`install.sh` las resuelve en este orden:

1. Ya están en `/opt/secondbrain-native/mcp` → no hace nada.
2. `MCP_SRC_DIR=/ruta/a/mcp_server` → copia de un árbol existente.
3. Hay docker disponible → `docker pull` + `docker create` + `docker cp $CID:/app`.
4. Nada de lo anterior → **falla con instrucciones** para extraerlas en otra máquina:

```bash
# en una máquina CON docker
docker pull zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2-standalone
CID=$(docker create zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2-standalone)
docker cp $CID:/app ./mcp_server && docker rm $CID
tar czf mcp_server.tgz mcp_server && scp mcp_server.tgz root@<server>:/tmp/

# en el server
tar xzf /tmp/mcp_server.tgz -C /tmp
MCP_SRC_DIR=/tmp/mcp_server infra/deploy/native/install.sh
```

Encima de esas fuentes se copian siempre los 3 patches del repo:

| `infra/graphiti/patches/` | destino en `mcp/` |
|---|---|
| `graphiti_mcp_server.py` | `src/graphiti_mcp_server.py` |
| `queue_service.py` | `src/services/queue_service.py` |
| `factories.py` | `src/services/factories.py` |

---

## 2. Agregar un tenant (multi-tenant nativo)

```bash
sudo infra/deploy/native/provision-tenant-native.sh <slug> <puerto>
# ej: sudo infra/deploy/native/provision-tenant-native.sh maria 9022
```

Es el equivalente nativo de `infra/scripts/provision-tenant.sh` (que asume Docker) y es
lo que desbloquea el registro self-service. Pasos:

1. **Valida** el slug (`^[a-z0-9][a-z0-9_-]*$`) y el puerto: rango 1024-65535, excluyendo
   los reservados `6379 6380 8021 8787 11434` y cualquier puerto ya usado por otro tenant.
   Si el slug ya existe con **otro** puerto, aborta sin tocar nada.
2. **Usuario ACL** `tenant_<slug>` con password `openssl rand -hex 24`, agregado a
   `users.acl` y recargado en caliente con `redis-cli -e -a <admin> ACL LOAD` (el password
   admin se lee de la línea `user default`). Si `ACL LOAD` falla, revierte el `users.acl`
   y sale con error. Después verifica con `ACL GETUSER` que el usuario quedó activo.
3. **`tenants/<slug>.env`** con `FALKORDB_URI` (credenciales del tenant, no del admin),
   `FALKORDB_DATABASE`, `GRAPHITI_GROUP_ID`, `MCP_PORT` y `CONFIG_PATH`. Todo lo de
   LLM/embedder se **hereda** de `mcp.env`.
4. **`tenants/<slug>/config.yaml`** generado desde `config.yaml.template` con
   `host: 127.0.0.1` y el puerto del tenant.
5. `systemctl daemon-reload && systemctl enable --now brain-mcp@<slug>`, y **espera el
   `/health`** en `127.0.0.1:<puerto>`; si no levanta, vuelca `systemctl status` +
   `journalctl -n 60` y sale con error.
6. Reaplica `firewall-local.sh` para que el puerto nuevo también quede restringido por uid.

**Idempotente**: re-ejecutar con el mismo slug+puerto reutiliza el password ACL existente
(no duplica la línea de `users.acl`), reescribe env/config y reinicia el unit.

### Por qué hay un `config.yaml` por tenant

El servidor Graphiti **no lee su puerto del entorno**: solo del YAML. Y hay una trampa
extra en `src/graphiti_mcp_server.py`:

```python
default_config = Path(__file__).parent.parent / 'config' / 'config.yaml'
parser.add_argument('--config', ..., default=default_config)
...
if args.config:
    os.environ['CONFIG_PATH'] = str(args.config)
```

es decir, **el default de argparse pisa la variable de entorno `CONFIG_PATH`**. Exportarla
en el `EnvironmentFile` no basta: sin `--config`, todos los tenants levantarían en 8021
("address already in use"). Por eso `brain-mcp@.service` usa:

```ini
ExecStart=/usr/local/bin/uv run --offline main.py --config ${CONFIG_PATH}
```

### El unit template

`brain-mcp@.service` (un solo archivo para todos los tenants, instancia `%i` = slug) carga
**dos** `EnvironmentFile`, en este orden:

```ini
EnvironmentFile=/opt/secondbrain-native/mcp.env          # común: LLM, embedder, API keys
EnvironmentFile=/opt/secondbrain-native/tenants/%i.env   # pisa URI/DB/group_id/CONFIG_PATH
```

con el mismo hardening que el resto: `User=secondbrain`, `NoNewPrivileges`, `PrivateTmp`,
`ProtectHome`, `ProtectSystem=strict` + `ReadWritePaths=/opt/secondbrain-native`,
`UMask=0077`, `MemoryMax=500M`.

### Quitar un tenant

```bash
SLUG=maria
systemctl disable --now brain-mcp@$SLUG
rm -rf /opt/secondbrain-native/tenants/$SLUG /opt/secondbrain-native/tenants/$SLUG.env
sed -i "/^user tenant_$SLUG /d" /opt/secondbrain-native/users.acl
ADMIN=$(grep '^user default' /opt/secondbrain-native/users.acl | grep -oE '>[^ ]+' | tr -d '>')
/opt/secondbrain-native/bin/redis-cli -p 6380 --no-auth-warning -a "$ADMIN" -e ACL LOAD
/opt/secondbrain-native/firewall-local.sh          # quita la regla del puerto
systemctl daemon-reload && systemctl reset-failed
# opcional, borra sus datos:
# redis-cli -p 6380 -a "$ADMIN" GRAPH.DELETE $SLUG
```

### Migración del tenant `jpreyest` al unit template

`jpreyest` todavía lo sirve `brain-mcp.service` (unit no-template, anterior al
multi-tenant). `install.sh` lo detecta y **no** aprovisiona `brain-mcp@jpreyest` para no
chocar en el 8021. Para migrar:

```bash
systemctl disable --now brain-mcp.service
infra/deploy/native/provision-tenant-native.sh jpreyest 8021
curl -s http://127.0.0.1:8021/health          # verificar
rm /etc/systemd/system/brain-mcp.service      # recién ahí
```

---

## Usuario y aislamiento local

Los servicios corren como el usuario de sistema **`secondbrain`** (uid 999, sin shell),
**no** como `root` ni como un usuario compartido con otros proyectos. Motivo: en un
servidor compartido, cualquier proyecto comprometido que corriera con el mismo usuario
podría leer los secretos del brain y hablarle al MCP saltándose el OAuth.

Capas de aislamiento:

1. **Propiedad y permisos**: todo `/opt/secondbrain-native` es `secondbrain:secondbrain`;
   `users.acl`, `mcp.env`, `tenants/*.env`, `tenants/*/config.yaml`, `gateway/.env`,
   `tenants.json` y `auth.sqlite` en `600`; `data/`, `backups/` y `tenants/` en `700`.
2. **ACL de FalkorDB por tenant**: `tenant_<slug>` solo puede tocar la clave `<slug>`
   (grafo == group_id == tenant), sin `@admin` ni `@dangerous`, y sin `SCAN`/`GRAPH.LIST`
   (que permitirían enumerar los *nombres* de los grafos ajenos). `+info` y
   `+client|setinfo` se re-permiten porque el cliente `falkordb-py` los usa en el
   handshake.
3. **Firewall por uid** (`firewall-local.sh` + `brain-firewall.service`): los puertos MCP
   solo aceptan conexiones locales de `secondbrain` y `root`; el gateway (8787) además de
   `www-data` (nginx). Cualquier otro usuario local recibe REJECT. Las reglas se insertan
   al **inicio** de la cadena OUTPUT porque ufw acepta loopback antes.
   Los puertos **ya no están hardcodeados**: el script los descubre de
   `tenants/*.env` (`MCP_PORT=`) más el puerto base de `mcp.env`.
4. **Hardening systemd**: `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`,
   `ProtectSystem=strict` con `ReadWritePaths=/opt/secondbrain-native`, y protecciones
   de kernel/cgroups.

Verificación rápida:

```bash
# usuario ajeno: 000 (REJECT)
sudo -u dev curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8021/health
sudo -u www-data curl -s http://127.0.0.1:8787/health          # {"ok":true}

# aislamiento de grafos entre tenants
PASS=$(grep '^user tenant_maria ' /opt/secondbrain-native/users.acl | grep -oE '>[^ ]+' | tr -d '>')
CLI="/opt/secondbrain-native/bin/redis-cli -p 6380 --no-auth-warning --user tenant_maria --pass $PASS"
$CLI GRAPH.QUERY maria 'RETURN 1'      # OK
$CLI GRAPH.QUERY jpreyest 'RETURN 1'   # NOPERM No permissions to access a key
$CLI GRAPH.LIST                        # NOPERM ... no permissions to run 'graph.LIST'
$CLI KEYS '*'                          # NOPERM ... no permissions to run 'keys'
```

## Secretos (fuera de git, solo en el server)

- `/opt/secondbrain-native/users.acl` — passwords ACL de FalkorDB (admin + un tenant por
  usuario). Plantilla: `users.acl.example`. **El formato `aclfile` de redis no admite
  comentarios**: cada línea debe ser una regla `user ...`.
- `/opt/secondbrain-native/mcp.env` — API key del LLM + config común. Plantilla:
  `mcp.env.example`.
- `/opt/secondbrain-native/tenants/<slug>.env` — credenciales ACL del tenant (generado).
- `/opt/secondbrain-native/gateway/.env` — AUTH_SECRET + `REGISTRATION_CODE`.
- `/opt/secondbrain-native/gateway/.owner-password.txt` — password del dueño.

## Operación

```bash
systemctl status brain-falkordb brain-mcp brain-gateway 'brain-mcp@*'
systemctl restart brain-mcp@maria      # tras cambiar su env o config.yaml
journalctl -u brain-mcp@maria -f       # logs de un tenant
/opt/secondbrain-native/backup.sh      # backup manual
systemctl start brain-backup.service   # backup vía systemd
```

Backups: una sola instancia FalkorDB sirve a todos los tenants, así que un `BGSAVE` +
`tar` de `data/dump.rdb` cubre todos los grafos. Retención 30 días.

---

## Qué sigue siendo manual

- **nginx + TLS**: `sites-available/mybrain.rlz.cl.conf` (plantillas en este directorio:
  `nginx-mybrain.rlz.cl.conf`, `nginx-cf-allow.conf`) y `certbot`. `install.sh` no toca
  nginx para no arriesgar los otros sitios del server compartido.
- **Gateway OAuth**: build de Node (`npm ci && npm run build`) y su `.env`
  (`AUTH_SECRET`, `REGISTRATION_CODE`), más `create-owner`/`add-user` y el mapeo de
  tenant → puerto en `gateway/tenants.json`. `install.sh` solo instala/alinea el unit si
  el directorio `gateway/` ya existe.
- **Secretos reales**: la API key del LLM en `mcp.env` (el instalador crea el archivo
  desde la plantilla y se detiene para que lo completes).
- **Cloudflare / DNS**: `mybrain.rlz.cl` debe estar excluido del Basic Auth de la zona
  `rlz.cl`, o en DNS-only con TLS propio en el origen.
- **Migración de `jpreyest`** al unit template (ver arriba).
