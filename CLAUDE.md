# CLAUDE.md — secondbrain

Second brain multi-tenant: un grafo temporal de conocimiento (Graphiti sobre FalkorDB) por persona, donde se guardan hechos personales, médicos, financieros, laborales y de proyectos, con historia completa (los hechos se invalidan, nunca se borran). Cada tenant tiene su propio grafo (nombre del grafo = tenant = `group_id` de todos sus episodios) y su propio contenedor MCP con usuario ACL propio en FalkorDB; el aislamiento es duro. Los dominios (personal, salud, ...) son metadata, no particiones. Todo en español salvo identificadores de código.

## Mapa de componentes

| Ruta | Qué es |
|---|---|
| `infra/` | FalkorDB (una instancia) + un contenedor MCP de Graphiti por tenant (`:8021`, `:8022`, ...) vía docker compose. `make up` / `make down` / `make backup` / `make add-tenant NAME=x PORT=y`; config por tenant en `infra/tenants/*.env` |
| `ingest/` | Paquete Python (uv). CLI `uv run brain --tenant <t>` (default `jpreyest`): `scan` → `extract` → `classify` → `classify --apply` → `chunk` → `ingest-graph` → `status`. Ledger y estado por tenant en `~/.brain/<tenant>/` |
| `gateway/` | Gateway OAuth multiusuario en `:8787` (Better Auth, signup por invitación) que enruta cada usuario autenticado a SU MCP de tenant según `tenants.json`; sin mapeo → 403 |
| `inbox/` | Zona de aterrizaje de documentos por ingestar |
| `archive/<dominio>/` | Originales ya ingestados, organizados por dominio |
| `backups/` | Respaldos de FalkorDB |
| `SCHEMA.md` | Ontología: dominios (metadata), entidades, aristas, reglas de fecha y sensibilidad |
| `.claude/skills/` | `/guardar`, `/ingest`, `/consultar` |
| `docs/decisiones.md` | Registro ADR de decisiones |

## Reglas de oro

1. **Nunca ingestar con la fecha de hoy como `reference_time`**, salvo que el hecho sea genuinamente de hoy. La fecha real del documento/hecho manda (prioridad: contenido > metadatos > mtime > preguntar al usuario). Un grafo temporal con fechas de ingesta es un grafo inútil.
2. **Nunca almacenar secretos en crudo** (contraseñas, tokens, API keys, PIN, frases semilla). Redactar con `[REDACTADO]` y guardar solo la referencia (entidad `Credencial`: qué existe y dónde está guardada).
3. **Repos de código → codebase-memory-mcp, no Graphiti.** El grafo es para hechos de vida y decisiones, no para código fuente ni detalles de implementación de repos.
4. **Nunca mezclar tenants.** Cada operación (guardar, ingestar, consultar) actúa sobre el grafo de UN solo tenant. El CLI local usa `--tenant jpreyest` por defecto; para operar otro tenant debe indicarse explícitamente, y jamás se leen ni escriben datos de un tenant en el grafo de otro. El aislamiento por grafo+proceso separado existe justamente para que un filtro olvidado no pueda filtrar datos entre personas — no lo debilites con atajos.
5. **El ledger se actualiza solo vía el CLI `brain`, nunca a mano.** No editar el ledger ni ingestar documentos saltándose el pipeline (`scan` → ... → `ingest-graph`); el ledger es lo que evita duplicados.
6. **`group_id` es SIEMPRE el tenant, jamás el dominio.** El driver de FalkorDB usa el `group_id` como nombre del grafo (un grafo por tenant); el servidor MCP lo fuerza. El dominio (según SCHEMA.md) viaja como metadata: en el `source_description` estructurado (`dominio: <dominio> | tipo: <doc_type> | origen: <descripcion>`) y como prefijo `[<dominio>]` en el nombre del episodio. Los hechos que cambian se invalidan (`invalid_at`), jamás se borran.
7. Datos médicos y financieros sí se ingestan, pero con flag de sensibilidad (`sensitivity=medical|financial`).

## Advertencias operacionales

- La cola de episodios del MCP server es **en memoria**: no ejecutar `make up`/`make down`
  ni reiniciar contenedores con episodios en vuelo (se pierden silenciosamente). Verificar
  antes con `docker logs brain-mcp-<tenant>` que no haya "Processing episode" sin su
  "Successfully processed". La vía durable para lotes es la CLI `brain` (ledger reanudable).
- La extracción usa qwen2.5:7b-instruct local (~1 min/episodio). NO usar modelos razonadores (qwen3) — 20x más lentos. NO usar DeepSeek — no soporta json_schema.
  Para acelerar: `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` en `.env`, o un modelo
  no-razonador en `MODEL_NAME`.

## Flujos habituales

- Guardar un hecho suelto: skill `/guardar`.
- Procesar documentos de `inbox/`: skill `/ingest`.
- Consultar el grafo: skill `/consultar` (estado actual = facts vigentes; historia = incluir invalidados).
- Levantar/bajar el stack: `make up` / `make down` en `infra/`. Respaldo: `make backup`.
