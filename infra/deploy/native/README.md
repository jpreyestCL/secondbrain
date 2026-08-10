# Deploy nativo (sin Docker) — mybrain.rlz.cl

Servidor compartido de prod (Ubuntu 24.04, `ssh root@178.62.201.63`). Todo vive en
`/opt/secondbrain-native/` y corre por **systemd**, reutilizando el nginx existente.
NO usa Docker ni toca el redis/nginx de producción.

## Componentes

| Servicio systemd | Qué es | Puerto |
|---|---|---|
| `brain-falkordb` | redis 8.6.5 (compilado de fuente) + módulo `falkordb-x64.so` | 127.0.0.1:6380 |
| `brain-mcp` | Graphiti MCP nativo (uv), tenant `jpreyest`, patches aplicados | 127.0.0.1:8021 |
| `brain-gateway` | Gateway OAuth (Node) | 127.0.0.1:8787 |
| `brain-backup.timer` | Backup diario 03:30 del grafo a `backups/` | — |

- **FalkorDB en 6380** porque el redis del sistema (prod) ocupa 6379. FalkorDB v4.20.2
  exige redis ≥ 8.0, por eso se compila un redis 8.6.5 propio (el del sistema es 7.0.15).
- **LLM + embeddings: NVIDIA NIM** (`integrate.api.nvidia.com/v1`), cero RAM local:
  `meta/llama-3.1-70b-instruct` (extracción) + `nvidia/nv-embed-v1` (embeddings, 4096).
- **nginx**: `sites-available/mybrain.rlz.cl.conf` → `proxy_pass 127.0.0.1:8787` (SSE-friendly).

## Usuario y aislamiento local

Los tres servicios corren como el usuario de sistema **`secondbrain`** (sin shell,
`useradd -r -M -s /usr/sbin/nologin -d /opt/secondbrain-native`), **no** como `root`
ni como un usuario compartido con otros proyectos. Motivo: en un servidor compartido,
cualquier proyecto comprometido que corriera con el mismo usuario podría leer los
secretos del brain y hablarle al MCP saltándose el OAuth.

Capas de aislamiento:

1. **Propiedad y permisos**: todo `/opt/secondbrain-native` es `secondbrain:secondbrain`;
   `users.acl`, `mcp.env`, `gateway/.env`, `tenants.json` y `auth.sqlite` en `600`;
   `data/` y `backups/` en `700`.
2. **Firewall por uid** (`firewall-local.sh` + `brain-firewall.service`): el MCP (8021)
   solo acepta conexiones locales de `secondbrain` y `root`; el gateway (8787) además
   de `www-data` (nginx). Cualquier otro usuario local recibe REJECT. Las reglas se
   insertan al **inicio** de la cadena OUTPUT porque ufw acepta loopback antes.
3. **Hardening systemd**: `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`,
   `ProtectSystem=strict` con `ReadWritePaths=/opt/secondbrain-native`, y protecciones
   de kernel/cgroups.

Verificación rápida (debe dar `000` para un usuario ajeno y `200`/JSON para los válidos):

```bash
sudo -u dev  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8021/health  # 000
sudo -u www-data curl -s http://127.0.0.1:8787/health                                # {"ok":true}
```

## Secretos (fuera de git, solo en el server)

- `/opt/secondbrain-native/users.acl` — passwords ACL de FalkorDB (admin + tenant).
- `/opt/secondbrain-native/mcp.env` — API key de NVIDIA + URI de FalkorDB.
- `/opt/secondbrain-native/gateway/.env` — AUTH_SECRET + `REGISTRATION_CODE`.
- `/opt/secondbrain-native/gateway/.owner-password.txt` — password del dueño.

## Operación

```bash
systemctl status brain-falkordb brain-mcp brain-gateway
systemctl restart brain-mcp          # tras cambiar mcp.env o config.yaml
journalctl -u brain-mcp -f           # logs
/opt/secondbrain-native/backup.sh    # backup manual
```

Agregar otra persona: crear usuario ACL en `users.acl` + grafo, otra instancia
`brain-mcp-<tenant>` en otro puerto, `create-owner`/`add-user` en el gateway y
mapear en `gateway/tenants.json`.

## PENDIENTE para acceso remoto (acción del usuario en Cloudflare)

El origen funciona 100% (verificado con OAuth+MCP+guardar+consultar en loopback).
Pero **Cloudflare tiene un Basic Auth (realm "Polyarb") sobre toda la zona `rlz.cl`**
que devuelve `401` antes de llegar al origen — bloquea también al conector de claude.ai.

Para habilitar el acceso, en el dashboard de Cloudflare (una de estas):
1. Excluir `mybrain.rlz.cl` de la regla de Basic Auth / Access "Polyarb", **o**
2. Poner `mybrain.rlz.cl` en **DNS-only** (nube gris) y emitir TLS con certbot en el
   origen (`certbot --nginx -d mybrain.rlz.cl`, igual que los demás sitios).

Luego, en claude.ai → Ajustes → Conectores → Agregar conector personalizado:
`https://mybrain.rlz.cl/mcp` (login con tu email + password del owner).
