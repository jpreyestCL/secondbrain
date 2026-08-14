# CLAUDE.md — secondbrain

Second brain multi-tenant: un grafo temporal de conocimiento (Graphiti sobre FalkorDB) por persona, donde se guardan hechos personales, médicos, financieros, laborales y de proyectos, con historia completa (los hechos se invalidan, nunca se borran). Cada tenant tiene su propio grafo (nombre del grafo = tenant = `group_id` de todos sus episodios) y su propio contenedor MCP con usuario ACL propio en FalkorDB; el aislamiento es duro. Los dominios (personal, salud, ...) son metadata, no particiones. Todo en español salvo identificadores de código.

## Mapa de componentes

| Ruta | Qué es |
|---|---|
| `infra/` | FalkorDB (una instancia) + un contenedor MCP de Graphiti por tenant (`:8021`, `:8022`, ...) vía docker compose. `make up` / `make down` / `make backup` / `make add-tenant NAME=x PORT=y`; config por tenant en `infra/tenants/*.env` |
| `ingest/` | Paquete Python (uv). CLI `brain`: `brain login <url>` una vez, luego **`brain add <carpeta>`** hace todo. Por debajo son cinco etapas (`scan` → `extract` → `classify --auto` → `chunk` → `ingest-graph`), cada una registrada en el ledger para poder reanudar sin repetir ni repagar. Estado por tenant en `~/.brain/<tenant>/`; config en `~/.brain/env` |
| `gateway/` | Gateway OAuth multiusuario en `:8787` (Better Auth, signup por invitación) que enruta cada usuario autenticado a SU MCP de tenant según `tenants.json`; sin mapeo → 403 |
| `inbox/` | Zona de aterrizaje de documentos por ingestar |
| `archive/<dominio>/` | Originales ya ingestados, organizados por dominio |
| `backups/` | Respaldos de FalkorDB |
| `SCHEMA.md` | Ontología: dominios (metadata), entidades, aristas, reglas de fecha y sensibilidad |
| `scripts/` | Utilidades fuera del pipeline: `healthcheck.py` (E2E OAuth→guardar→buscar), `llm-cost.py` (gasto real desde `llm-usage.jsonl`), `fichas-excluidos.py` (fichas de lo que se decide NO ingerir), `notes-*.py` (export/triage de Apple Notes) |
| `.claude/skills/` | `/guardar`, `/ingest`, `/consultar` |
| `docs/decisiones.md` | Registro ADR de decisiones |

## Reglas de oro

1. **Nunca ingestar con la fecha de hoy como `reference_time`**, salvo que el hecho sea genuinamente de hoy. La fecha real del documento/hecho manda (prioridad: contenido > metadatos > mtime > preguntar al usuario). Un grafo temporal con fechas de ingesta es un grafo inútil.
2. **Nunca almacenar secretos en crudo** (contraseñas, tokens, API keys, PIN, frases semilla). Redactar con `[REDACTADO]` y guardar solo la referencia (entidad `Credencial`: qué existe y dónde está guardada).
3. **Repos de código → codebase-memory-mcp, no Graphiti.** El grafo es para hechos de vida y decisiones, no para código fuente ni detalles de implementación de repos.
4. **Nunca mezclar tenants.** Cada operación (guardar, ingestar, consultar) actúa sobre el grafo de UN solo tenant. El CLI local usa `--tenant jpreyest` por defecto; para operar otro tenant debe indicarse explícitamente, y jamás se leen ni escriben datos de un tenant en el grafo de otro. El aislamiento por grafo+proceso separado existe justamente para que un filtro olvidado no pueda filtrar datos entre personas — no lo debilites con atajos.
5. **El ledger se actualiza solo vía el CLI `brain`, nunca a mano.** No editar el ledger ni ingestar documentos saltándose el pipeline; el ledger es lo que evita duplicados. Para reingerir tras vaciar el grafo existe `brain add <carpeta> --rehacer`, que devuelve esos documentos a la cola sin tocar el grafo ni los archivos — no hace falta ningún `DELETE` a mano.
6. **`group_id` es SIEMPRE el tenant, jamás el dominio.** El driver de FalkorDB usa el `group_id` como nombre del grafo (un grafo por tenant); el servidor MCP lo fuerza. El dominio (según SCHEMA.md) viaja como metadata: en el `source_description` estructurado (`dominio: <dominio> | tipo: <doc_type> | origen: <descripcion>`) y como prefijo `[<dominio>]` en el nombre del episodio. Los hechos que cambian se invalidan (`invalid_at`), jamás se borran.
7. Datos médicos y financieros sí se ingestan, pero con flag de sensibilidad (`sensitivity=medical|financial`).
8. **Antes de ingerir, verificar CONTRA QUÉ GRAFO se está escribiendo.** `127.0.0.1:6379` en el Mac es el FalkorDB del Docker **local**, no el del servidor; el del servidor está en su `:6380` y solo se alcanza por túnel SSH explícito. Comprobar con `docker ps` y `lsof -nP -iTCP:6379 -sTCP:LISTEN` antes de lanzar un lote: dos grafos divergentes es el error más caro, porque no falla nada, simplemente los datos aparecen donde nadie los consulta.
9. **No ingerir datos tabulares crudos ni borradores.** Una planilla contable se parte en decenas de miles de episodios que ahogan el grafo con asientos sueltos sin aportar un hecho consultable; un borrador de contrato contradice a su versión firmada y el grafo no tiene cómo saber cuál manda. Para ambos: marcarlos `skipped` en el ledger con el motivo y generar una **ficha** (`scripts/fichas-excluidos.py`) que describa qué es el archivo y apunte a su ruta. La ficha sí entra al grafo.

