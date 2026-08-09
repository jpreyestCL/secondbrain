# Registro de decisiones (ADR)

Formato: una entrada por decisión, estilo ADR liviano. Estados: `aceptada`, `reemplazada por ADR-XXX`, `descartada`.

---

## ADR-001 — Graphiti + FalkorDB como motor del grafo

- **Fecha**: 2026-08
- **Estado**: aceptada

**Contexto.** Se evaluaron Basic Memory (notas markdown + búsqueda), mem0 (memoria de LLM gestionada) y Graphiti (grafo temporal de conocimiento) como núcleo del second brain.

**Decisión.** Usar Graphiti con FalkorDB como backend.

**Razones.**
- **Temporalidad bi-temporal nativa**: Graphiti modela `valid_at`/`invalid_at` por arista. "¿Cuál es mi cuenta AHORA?" y "¿qué cuentas he tenido?" son consultas de primera clase; los hechos se invalidan, no se sobreescriben. Basic Memory y mem0 no modelan supersesión temporal de hechos.
- **Episodios + entidades**: se conserva el contenido crudo (episodio, con `reference_time` = fecha real del documento) y encima el grafo de entidades/aristas extraídas. Basic Memory se queda en el nivel de nota; mem0 abstrae demasiado y pierde el control del esquema.
- **Ontología propia**: Graphiti acepta tipos de entidad custom (ver `SCHEMA.md`), clave para dominios sensibles (salud, finanzas).
- **FalkorDB sobre Neo4j**: mucho más liviano (Redis-based) para un despliegue personal permanente en una máquina propia; soporte oficial en Graphiti; un solo contenedor.
- **MCP server incluido**: Graphiti trae servidor MCP, lo que habilita tanto Claude Code local como el conector remoto de claude.ai sin código propio de servidor.

**Consecuencias.** Se requiere docker compose corriendo (`infra/`); la calidad del grafo depende de la disciplina de fechas y dominios (reglas en `CLAUDE.md`).

---

## ADR-002 — Extracción y clasificación con la suscripción de Claude, no con API

- **Fecha**: 2026-08
- **Estado**: aceptada

**Contexto.** El pipeline de ingesta necesita leer, clasificar y fechar cada documento. Hacerlo con llamadas a la API de Anthropic tiene costo por token y duplica una capacidad ya pagada.

**Decisión.** La lectura, clasificación y fechado los hace Claude dentro de la sesión de Claude Code (suscripción), mediante el patrón manifiesto: `brain classify` emite un JSON con los documentos pendientes, Claude lo completa, y `brain classify --apply` lo aplica. El único uso de API son los embeddings de `ingest-graph` (costo marginal).

**Consecuencias.** La ingesta es semi-interactiva (requiere una sesión de Claude), a cambio de costo cercano a cero y revisión humana natural en el mismo flujo. El CLI queda determinista y testeable; la inteligencia vive en la skill `/ingest`.

---

## ADR-003 — OAuth del gateway con Better Auth

- **Fecha**: 2026-08
- **Estado**: aceptada

**Contexto.** El conector remoto de claude.ai exige un endpoint MCP público protegido con OAuth. El servidor MCP de Graphiti no trae autenticación multiusuario ni flujo OAuth completo.

**Decisión.** Un gateway propio (`gateway/`, puerto `8787`) implementa OAuth con Better Auth y proxya al MCP de Graphiti (`:8020`), que nunca se expone directo a internet. Una sola cuenta owner (el usuario) puede autorizar conectores.

**Razones.** Better Auth da el flujo OAuth estándar que espera el conector con mínimo código propio, en TypeScript, y permite agregar más proveedores o passkeys después. Alternativas (proxy con API key, túnel sin auth) eran inseguras para datos médicos/financieros.

**Consecuencias.** Un componente más que mantener y exponer públicamente; a cambio, el grafo con datos sensibles queda detrás de autenticación real.

---

## ADR-004 — El código fuente queda fuera del grafo

- **Fecha**: 2026-08
- **Estado**: aceptada

**Contexto.** La tentación natural es ingestar todo, incluidos los repos de código, al mismo grafo.

**Decisión.** Los repos de código se excluyen de Graphiti. La memoria de código va a codebase-memory-mcp; Graphiti guarda solo hechos de vida y **decisiones** de proyectos (el "qué" y el "por qué", no el "cómo" implementado).

**Razones.** El código cambia a un ritmo y granularidad que ensuciaría el grafo temporal (miles de micro-hechos obsoletos), los embeddings de código encarecerían la ingesta sin valor de consulta personal, y ya existe una herramienta especializada para ese dominio.

**Consecuencias.** Regla de oro en `CLAUDE.md`. Las decisiones de un proyecto sí se guardan (`group_id=proyecto-<slug>` y/o `docs/decisiones.md` del repo correspondiente).

