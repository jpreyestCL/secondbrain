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
| `.claude/skills/` | `/guardar`, `/absorber` (camino rápido: Claude extrae, el servidor no usa LLM), `/ingest` (lotes grandes con el CLI), `/consultar` |
| `docs/decisiones.md` | Registro ADR de decisiones |

## Reglas de oro

1. **Nunca ingestar con la fecha de hoy como `reference_time`**, salvo que el hecho sea genuinamente de hoy. La fecha real del documento/hecho manda (prioridad: contenido > metadatos > mtime > preguntar al usuario). Un grafo temporal con fechas de ingesta es un grafo inútil.
2. **Nunca almacenar secretos en crudo** (contraseñas, tokens, API keys, PIN, frases semilla). Redactar con `[REDACTADO]` y guardar solo la referencia (entidad `Credencial`: qué existe y dónde está guardada).
3. **Repos de código → codebase-memory-mcp, no Graphiti.** El grafo es para hechos de vida y decisiones, no para código fuente ni detalles de implementación de repos.
4. **Nunca mezclar tenants.** Cada operación (guardar, ingestar, consultar) actúa sobre el grafo de UN solo tenant. El CLI local usa `--tenant jpreyest` por defecto; para operar otro tenant debe indicarse explícitamente, y jamás se leen ni escriben datos de un tenant en el grafo de otro. El aislamiento por grafo+proceso separado existe justamente para que un filtro olvidado no pueda filtrar datos entre personas — no lo debilites con atajos.
5. **El ledger se actualiza solo vía el CLI `brain`, nunca a mano.** No editar el ledger ni ingestar documentos saltándose el pipeline; el ledger es lo que evita duplicados. Para reingerir tras vaciar el grafo existe `brain add <carpeta> --redo`, que devuelve esos documentos a la cola sin tocar el grafo ni los archivos — no hace falta ningún `DELETE` a mano.
6. **`group_id` es SIEMPRE el tenant, jamás el dominio.** El driver de FalkorDB usa el `group_id` como nombre del grafo (un grafo por tenant); el servidor MCP lo fuerza. El dominio (según SCHEMA.md) viaja como metadata: en el `source_description` estructurado (`dominio: <dominio> | tipo: <doc_type> | origen: <descripcion>`) y como prefijo `[<dominio>]` en el nombre del episodio. Los hechos que cambian se invalidan (`invalid_at`), jamás se borran.
7. Datos médicos y financieros sí se ingestan, pero con flag de sensibilidad (`sensitivity=medical|financial`).
8. **Antes de ingerir, verificar CONTRA QUÉ GRAFO se está escribiendo.** Ya pasó, y es el
   incidente más caro del proyecto: **339 documentos** quedaron marcados `ingested` en el
   ledger con sus episodios en el **FalkorDB local de Docker**, no en el servidor — que es
   el grafo que se consulta desde Claude. No falló nada: los datos estaban donde nadie los
   mira, y el ledger impedía reintentarlos porque los daba por hechos. Ahora el ledger
   guarda el **destino** de cada episodio y `brain doctor --episodes <archivo>` compara lo
   que dice el ledger contra los episodios que existen de verdad en el servidor
   (`--repair` devuelve a la cola lo que no esté). `127.0.0.1:6379` en el Mac es el FalkorDB del Docker **local**, no el del servidor; el del servidor está en su `:6380` y solo se alcanza por túnel SSH explícito. Comprobar con `docker ps` y `lsof -nP -iTCP:6379 -sTCP:LISTEN` antes de lanzar un lote: dos grafos divergentes es el error más caro, porque no falla nada, simplemente los datos aparecen donde nadie los consulta.
9. **No ingerir datos tabulares crudos ni borradores.** Una planilla contable se parte en decenas de miles de episodios que ahogan el grafo con asientos sueltos sin aportar un hecho consultable; un borrador de contrato contradice a su versión firmada y el grafo no tiene cómo saber cuál manda. Para ambos: marcarlos `skipped` en el ledger con el motivo y generar una **ficha** (`scripts/fichas-excluidos.py`) que describa qué es el archivo y apunte a su ruta. La ficha sí entra al grafo.

## Advertencias operacionales

- La cola de episodios del MCP server ya **persiste en disco** (`BRAIN_QUEUE_DIR`): cada
  episodio se anota antes de procesarse y lo pendiente se reencola al arrancar. Antes un
  reinicio los perdía en silencio *después* de responder "encolado" al cliente. Aun así,
  `add_memory` responde al ENCOLAR y no al terminar: quien empuje episodios debe
  **verificar** que llegaron (el CLI lo hace y marca en error lo no confirmado).