## Advertencias operacionales

- La cola de episodios del MCP server ya **persiste en disco** (`BRAIN_QUEUE_DIR`): cada
  episodio se anota antes de procesarse y lo pendiente se reencola al arrancar. Antes un
  reinicio los perdía en silencio *después* de responder "encolado" al cliente. Aun así,
  `add_memory` responde al ENCOLAR y no al terminar: quien empuje episodios debe
  **verificar** que llegaron (el CLI lo hace y marca en error lo no confirmado).
- **`session.run()` del driver de FalkorDB DESCARTA el resultado y devuelve `None` siempre.**
  Es fire-and-forget. Para LEER hay que usar `driver.execute_query()`, que además sí
  sustituye los parámetros (`$var`) — con `session.run()` tampoco llegan, y eso invita a
  concatenar Cypher a mano, que es peor. Síntoma: consultas de conteo devolviendo 0 con el
  grafo lleno.
- **La ontología de entidades no es decorativa.** Con la genérica de upstream (que traía
  `Topic`/`Object` "use as last resort" y ningún tipo `Persona`), las tres entidades más
  conectadas del grafo eran `General Partner`, `Partnership` y `Limited Partners` — roles
  del articulado de los contratos — por delante de la sociedad real y del dueño. Se corrige
  con tipos concretos **y** con `custom_extraction_instructions` que digan qué NO extraer:
  la ontología sola no basta.
- La extracción usa qwen2.5:7b-instruct local (~1 min/episodio). NO usar modelos razonadores (qwen3) — 20x más lentos. NO usar DeepSeek — no soporta json_schema.
  Para acelerar: `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` en `.env`, o un modelo
  no-razonador en `MODEL_NAME`. Chat y embeddings se configuran por separado
  (`LLM_API_KEY`/`LLM_API_URL`/`LLM_MODEL` vs `EMBEDDER_API_KEY`/`EMBEDDER_API_URL`):
  la combinación en uso es gpt-4o-mini para extraer + NVIDIA `nv-embed-v1` (4096 dims)
  para embeddings, y **cambiar el proveedor o la dimensión de los embeddings corrompe
  la búsqueda del grafo existente**.
- **Nunca matar el CLI con `kill -9`.** Cada proceso muerto a la fuerza deja consultas
  encoladas en FalkorDB; al acumularse aparece `Max pending queries exceeded` y desde
  ahí **toda** consulta al grafo se cuelga, incluida la creación de índices al arrancar,
  así que el síntoma es "el ingest no hace nada y no escribe log". Se recupera
  reiniciando el contenedor (`docker restart brain-falkordb`); los datos persisten.
  Para detenerlo, `SIGTERM` (el ledger reanuda desde el último chunk).
- **Graphiti construye sus clientes HTTP sin timeout.** Hay que pasarle uno propio a los
  **tres**: LLM, embedder y cross-encoder. Dejar `cross_encoder=None` no significa "sin
  reranker": crea el suyo contra `api.openai.com`, sin timeout, y una conexión a medias
  deja el lote colgado indefinidamente (pasó: 13 h, 3 s de CPU y cero episodios).
  Se ajusta con `LLM_TIMEOUT_SECONDS` (120 s por defecto).
- **Para estimar costo, contar chunks con `json.load`, no líneas.** Los archivos de
  `~/.brain/<tenant>/chunks/` son arrays JSON indentados: cada chunk ocupa ~8 líneas, así
  que `wc -l` infla la cuenta ~10x. Un error así llevó a estimar USD 296 donde eran 36.
  Referencia real: gpt-4o-mini ≈ **USD 0,004 por chunk**, ~15 s por episodio.
