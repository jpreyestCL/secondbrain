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
