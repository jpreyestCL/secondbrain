# secondbrain

Second brain **multi-tenant**: un grafo temporal de conocimiento por persona, donde cada tenant guarda hechos de su vida —salud, finanzas, trabajo, proyectos— con historia completa. Los hechos nunca se borran: cuando algo cambia, el hecho anterior se marca como inválido desde esa fecha. Motor: [Graphiti](https://github.com/getzep/graphiti) sobre FalkorDB, operado desde Claude Code y desde claude.ai (conector remoto). Aislamiento duro: cada persona tiene su propio grafo (nombre = tenant; el `group_id` de todos sus episodios es el tenant), su propio usuario ACL en FalkorDB y su propio proceso MCP; el gateway solo enruta a cada usuario autenticado hacia SU upstream. Los dominios (salud, finanzas, ...) son metadata dentro del grafo, no particiones.

## Arquitectura

```
 claude.ai (usuario A) ─┐      ┌──────────────────────────────────────┐
 claude.ai (usuario B) ─┼─────►│   gateway/ OAuth  :8787              │
   conectores remotos   │      │   (Better Auth, multiusuario,        │
                        │      │    signup por invitación)            │
                        │      │   tenants.json: user → upstream      │
                        │      │   usuario sin mapeo → 403            │
                        │      └───────┬──────────────────┬───────────┘
                        │              │ solo SU upstream │
 ┌───────────────┐  MCP │              ▼                  ▼
 │  Claude Code  │──────┘   ┌───────────────────┐  ┌───────────────────┐
 │  /guardar     │─────────►│ Graphiti MCP      │  │ Graphiti MCP      │
 │  /ingest      │ (tenant  │ tenant jpreyest   │  │ tenant <otro>     │
 │  /consultar   │  local)  │ :8021             │  │ :8022 ...         │
 └───────┬───────┘          └─────────┬─────────┘  └─────────┬─────────┘
         │ orquesta                   │                      │
         ▼                            ▼                      ▼
 ┌───────────────┐          ┌──────────────────────────────────────────┐
 │ ingest/ (uv)  │          │        FalkorDB (una instancia)          │──► backups/
 │ CLI `brain`   │─────────►│  un grafo por tenant (nombre = tenant =  │
 │  --tenant     │          │   group_id): jpreyest | <otro> | ...     │
 │ estado en     │          │  ACL por tenant; dominios (salud, ...)   │
 │ ~/.brain/<t>/ │          │  como metadata en source_description     │
 └───────┬───────┘          └──────────────────────────────────────────┘
         │
  inbox/ ──► scan ► extract ► classify ► chunk ► ingest-graph ──► archive/<dominio>/
```

- **`infra/`**: FalkorDB (una instancia) + un contenedor MCP de Graphiti **por tenant** (`:8021`, `:8022`, ...) vía docker compose (`make up|down|backup`, `make add-tenant NAME=x PORT=y`, config por tenant en `infra/tenants/*.env`).
- **`ingest/`**: pipeline de documentos, CLI `uv run brain --tenant <nombre>` (default `jpreyest`); estado por tenant en `~/.brain/<tenant>/`.
- **`gateway/`**: OAuth multiusuario (Better Auth, registro por invitación) que enruta cada usuario autenticado exclusivamente a su MCP; usuarios sin mapeo reciben 403.
- **`SCHEMA.md`**: la ontología (dominios, entidades, aristas, reglas de fecha y sensibilidad).
- **`CLAUDE.md`**: reglas de oro para Claude. **`docs/decisiones.md`**: registro de decisiones.

## Quickstart

1. **Levantar el stack**

   ```bash
   cd infra
   make up        # FalkorDB + MCP por tenant (:8021, :8022, ...) + gateway (:8787)
   ```

2. **Crear el usuario dueño del gateway**

   Seguir el README de `gateway/` para crear la cuenta owner (Better Auth) con tu email y mapearla en `tenants.json` al upstream del tenant `jpreyest` (`:8021`). El registro de cuentas adicionales es solo por invitación del owner.

3. **Conectar el conector remoto en claude.ai**

   En claude.ai → Settings → Connectors → *Add custom connector*, apuntar a la URL pública del gateway (puerto `8787`, típicamente detrás de un túnel o dominio propio) y completar el flujo OAuth con la cuenta owner. El gateway enruta la sesión al grafo del tenant mapeado a esa cuenta.

4. **Primer `/guardar`**

   En Claude Code, dentro de este repo:

   ```
   /guardar mi cuenta principal es la cuenta corriente del Banco de Chile desde enero 2024
   ```

   Claude clasifica el dominio (`finanzas`), fija la fecha real (2024-01) y crea el episodio vía MCP.

## Uso diario

- **Guardar un hecho**: `/guardar <hecho>` — desde Claude Code o conversando en claude.ai (el conector expone las mismas tools). Claude pregunta la fecha si es ambigua y redacta cualquier secreto.
- **Ingestar documentos**: dejar PDFs/imágenes en `inbox/` y correr `/ingest inbox`. Claude clasifica cada documento (dominio, tipo, fecha real, sensibilidad), lo ingesta al grafo y mueve el original a `archive/<dominio>/`. En lotes grandes revisa una muestra contigo antes de procesar todo.
- **Consultar**: `/consultar` o preguntar directamente ("¿cuándo fue mi último perfil lipídico?"). Estado actual usa solo hechos vigentes; preguntas de historia incluyen los invalidados.

Todas las operaciones locales actúan sobre el tenant por defecto (`jpreyest`); las skills nunca cruzan tenants. Para operar otro tenant desde el CLI: `uv run brain --tenant <nombre> ...`.

## Multi-tenant: cómo agregar a otra persona

Cada persona obtiene un grafo propio (nombre del grafo = tenant), un usuario ACL de FalkorDB propio (`tenant_<nombre>`, password en `infra/tenants/<nombre>.env`) y un proceso MCP propio — aislamiento duro, sin datos compartidos. Pasos:

1. **Crear el tenant en infra**

   ```bash
   cd infra
   make add-tenant NAME=maria PORT=8022
   ```

   Esto genera `infra/tenants/maria.env` (incluida su credencial ACL `FALKORDB_TENANT_PASSWORD`), agrega el contenedor MCP del tenant (`:8022`) apuntando al grafo `maria` en la instancia FalkorDB compartida (el servidor fuerza `group_id=maria`), y lo levanta.

2. **Crear su usuario en el gateway**

   Como owner, generar una invitación desde el gateway (Better Auth; no hay registro abierto). La persona crea su cuenta con esa invitación.

3. **Mapear usuario → tenant en `tenants.json`**

   En la config del gateway, mapear el email/usuario de la persona al upstream `:8022`. Sin este mapeo, cualquier request autenticada de ese usuario recibe **403** — nunca cae a un tenant por defecto.

4. **Ella conecta su propio conector en claude.ai**

   Con su cuenta de claude.ai agrega el conector (misma URL pública del gateway) y autoriza con SU cuenta del gateway. El gateway la enruta exclusivamente a su MCP; jamás verá el grafo de otro tenant.

Para ingesta local de sus documentos: `uv run brain --tenant maria scan ...` (estado del pipeline en `~/.brain/maria/`).

## Backup y restauración

- **Respaldar**: `cd infra && make backup` — dump de FalkorDB en `backups/` con timestamp (la instancia es compartida, así que el dump incluye los grafos de **todos** los tenants). Hacerlo antes de ingestas masivas y periódicamente (los originales ya viven en `archive/`, pero el grafo tiene la extracción y la temporalidad).
- **Restaurar**: bajar el stack (`make down`), reponer el dump en el volumen de FalkorDB según el README de `infra/`, y `make up`. Verificar con `/consultar` que los hechos recientes estén.
- `archive/` + `backups/` son los dos directorios a respaldar fuera de la máquina.

## Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| Las tools de graphiti no aparecen en la sesión | Stack abajo o MCP no registrado | `cd infra && make up`; verificar `docker compose ps` y la config MCP de Claude Code |
| `ingest-graph` falla con error de conexión | FalkorDB o el MCP del tenant no responde (`:8021`, `:8022`, ...) | `make down && make up`; revisar logs con `docker compose logs` |
| claude.ai no conecta el conector | Gateway caído, URL no pública o token OAuth vencido | Verificar `:8787` accesible desde internet; reautorizar el conector |
| Conector responde 403 | Usuario autenticado pero sin mapeo en `tenants.json` | Mapear el usuario a su upstream de tenant en la config del gateway (es intencional: sin mapeo no hay acceso) |
| Datos que "no aparecen" tras ingestar | Se ingirió con otro `--tenant` | Verificar el tenant usado (`~/.brain/<tenant>/`); el CLI local usa `jpreyest` por defecto |
| Documento no se ingesta (lo salta) | Ya está en el ledger | `uv run brain status` para ver su estado; el ledger evita duplicados a propósito |
| Extracción vacía en un PDF | PDF escaneado sin OCR | Revisar salida de `extract`; procesar ese archivo aparte |
| Hechos con fecha de hoy que no corresponden | Se ingirió sin fecha real | Nunca aceptar la fecha por defecto; corregir guardando el hecho con la fecha correcta (el erróneo quedará invalidado) |
| Respuestas mezclan dominios | Búsqueda sin acotar por dominio | Mencionar el dominio en la query semántica o filtrar por `source_description` (`dominio: ...`); ver `/consultar` |