- **El diario de la cola es POR TENANT** (`$BRAIN_QUEUE_DIR/<group_id>/`). Cuando dos
  tenants compartían el directorio, el MCP de uno recuperaba al arrancar los episodios del
  otro — el glob no mira de quién son — y los reencolaba contra SU grafo. Lo frenó el ACL
  de FalkorDB (`No permissions to access a key`), o sea que el aislamiento aguantó, pero el
  proceso moría por esa excepción y al reiniciar repetía el ciclo: el diario ajeno se
  reescribía entero cada ~100 s y esa cola **no drenaba nunca**. El síntoma era
  desconcertante — los archivos cambiaban de nombre solos — porque cada reinicio traía una
  semilla de `hash()` nueva. Además de separar el directorio, `recuperar_pendientes` ignora
  (y **no borra**) las anotaciones de otro `group_id`.
- **Un 429 no siempre es ritmo: `insufficient_quota` es saldo agotado** y viene con el
  mismo código HTTP. Reintentarlo son 300 s por episodio tirados y un log que manda a
  investigar el ritmo en vez de la facturación. Se distingue y falla rápido.
- **El paralelismo de la cola va acotado y a propósito** (`BRAIN_WORKERS`, 3 por defecto).
  La marca de "ya hay worker" se ponía *dentro* de la tarea, así que recuperar cientos de
  episodios en un bucle cerrado creaba **un worker por episodio**: ~124 episodios
  simultáneos, 12 peticiones por segundo y cero avance. Acotado no es lo mismo que ausente:
  con 1 worker son ~2,4 min por episodio; con 3, ~22 s; con 5, ~12,9 s.
- **El cuello del ingest NO es la API del LLM.** Medido con gpt-4o-mini: 23% del límite
  de tokens (45k de 200k por minuto) y 0,5% del de peticiones, y el chat solo consume el
  13% del tiempo de los workers. El resto se va en los **34 embeddings por episodio** y en
  las escrituras al grafo. Antes de subir `BRAIN_WORKERS` hay que mirar **FalkorDB**:
  `THREAD_COUNT` son 8 hilos **compartidos entre todos los tenants** de la máquina, y
  `TIMEOUT=0` significa que ninguna consulta caduca — una sola atascada retiene un hilo
  para siempre. Subir de 5 a 8 workers dejó la base entera sin responder (ni a `PING`).
- **Los embeddings por lote están escritos y APAGADOS** (`BRAIN_EMBED_LOTE=0`). `add_episode`
  genera los embeddings que faltan en un bucle secuencial —20 llamadas HTTP por episodio—
  y el parche de `factories.py` los pre-genera en lotes de 64. Funciona: verificado contra
  `nv-embed-v1` que un lote devuelve los vectores **bit a bit idénticos** a pedirlos sueltos
  (diferencia 0,00e+00), así que no toca la búsqueda del grafo. Pero al quitar esos ~15 s de
  espera por episodio, los 5 workers dejan de estar escalonados y golpean FalkorDB a la vez:
  **el grafo se traba a los 35 s** (`PING` responde, `GRAPH.QUERY` se cuelga), contra 12+
  minutos sano sin lotes. Antes de encenderlo hay que **serializar la escritura** (un lock
  alrededor de `add_nodes_and_edges_bulk`) o ponerle `TIMEOUT` a las consultas. Acelerar sin
  resolver la escritura solo mueve el cuello a un sitio donde tumba el servicio.
- **Reiniciar el MCP con episodios en vuelo traba el grafo.** Pasó dos veces seguidas: el
  arranque se queda colgado justo después de `Creating OpenAI Embedder client`, que es
  cuando toca crear los índices, y no escribe ni una línea más. Parar el MCP y esperar antes
  de reiniciar, y si ya pasó, reiniciar FalkorDB.
- **Si FalkorDB deja de responder**, en el deploy nativo se recupera con
  `systemctl restart brain-falkordb` (el equivalente del `docker restart` documentado más
  abajo). Con `appendonly yes` + `appendfsync everysec` se arriesga como mucho **1 segundo**
  de escrituras: verificado en el incidente del 2026-08-16, donde no se perdió ningún
  episodio. Parar antes los MCP evita dejar más consultas colgadas.
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

