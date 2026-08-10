# 🧠 secondbrain

Tu **segundo cerebro** conversacional: un grafo de conocimiento **temporal** donde
guardas todo lo que necesitas recordar —vida personal, salud, finanzas, trabajo,
proyectos— y lo consultas en **lenguaje natural desde Claude** (web, escritorio o móvil),
a través de un conector MCP. Sin apps nuevas, sin formularios: le hablas a Claude.

Lo que lo hace distinto:

- **Memoria temporal, con historia.** Los hechos nunca se borran. Si tu cuenta del banco
  cambia, el sistema marca la anterior como válida hasta esa fecha y registra la nueva.
  Preguntas "¿cuál es mi cuenta?" → te da la vigente. Preguntas "¿y antes?" → te da la
  historia con fechas.
- **Ingesta remota de documentos vía MCP.** Adjuntas un PDF, imagen, planilla o texto en
  un chat de Claude y él lo lee, lo clasifica y lo guarda en tu grafo. **Sin SSH, sin
  subir nada a un servidor.**
- **Tú eres dueño de tus datos.** Motor open-source ([Graphiti](https://github.com/getzep/graphiti)
  sobre [FalkorDB](https://www.falkordb.com/)). Puedes usar la instancia pública o
  auto-hospedarlo completo.
- **Multi-usuario con aislamiento duro.** Cada persona tiene su propio grafo, su propio
  usuario de base de datos y su propio proceso; nadie puede ver los datos de otro.

---

## 🌐 Instancia pública: `mybrain.rlz.cl`

Hay una instancia corriendo en **`https://mybrain.rlz.cl`**. Para usarla:

1. En **claude.ai** (o Claude Desktop / móvil) → **Ajustes → Conectores → Agregar
   conector personalizado**.
2. URL del conector: **`https://mybrain.rlz.cl/mcp`**
3. Se abre el login por OAuth; inicias sesión con tu cuenta y ya tienes tu second brain
   disponible en cualquier conversación.

> **Cuentas:** el registro es por invitación (`https://mybrain.rlz.cl/registro` con
> código). Si quieres una cuenta en la instancia pública, pídesela al administrador.
> ¿Prefieres control total? **Auto-hospeda** el proyecto (ver abajo) — está pensado para
> eso.

### Cómo se usa (una vez conectado)

**Guardar** — habla natural:
> "Guarda que mi cuenta corriente del Banco de Chile es la 123-456."
> "Recuerda que en la reunión de hoy decidimos usar Postgres en el proyecto X."

**Ingerir un documento** — adjúntalo en el chat y pide guardarlo:
> *(adjuntas un PDF)* "Ingesta este contrato a mi second brain."

Claude extrae el texto (incluso de PDFs escaneados e imágenes con su visión), lo
clasifica por dominio, detecta la fecha real del documento y lo guarda por secciones.

**Consultar**:
> "¿Cuál es mi cuenta bancaria?" · "¿Qué sé del proyecto X?"
> "¿Con quién tengo acuerdo de confidencialidad?" · "Dame el historial de mis cuentas."

**Buenas prácticas:** menciona **relaciones explícitas** y **fechas reales** al guardar;
nunca pegues contraseñas/tokens en crudo (el sistema los redacta, pero mejor evítalo).

---

## 🏗️ Arquitectura

```
  claude.ai (web/desktop/móvil)
        │  conector MCP remoto (OAuth 2.1)
        ▼
  nginx ── gateway/ (:8787) ──►  Graphiti MCP (:8021 por tenant)
   TLS     OAuth + routing         │ extracción + embeddings
           por usuario             ▼
                             FalkorDB (grafo temporal por tenant)
                                    ▲
                             LLM + embeddings (NVIDIA NIM / OpenAI / Ollama)
```

| Componente | Qué hace |
|---|---|
| `gateway/` | Gateway OAuth 2.1 (Better Auth). Autentica y enruta cada usuario a **su** MCP. Registro por invitación con aprovisionamiento de tenant. |
| `infra/` | FalkorDB + un servicio Graphiti MCP por tenant. Docker Compose **o** despliegue nativo por systemd (`infra/deploy/native/`). ACL de FalkorDB por tenant. |
| `ingest/` | Pipeline CLI opcional (`brain`) para ingesta masiva local: `scan → extract → classify → chunk → ingest-graph`, con ledger reanudable, OCR y redacción de secretos. |
| `.claude/skills/` | Skills `/guardar`, `/ingest`, `/consultar` para usar el brain desde Claude Code. |
| `SCHEMA.md` | Ontología: dominios, entidades, aristas, reglas de fecha y sensibilidad. |
| `docs/decisiones.md` | Registro de decisiones (ADR). |

**Modelo temporal (bi-temporal):** cada hecho guarda cuándo ocurrió (`valid_at`/`invalid_at`)
y cuándo se supo. Al cambiar un dato, el anterior se invalida —no se borra— así la
consulta da el estado vigente por defecto y la historia cuando la pides.

**Aislamiento entre usuarios:** grafo separado por tenant (el nombre del grafo es el
tenant) + usuario ACL propio en FalkorDB + proceso MCP propio + routing en el gateway.
Un filtro olvidado no puede filtrar datos de otra persona porque son procesos y grafos
distintos.

---

## 🔌 Ingesta remota vía MCP (sin SSH ni uploads)

La ingesta no requiere acceso al servidor. Cuando te conectas por el conector, el propio
servidor MCP le entrega a Claude las instrucciones de cómo ingerir: Claude **lee el
adjunto**, lo trocea, determina dominio y fecha real, redacta secretos y llama a la
herramienta `add_memory` una vez por sección. Todo ocurre a través del conector MCP,
desde tu dispositivo. También sirve la ingesta masiva local vía el CLI `brain`
(`ingest/`) si prefieres procesar carpetas enteras.

---

## 🚀 Auto-hospedaje

Requisitos: Docker (o un Linux para el modo nativo), y una API compatible con OpenAI
para extracción + embeddings (opciones baratas/gratis: **NVIDIA NIM**, **OpenAI
gpt-4o-mini/nano**, o **Ollama** local con un modelo no-razonador como `qwen2.5:7b-instruct`).
⚠️ **DeepSeek no sirve** para extracción (no soporta `response_format: json_schema`).

### Con Docker Compose (lo más simple)

```bash
git clone https://github.com/jpreyestCL/secondbrain && cd secondbrain
cp .env.example .env            # define tu proveedor LLM + embeddings
make up                          # FalkorDB + MCP del primer tenant
cd gateway && npm ci && npm run build
npm run create-owner -- tu@email.com 'tu-password'
npm start                        # gateway OAuth en :8787
```

Expón el gateway con TLS (nginx/Cloudflare/túnel) y agrega el conector
`https://tu-dominio/mcp` en claude.ai.

### Nativo por systemd (sin Docker)

Para servidores donde no quieres Docker (reutiliza nginx, redis aparte, etc.), ver
**`infra/deploy/native/README.md`**: FalkorDB nativo (redis 8 + módulo), MCP y gateway
por systemd, backup por timer.

### Agregar más personas

`make add-tenant NAME=maria PORT=9022`, crea su usuario en el gateway y mapea en
`tenants.json`; conecta su propio conector.

---

## ⚙️ Configuración

Todo por variables de entorno (`.env.example` documentado):

- **LLM de extracción** (`MODEL_NAME`, `OPENAI_API_KEY`, `OPENAI_API_URL`) — debe soportar
  `json_schema`.
- **Embeddings** (`EMBEDDER_MODEL`, `EMBEDDER_API_URL`, `EMBEDDER_DIMENSIONS`) — endpoint
  separado, para combinar (p.ej.) LLM en la nube + embeddings locales.
- **FalkorDB** — password admin obligatoria; cada tenant tiene su usuario ACL.

## Seguridad

- OAuth 2.1 con PKCE + registro dinámico de clientes; rate-limiting; headers de seguridad.
- Secretos nunca en el repo (`.env`, claves, ACLs y credenciales están en `.gitignore`).
- Redacción automática de contraseñas/tokens/tarjetas antes de escribir al grafo.
- Datos médicos/financieros se guardan con flag de sensibilidad.

## Licencia

Componentes de terceros bajo sus propias licencias (Graphiti: Apache-2.0; FalkorDB;
Better Auth). Este repositorio: uso personal.

---

*Construido sobre [Graphiti](https://github.com/getzep/graphiti), [FalkorDB](https://www.falkordb.com/)
y [Better Auth](https://www.better-auth.com/), operado con [Claude](https://claude.ai).*
