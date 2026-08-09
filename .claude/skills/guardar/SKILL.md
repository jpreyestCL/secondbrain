---
name: guardar
description: Guardar un hecho, nota o dato en el second brain (grafo Graphiti). Usar cuando el usuario dice /guardar, "guarda esto", "anota que...", "recuerda que..." o quiere persistir cualquier información personal, financiera, médica, laboral o de proyectos en su memoria de largo plazo.
---

# /guardar — Guardar un hecho en el second brain

Guarda hechos en el grafo temporal de conocimiento usando las tools MCP de graphiti disponibles en la sesión (`add_episode` / `add_memory` o equivalentes).

> **Multi-tenant**: las tools MCP de la sesión ya apuntan al grafo del tenant actual (localmente, `jpreyest`). Esta skill opera SOLO sobre ese grafo; nunca guardar hechos de una persona en el grafo de otra.

> **`group_id` es SIEMPRE el tenant** (o simplemente se omite: el servidor MCP lo fuerza al tenant). NUNCA usar el dominio como `group_id` — el dominio (`personal`, `salud`, `finanzas`, `trabajo`, `proyecto-<slug>`) viaja como metadata: en el `source_description` (`dominio: ...`) y como prefijo `[dominio]` en el nombre del episodio.

## Procedimiento

1. **Identificar dominio y entidades** según `SCHEMA.md` (raíz del repo):
   - Elegir el **dominio** (metadata, no `group_id`): `personal`, `salud`, `finanzas`, `trabajo` o `proyecto-<slug>`.
   - Identificar qué entidades del esquema aparecen (Persona, CuentaBancaria, ExamenMedico, etc.) y qué aristas implica (TIENE_CUENTA, REEMPLAZA_A, ...). Redactar el episodio de forma que Graphiti pueda extraerlas: nombres completos, montos con moneda, instituciones explícitas.

2. **Determinar la fecha real** (`reference_time`):
   - La fecha en que el hecho ocurrió o empezó a ser cierto, NO la fecha de hoy (salvo que el hecho sea genuinamente de hoy).
   - Prioridad: fecha mencionada en el contenido > metadatos > mtime > preguntar.
   - Si es ambigua ("me cambié de banco hace unos meses"), **preguntar al usuario antes de guardar**. Si solo hay mes/año, usar el día 1 y anotarlo.

3. **Redactar secretos**:
   - Si el texto contiene contraseñas, tokens, claves, PIN o similares, reemplazarlos por `[REDACTADO]` y guardar solo la referencia (qué credencial existe y dónde está guardada). Nunca enviar el secreto a la tool MCP.

4. **Llamar a la tool MCP de graphiti** (`add_memory` / `add_episode`) con:
   - `group_id`: el tenant, u omitirlo (el servidor lo fuerza al tenant). NUNCA el dominio.
   - `name`: con prefijo de dominio — `[<dominio>] <título breve>`.
   - `reference_time`: fecha real en ISO 8601. El servidor acepta este parámetro en `add_memory` — pasarlo SIEMPRE con la fecha real del hecho, nunca omitirlo (si se omite, queda la fecha de hoy y el grafo temporal se corrompe).
   - `episode_body` / contenido: el hecho en texto claro y autocontenido.
   - `source_description` estructurado: `dominio: <dominio> | tipo: <doc_type> | origen: <descripcion>` (se pueden anexar campos extra con `|`, ej: `| sensitivity: medical | fecha_confianza: contenido`).

5. **Confirmar al usuario**: qué se guardó, en qué dominio y con qué fecha. Si el hecho invalida uno anterior, mencionarlo (Graphiti marca el anterior con `invalid_at`; no se borra nada).

## Ejemplos

### Ejemplo 1 — Cambio de cuenta bancaria (supersesión temporal)

Usuario: "Guarda que en marzo cerré mi cuenta corriente del BCI y ahora mi cuenta principal es la corriente del Banco de Chile."

- Dominio: `finanzas` (metadata; `group_id` se omite o es el tenant)
- `name`: `[finanzas] Cambio de cuenta principal BCI → Banco de Chile`
- `reference_time`: `2026-03-01` (solo se conoce el mes; confirmar día si el usuario lo sabe)
- Episodio: "jpreyest cerró su cuenta corriente en BCI en marzo de 2026. Desde esa fecha su cuenta principal es la cuenta corriente en Banco de Chile. La cuenta del Banco de Chile reemplaza a la cuenta del BCI."
- `source_description`: `dominio: finanzas | tipo: nota | origen: /guardar | sensitivity: financial | fecha_confianza: usuario`
- Resultado esperado: la arista `jpreyest TIENE_CUENTA cuenta BCI` queda con `invalid_at=2026-03`, se crea `TIENE_CUENTA` hacia la cuenta nueva y `REEMPLAZA_A` entre cuentas. Confirmar: "Guardado en finanzas con fecha marzo 2026; la cuenta BCI quedó marcada como histórica, no se borró."

### Ejemplo 2 — Examen médico

Usuario: "Anota que el perfil lipídico que me hice el 12 de julio en el Lab Blanco salió con colesterol total 210, LDL 140."

- Dominio: `salud` (metadata; `group_id` se omite o es el tenant)
- `name`: `[salud] Perfil lipídico Lab Blanco 2026-07-12`
- `reference_time`: `2026-07-12` (fecha del examen, no la de hoy)
- Episodio: "Examen perfil lipídico de jpreyest realizado el 12 de julio de 2026 en Laboratorio Blanco. Resultados: colesterol total 210 mg/dL, LDL 140 mg/dL."
- `source_description`: `dominio: salud | tipo: examen | origen: /guardar | sensitivity: medical | fecha_confianza: contenido`
- Entidades: ExamenMedico "Perfil lipídico" PERTENECE_A Institucion "Laboratorio Blanco"; Persona jpreyest RELACIONADO_CON el examen.

### Ejemplo 3 — Decisión de proyecto

Usuario: "Guarda que hoy decidimos en el proyecto secondbrain usar FalkorDB en vez de Neo4j por consumo de RAM."

- Dominio: `proyecto-secondbrain` (metadata; `group_id` se omite o es el tenant)
- `name`: `[proyecto-secondbrain] Decisión: FalkorDB en vez de Neo4j`
- `reference_time`: hoy en ISO 8601 (el hecho sí es de hoy — pasarlo igual, explícito)
- Episodio: "Decisión del proyecto secondbrain: usar FalkorDB en lugar de Neo4j como backend de grafo, por menor consumo de RAM."
- `source_description`: `dominio: proyecto-secondbrain | tipo: decision | origen: /guardar | sensitivity: normal | fecha_confianza: usuario`
- Sugerir además registrar la decisión en `docs/decisiones.md` si es arquitectónica.