Y en el episodio COMPLETO la calidad se desploma más de lo que sugiere la prueba de una
llamada suelta. `gemma3:1b` (320 s/episodio), sobre "contraté a Rodrigo Munoz como abogado de
Inversiones Linets SpA por 3 millones de pesos mensuales", produjo: el nombre de la sociedad
**mal escrito** (`Inversión Linets SpA` — una entidad nueva que fragmenta el grafo en vez de
unirse a la que ya existe), el monto como **dos entidades** distintas, y **dos entidades que
no estaban en el texto** (`Banco Chile` y una dirección, esta última tipada como `Cuenta`).
No es solo ruido: son datos inventados y duplicados sobre los que después se consulta.

La prueba de una llamada engaña. El pipeline real encadena varias (extraer, deduplicar,
resumir) y ahí los modelos chicos alucinan. **Medir siempre el episodio completo.**

**Conclusión: en CPU no es viable para volumen.** Los ~1.500 fragmentos pendientes serían 5
días con qwen (y grafo sucio) o 12 días con phi4-mini, contra ~6 horas con gpt-4o-mini. El
límite de tasa se ataja mejor con `BRAIN_RITMO` que pagando 20-45x en tiempo.

Ollama queda instalado como respaldo. Para cambiar, en `mcp.env`:
`LLM_MODEL=phi4-mini` + `LLM_API_URL=http://127.0.0.1:11434/v1` + `LLM_API_KEY=ollama`.
Si algún día la máquina lleva GPU, la configuración ya está probada. **Si se usa local,
que sea phi4-mini o gemma3, nunca qwen2.5:3b**: es el único que no respeta las
instrucciones negativas de la ontología.

## Las dos vías de ingesta, y cuándo usar cada una

| | `add_facts` (skill `/absorber`) | `add_memory` (CLI `brain`, skill `/ingest`) |
|---|---|---|
| Quién extrae | **Claude, aquí** | el servidor, con su LLM |
| Unidad | **un documento** | un trozo de ~4,4 KB |
| Coste en el servidor | 1 lote de embeddings + ~4 consultas | ~8 llamadas de LLM + ~22 embeddings + ~70 consultas |
| **Medido** | **306 ms/documento, USD 0** | **110-150 s/trozo, USD 0,0066** |
| Para qué | lo que Claude puede leer | carpetas grandes, OCR, reanudación |

La diferencia de tres órdenes de magnitud **no** es que una capa sea más rápida: es que el peaje por episodio (extraer, deduplicar, resolver aristas, invalidar) es casi todo fijo, y pagarlo por trozo de 4 KB multiplica ese coste por el número de trozos. Medido en este corpus: 840 documentos son 2.017 trozos, o sea ~62 horas por el camino largo y ~4 minutos por el corto.

Lo que `add_facts` hace sin modelo, y que Graphiti hacía con él:

- **Deduplicar**: nombre normalizado (sin tildes ni puntuación, siglas recompuestas: `Inversiones Linets S.p.A.` = `INVERSIONES LINETS SPA`). Deliberadamente más estricto que el LLM — no adivina que "Banco Chile" es "Banco de Chile", porque fusionar dos entidades distintas es irreversible.
- **Invalidar**: un hecho nuevo sobre el mismo sujeto y la misma relación, con fecha posterior, invalida al anterior. **Sin fecha no invalida nada.**

⚠️ **`SCHEMA.md` divergió de la ontología desplegada.** El documento describe `CuentaBancaria`, `Institucion`, `Proyecto`...; el servidor acepta `Persona, Organizacion, Lugar, Documento, Cuenta, Activo, Obligacion, Evento, Condicion, Credencial` (los de `infra/graphiti/config.yaml`, que son los que `add_facts` valida). Un tipo fuera de esa lista entra como `Entidad` y pierde la ontología. Hay que reconciliar los dos.

## Flujos habituales

- Guardar un hecho suelto: skill `/guardar`.
- Procesar documentos de `inbox/`: skill `/ingest`, o `brain add inbox/`.
- **La ingesta no necesita claves de LLM en el cliente**: por el conector MCP la extracción la hace el servidor. Solo `ingest-graph --via falkordb` (acceso directo a la base, para administradores) las requiere.
- Consultar el grafo: skill `/consultar` (estado actual = facts vigentes; historia = incluir invalidados).
- Levantar/bajar el stack: `make up` / `make down` en `infra/`. Respaldo: `make backup`.
