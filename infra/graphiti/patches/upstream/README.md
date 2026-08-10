# Originales de upstream (detección de drift)

Los tres archivos de `infra/graphiti/patches/` son **copias completas** de archivos
del servidor MCP de Graphiti, no diffs: se montan (Docker) o se copian (nativo)
encima de la imagen. Eso significa que **al subir de versión de imagen, los patches
revertirían silenciosamente cualquier cambio de upstream en esos archivos** (tools
nuevas, correcciones), sin ningún error visible.

Esta carpeta guarda los originales de la versión pineada para poder diffear.

- `VERSION` — imagen de la que provienen: `1.0.2-graphiti-0.28.2-standalone`.
- `*.orig.py` — archivos tal como vienen en esa imagen.

## Al actualizar la imagen

```bash
# 1) Extraer los originales de la NUEVA imagen
docker create --name tmp zepai/knowledge-graph-mcp:<nueva>
docker cp tmp:/app/mcp/src/graphiti_mcp_server.py /tmp/new_server.py
docker cp tmp:/app/mcp/src/services/factories.py  /tmp/new_factories.py
docker cp tmp:/app/mcp/src/services/queue_service.py /tmp/new_queue.py
docker rm tmp

# 2) Ver qué cambió upstream desde la versión pineada
diff upstream/graphiti_mcp_server.orig.py /tmp/new_server.py
diff upstream/factories.orig.py           /tmp/new_factories.py
diff upstream/queue_service.orig.py       /tmp/new_queue.py

# 3) Reaplicar NUESTROS cambios sobre los archivos nuevos (busca "PATCH (secondbrain)")
grep -n "PATCH (secondbrain)" ../graphiti_mcp_server.py
```

## Qué aporta cada patch

| Archivo | Cambios propios |
|---|---|
| `factories.py` | Respetar `api_url` para endpoints OpenAI-compatibles (NVIDIA/Ollama/DeepSeek) y honrar credenciales embebidas en `FALKORDB_URI`. |
| `queue_service.py` | Propagar `reference_time` real (upstream fija `datetime.now()`). |
| `graphiti_mcp_server.py` | Exponer `reference_time` en `add_memory` + validar rango; forzar el `group_id` del tenant en todas las tools; comprobar pertenencia en las tools por UUID; redacción de credenciales server-side; filtro `only_current` en `search_memory_facts`; instrucciones en español para el cliente MCP. |

Cuando upstream incorpore alguno de estos cambios (p.ej. el fix de `api_url` ya está
en `main`), elimina esa parte del patch en vez de arrastrarla.
