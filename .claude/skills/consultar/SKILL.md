---
name: consultar
description: Consultar el second brain (grafo Graphiti) de forma efectiva. Usar cuando el usuario pregunta por datos personales guardados ("¿cuál es mi cuenta?", "¿cuándo fue mi último examen?", "¿qué decidimos en el proyecto X?") o dice /consultar.
---

# /consultar — Cómo consultar bien el grafo

Usar las tools MCP de graphiti disponibles en la sesión (búsqueda de facts/edges, nodos y episodios).

> **Multi-tenant**: la sesión ve únicamente el grafo del tenant actual (localmente, `jpreyest`); las consultas no cruzan tenants. Si algo "no aparece", puede haberse ingestado bajo otro `--tenant`, no buscar en grafos ajenos.

> **Modelo de particionado**: un grafo por tenant y `group_id == tenant` siempre (el servidor lo fuerza). Los **dominios** (`personal`, `salud`, `finanzas`, ...) NO son `group_ids`: son metadata en el `source_description` (`dominio: ...`) y en el prefijo `[dominio]` del nombre del episodio. No usar `group_ids` para filtrar por dominio.

## Estrategia según el tipo de pregunta

**Estado actual** ("¿cuál es mi cuenta principal?", "¿dónde trabajo ahora?"):
- Buscar **facts vigentes**: aristas sin `invalid_at` (no invalidadas). Ignorar hechos invalidados.
- Si dos facts vigentes se contradicen, preferir el de `valid_at` más reciente y avisar la inconsistencia al usuario.

**Historia / evolución** ("¿qué cuentas he tenido?", "¿cómo ha variado mi colesterol?"):
- Incluir facts **invalidados** (tienen `invalid_at`) y, si hace falta más detalle, recuperar los **episodios** originales.
- Presentar en orden cronológico usando `valid_at`/`invalid_at`, señalando qué reemplazó a qué (aristas `REEMPLAZA_A`).

## Reglas generales

1. **Acotar por dominio cuando es claro** (pregunta médica → `salud`; bancaria → `finanzas`; de un proyecto → `proyecto-<slug>`), pero NO vía `group_ids`: el filtrado por dominio se hace **mencionando el dominio en la query semántica** (ej: "salud: perfil lipídico") y/o **filtrando los resultados por su `source_description`** (`dominio: salud`) o por el prefijo `[salud]` del nombre del episodio. Es un filtro blando: si arroja poco, repetir la búsqueda sin acotar por dominio.
2. **Citar la fuente**: si el fact o episodio trae `source_path` en su `source_description`, citarlo en la respuesta (ej: "según `archive/salud/2026-07-12_perfil_lipidico.pdf`"). Si no hay `source_path`, indicar el origen ("nota guardada vía /guardar el ...").
3. **Fechas explícitas**: responder siempre anclando en fechas ("desde marzo 2026 tu cuenta principal es..."), no en términos relativos sueltos.
4. **Reformular antes de rendirse**: si una búsqueda no encuentra nada, reintentar con sinónimos, nombres de entidades del SCHEMA.md, o el nombre de la institución; luego probar sin mencionar el dominio en la query. Solo entonces responder "no está en el grafo".
5. **No inventar**: si el grafo no tiene el dato, decirlo y ofrecer guardarlo con `/guardar`.