- Un `.xls` a menudo **no es Excel**: los exports de banca y contabilidad son tablas HTML
  renombradas. El extractor despacha por la firma del archivo, no por la extensión.

## Servidor (mybrain.rlz.cl, `root@37.27.190.92`)

Despliegue nativo (sin Docker) en `/opt/secondbrain-native/`, bajo el usuario `secondbrain`
— **no** `dev`, que está compartido con otros proyectos.

> **Migrado desde `root@178.62.201.63`** (2026-08). La máquina anterior tenía 3,9 GB de RAM
> compartidos con otras aplicaciones (`polytrade`, Postgres), y esa estrechez aparecía una y
> otra vez: 504 de Cloudflare al ingerir porque el origen no alcanzaba a responder, y sin
> espacio para el grafo proyectado (~1 GB) sin irse a swap. La máquina nueva es más grande,
> lo que además permite correr el **LLM de extracción en local** en vez de una API externa
> con límites de tasa.

- **FalkorDB escucha en `:6380`.** El `:6379` de esa máquina es **otro Redis de otra
  aplicación**: consultarlo da respuestas que parecen válidas (`INFO` responde) pero son
  de otro sistema, y `GRAPH.LIST` falla con "unknown command". Diagnosticar contra el
  puerto equivocado ya llevó a conclusiones falsas sobre pérdida de datos.
- Credenciales del tenant `jpreyest` en `/opt/secondbrain-native/mcp.env` (unidad legacy
  `brain-mcp.service`); los tenants nuevos viven en `tenants/<nombre>/` con la unidad
  plantilla `brain-mcp@`. Ambos esquemas conviven.
- El chat y los embeddings se configuran por separado a propósito: **los embeddings deben
  seguir en NVIDIA `nv-embed-v1` a 4096 dimensiones**, pase lo que pase con el chat. Cambiar
  el proveedor o la dimensión del embedder corrompe la búsqueda del grafo existente y no se
  arregla reingiriendo.
- Cualquier modelo de extracción debe soportar **`json_schema`** (structured output):
  Graphiti lo exige. Por eso NO sirve DeepSeek (solo `json_object`).

### LLM local: probado y descartado para lotes (2026-08)

La máquina tiene 8 núcleos y 15 GB, pero **sin GPU**. Se instaló Ollama y se midió el
episodio completo (Graphiti hace ~6-9 llamadas por episodio):

| modelo | s/episodio | ruido en las entidades |
|---|---:|---|
| `gpt-4o-mini` (API) | **~15** | ninguno |
| `qwen2.5:3b-instruct` | 301 | **sí** — mete "Sale Notice", "Receiving Party" |
| `phi4-mini` | 702 | ninguno |

Y por llamada suelta, con el mismo texto de contrato: gemma3:1b 25 s (4 entidades útiles),
phi4-mini 51 s (6, sin ruido), gemma3:4b 57 s (6, sin ruido), llama3.2:3b 77 s (6, sin
ruido), qwen2.5:3b 33 s (4, **2 de ruido**).

**Conclusión: en CPU no es viable para volumen.** Los ~1.500 fragmentos pendientes serían 5
días con qwen (y grafo sucio) o 12 días con phi4-mini, contra ~6 horas con gpt-4o-mini. El
límite de tasa se ataja mejor con `BRAIN_RITMO` que pagando 20-45x en tiempo.

Ollama queda instalado como respaldo. Para cambiar, en `mcp.env`:
`LLM_MODEL=phi4-mini` + `LLM_API_URL=http://127.0.0.1:11434/v1` + `LLM_API_KEY=ollama`.
Si algún día la máquina lleva GPU, la configuración ya está probada. **Si se usa local,
que sea phi4-mini o gemma3, nunca qwen2.5:3b**: es el único que no respeta las
instrucciones negativas de la ontología.

## Flujos habituales

- Guardar un hecho suelto: skill `/guardar`.
- Procesar documentos de `inbox/`: skill `/ingest`, o `brain add inbox/`.
- **La ingesta no necesita claves de LLM en el cliente**: por el conector MCP la extracción la hace el servidor. Solo `ingest-graph --via falkordb` (acceso directo a la base, para administradores) las requiere.
- Consultar el grafo: skill `/consultar` (estado actual = facts vigentes; historia = incluir invalidados).
- Levantar/bajar el stack: `make up` / `make down` en `infra/`. Respaldo: `make backup`.