---

## ADR-005 — Multi-tenant con aislamiento duro: grafo + proceso por persona

- **Fecha**: 2026-08
- **Estado**: aceptada (enmendada por ADR-006)

> **Nota (ADR-006)**: la premisa de que `group_id` conservaría su semántica de dominios dentro de cada tenant resultó inviable: el driver de FalkorDB usa el `group_id` como nombre del grafo. Ver ADR-006 — `group_id == tenant` siempre; el dominio pasó a ser metadata. El nombre del grafo tampoco es `brain_<tenant>` sino el tenant a secas.

**Contexto.** El sistema pasa a ser multi-tenant (varias personas, cada una con su second brain). Dos diseños posibles: (a) un solo grafo compartido con prefijos de `group_id` por persona (`maria-salud`, ...), o (b) un grafo FalkorDB por tenant (`brain_<tenant>`) con un proceso MCP de Graphiti propio por tenant.

**Decisión.** Aislamiento duro: cada tenant tiene su propio grafo `brain_<tenant>` y su propio contenedor MCP (`:8021`, `:8022`, ...), compartiendo una sola instancia FalkorDB. El gateway OAuth (Better Auth, multiusuario, signup por invitación) enruta cada usuario autenticado exclusivamente a su upstream según `tenants.json`; un usuario sin mapeo recibe 403. El CLI `brain` toma `--tenant` (default `jpreyest`) y mantiene estado por tenant en `~/.brain/<tenant>/`. `make add-tenant NAME=x PORT=y` provisiona un tenant nuevo (`infra/tenants/*.env`).

**Razones.**
- **Un filtro olvidado no puede filtrar datos entre personas.** Con prefijos de `group_id`, cada consulta y cada tool dependen de que el filtro esté SIEMPRE presente y correcto; un solo descuido expone datos médicos/financieros de otra persona. Con grafo + proceso separados, el proceso MCP de un tenant físicamente no puede leer el grafo de otro: la frontera de seguridad es estructural, no disciplinaria.
- El enrutamiento queda en un único punto auditable (el gateway), en vez de repartido en cada query.
- `group_id` conserva su semántica original (dominios) dentro de cada tenant, sin sobrecargarlo con identidad.
- Compartir la instancia FalkorDB mantiene el costo operativo bajo (un solo motor, backup único de todos los grafos).

**Consecuencias.** Un contenedor MCP adicional por persona (memoria extra, puertos por asignar); alta de tenants requiere paso de infra + mapeo en el gateway. El backup de FalkorDB contiene todos los tenants: la restauración parcial de un solo tenant es más delicada. Regla de oro nueva en `CLAUDE.md`: nunca mezclar tenants.

---

## ADR-006 — `group_id == tenant`; dominio como metadata

- **Fecha**: 2026-08
- **Estado**: aceptada (enmienda a ADR-005)

**Contexto.** Durante la integración se verificó empíricamente que el servidor MCP de Graphiti con backend FalkorDB usa el **`group_id` como nombre del grafo FalkorDB** e ignora el parámetro `database` en las operaciones de datos. Bajo el diseño de ADR-005 (dominios como `group_id` dentro del grafo del tenant), cada dominio habría creado su propio grafo con nombre `personal`, `salud`, etc. — **colisionando entre tenants** (el `salud` de una persona y el de otra serían el mismo grafo), y la búsqueda multi-grafo no está verificada. Eso rompería el aislamiento duro que ADR-005 buscaba.

**Decisión.** Un solo grafo por tenant y `group_id == tenant` SIEMPRE; el servidor MCP por tenant lo fuerza server-side. El dominio (`personal`, `salud`, `finanzas`, `trabajo`, `proyecto-<slug>`) deja de ser partición y viaja como **metadata**: en el `source_description` (formato `dominio: <dominio> | tipo: <doc_type> | origen: <descripcion>`) y como prefijo `[<dominio>]` en el nombre del episodio. Además, FalkorDB tiene usuarios ACL por tenant (`tenant_<nombre>`, password en `infra/tenants/<nombre>.env`, patrón de claves restringido a su grafo); el CLI `brain` se conecta con esa credencial (`FALKORDB_TENANT_USER`/`FALKORDB_TENANT_PASSWORD`, con fallback a `~/.brain/config.toml`).

**Consecuencias.** El filtrado por dominio pasa a ser **blando** (mención del dominio en la query semántica o filtro por `source_description`), no estructural; la frontera dura de seguridad es el par grafo-por-tenant + ACL de FalkorDB, que impide físicamente leer el grafo ajeno aun con un filtro olvidado. `SCHEMA.md`, `CLAUDE.md` y las skills se actualizan a este modelo; el nombre del grafo pasa de `brain_<tenant>` a `<tenant>`.
