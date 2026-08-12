/**
 * Guía de uso (/guia). Solo produce el CONTENIDO; el `<head>`, el CSS y la
 * barra de navegación vienen del shell compartido (dashboard-layout.ts), el
 * mismo que envuelve /cuenta.
 *
 * La página es PÚBLICA: sin sesión la barra ofrece «Iniciar sesión» en vez del
 * correo y el botón de cerrar sesión, pero el contenido es el mismo (todo está
 * en el repo público y los comandos usan marcadores, no secretos).
 *
 * Documenta las dos formas de meter información al cerebro: hablando con Claude
 * por el conector MCP (el camino de todos los días) y la ingesta masiva de una
 * carpeta con el CLI `brain` (el camino para quien tiene terminal). Todo lo que
 * aparece aquí está verificado contra el servidor real.
 */
import { escapeHtml } from "./html.js";
import { dashboardShell, type DashboardSessionView } from "./dashboard-layout.js";

interface Tool {
  name: string;
  what: string;
  params: string;
}

/** Las 9 herramientas que expone el servidor MCP. */
const TOOLS: Tool[] = [
  {
    name: "add_memory",
    what: "Guarda un episodio (texto, hecho o sección de documento) en tu grafo.",
    params:
      "name, episode_body, source, source_description, group_id, uuid, reference_time",
  },
  {
    name: "search_memory_facts",
    what: "Busca hechos (relaciones entre entidades) por semántica.",
    params: "query, group_ids, max_facts, center_node_uuid, only_current",
  },
  {
    name: "search_nodes",
    what: "Busca entidades (personas, cuentas, empresas, documentos…).",
    params: "query, max_nodes, entity_types",
  },
  {
    name: "get_episodes",
    what: "Lista los episodios más recientes, con su texto original.",
    params: "max_episodes, group_ids",
  },
  {
    name: "get_entity_edge",
    what: "Devuelve un hecho concreto por su UUID, con su vigencia.",
    params: "uuid",
  },
  {
    name: "delete_entity_edge",
    what: "Borra un hecho concreto (por ejemplo, uno mal extraído).",
    params: "uuid",
  },
  {
    name: "delete_episode",
    what: "Borra un episodio completo y lo que derivó de él.",
    params: "uuid",
  },
  {
    name: "clear_graph",
    what: "Vacía el grafo entero. DESTRUCTIVO: no hay deshacer.",
    params: "group_ids",
  },
  {
    name: "get_status",
    what: "Comprueba que el servidor y la base de datos responden.",
    params: "—",
  },
];

const CLI_COMMANDS: Array<[string, string]> = [
  ["scan <carpeta>", "Recorre la carpeta y registra cada archivo en el ledger."],
  ["extract", "Saca el texto de cada archivo (OCR incluido si hace falta)."],
  ["classify", "Emite un manifiesto JSON con un registro por documento."],
  ["classify --apply <archivo>", "Aplica el manifiesto ya completado al ledger."],
  ["chunk", "Trocea cada documento en secciones del tamaño que el grafo digiere."],
  ["ingest-graph", "Envía las secciones al grafo (flags --doc-id y --force)."],
  ["status", "Muestra en qué etapa va cada documento."],
  ["expire", "Marca documentos como caducados (--all para todos)."],
  ["version", "Imprime la versión del CLI."],
];

const INSTALL_BLOCK = `# 1) uv (gestor de Python)
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2) el repo
git clone https://github.com/jpreyestCL/secondbrain
cd secondbrain/ingest

# 3) dependencias (--all-extras trae el OCR de macOS Vision)
uv sync --all-extras
uv run brain --help`;



const ENV_BLOCK = `# El puerto local NO puede ser 6379 si tienes Docker corriendo:
# ese puerto ya lo publica el FalkorDB local y escribirias en el grafo equivocado.
ssh -f -N -L 16380:127.0.0.1:6380 usuario@servidor

export FALKORDB_HOST=127.0.0.1 FALKORDB_PORT=16380
export FALKORDB_TENANT_USER=tenant_<slug> FALKORDB_TENANT_PASSWORD=<password del tenant>

# Chat y embeddings llevan claves y URLs SEPARADAS.
export LLM_MODEL=gpt-4o-mini LLM_API_URL=https://api.openai.com/v1 LLM_API_KEY=<key>
export EMBEDDER_API_KEY=<key nvidia> EMBEDDER_API_URL=https://integrate.api.nvidia.com/v1
export EMBEDDER_MODEL=nvidia/nv-embed-v1 EMBEDDER_DIMENSIONS=4096`;

const PIPELINE_BLOCK = `brain --tenant <slug> scan ~/Documentos/inbox
brain --tenant <slug> extract
brain --tenant <slug> classify            # emite el manifiesto JSON
# Claude completa el manifiesto: dominio, tipo y fecha REAL de cada documento
brain --tenant <slug> classify --apply manifiesto.json
brain --tenant <slug> chunk

# Ultimo paso: el unico que habla con el servidor
brain --tenant <slug> ingest-graph --via mcp --url <MCP_URL>`;

const REMOTO_BLOCK = `brain --tenant <slug> ingest-graph --via mcp --url <MCP_URL>`;

/**
 * Rellena los ejemplos con los datos de quien mira la pagina.
 *
 * Un ejemplo con `<slug>` obliga a cada usuario a averiguar cual es el suyo, y
 * ese fue justamente el tropiezo que motivo este cambio: la guia decia que
 * comandos correr sin decir con que valores. Con sesion iniciada se sustituye
 * por el tenant real, listo para copiar y pegar.
 */
function personalizar(bloque: string, tenant: string | null, mcpUrl: string): string {
  return bloque
    .replaceAll("<MCP_URL>", mcpUrl)
    .replaceAll("<slug>", tenant ?? "<slug>");
}

export interface GuiaPageOptions {
  /** URL pública del gateway; se usa para mostrar la dirección del conector. */
  baseUrl?: string;
  /** Sesión del navegador, o null si se está viendo sin iniciar sesión. */
  session?: DashboardSessionView | null;
  /** Slug del tenant de quien mira; con él los ejemplos salen listos para usar. */
  tenant?: string | null;
}

export function guiaPageHtml(opts: GuiaPageOptions = {}): string {
  const mcpUrl = (opts.baseUrl ?? "https://mybrain.rlz.cl").replace(/\/$/, "") + "/mcp";
  const toolRows = TOOLS.map(
    (t) => `      <tr>
        <td><code>${escapeHtml(t.name)}</code></td>
        <td>${escapeHtml(t.what)}</td>
        <td class="params"><code>${escapeHtml(t.params)}</code></td>
      </tr>`,
  ).join("\n");

  const tenant = opts.tenant ?? null;
  const pipeline = personalizar(PIPELINE_BLOCK, tenant, mcpUrl);
  const remoto = personalizar(REMOTO_BLOCK, tenant, mcpUrl);
  const entorno = personalizar(ENV_BLOCK, tenant, mcpUrl);
  const avisoTenant = tenant
    ? `<p class="notice">Los ejemplos ya vienen con tu espacio
        (<code>${escapeHtml(tenant)}</code>): puedes copiarlos y pegarlos tal cual.</p>`
    : `<p class="muted">Sustituye <code>&lt;slug&gt;</code> por el nombre de tu espacio.
        <a href="/cuenta">Inicia sesión</a> y los ejemplos saldrán ya rellenados.</p>`;

  const cliRows = CLI_COMMANDS.map(
    ([cmd, what]) => `      <tr>
        <td><code>${escapeHtml(cmd)}</code></td>
        <td>${escapeHtml(what)}</td>
      </tr>`,
  ).join("\n");

  const body = `  <section>
    <h1>Guía de uso</h1>
    <p class="muted">Cómo guardar, consultar e ingerir información en tu second brain.
      Todo lo de esta página está verificado contra el servidor real.</p>
    <nav class="toc">
      <a href="#conectar">1. Conectar tu Claude</a>
      <a href="#conversar">2. Conversar con el cerebro</a>
      <a href="#herramientas">3. Las 9 herramientas MCP</a>
      <a href="#masiva">4. Ingesta masiva de una carpeta</a>
      <a href="#accesos">5. Exportar y cerrar accesos</a>
    </nav>
  </section>

  <section id="conectar">
    <h2>1. Conectar tu Claude</h2>
    <p>Se hace una sola vez. Después tu memoria está disponible en cualquier
      conversación, en web, escritorio y teléfono.</p>
    <ol>
      <li>Abre <strong>claude.ai</strong> (o Claude Desktop) y ve a
        <strong>Ajustes → Conectores</strong>.</li>
      <li>Elige <strong>Agregar conector personalizado</strong>.</li>
      <li>Pega esta dirección:
        <pre><code>${escapeHtml(mcpUrl)}</code></pre></li>
      <li>Se abrirá una ventana para <strong>iniciar sesión</strong>: con tu correo y
        contraseña, o con <strong>Continuar con Google</strong>.</li>
      <li>Verás una pantalla de <strong>autorización</strong> que indica qué permiso
        estás dando (leer y escribir toda tu memoria). Pulsa <strong>Autorizar</strong>.
        Solo se pregunta la primera vez para cada conector.</li>
      <li>Listo. Compruébalo escribiéndole a Claude:
        <em>«¿qué tienes guardado sobre mí?»</em></li>
    </ol>

    <h3>Si algo falla</h3>
    <table>
      <thead><tr><th>Lo que ves</th><th>Qué significa y qué hacer</th></tr></thead>
      <tbody>
        <tr>
          <td><code>invalid_client</code></td>
          <td>El conector guarda un identificador que ya no existe en el servidor
            (por ejemplo, si se limpiaron los accesos). <strong>Elimina el conector
            en claude.ai y vuelve a agregarlo</strong>: se registra de nuevo solo.</td>
        </tr>
        <tr>
          <td><code>account_not_linked</code></td>
          <td>Intentaste entrar con Google usando un correo que ya tenía cuenta con
            contraseña, y ese correo aún no está verificado. Revisa tu bandeja y
            confirma el correo; si no te llegó, reenvíalo desde
            <a href="/cuenta">tu cuenta</a>.</td>
        </tr>
        <tr>
          <td>Te devuelve al login una y otra vez</td>
          <td>La sesión caducó (duran 2 días). Vuelve a iniciar sesión; el conector
            sigue registrado.</td>
        </tr>
        <tr>
          <td><code>403</code> al usar una herramienta</td>
          <td>Tu cuenta existe pero no tiene memoria asignada. Escríbele al
            administrador: hay que aprovisionar tu espacio.</td>
        </tr>
      </tbody>
    </table>

    <p class="muted">Para revocar el acceso de un conector en cualquier momento, entra a
      <a href="/cuenta">tu cuenta</a> y pulsa <em>Revocar</em> junto a la aplicación.</p>
  </section>

  <section id="conversar">
    <h2>2. Conversar con el cerebro</h2>
    <p class="muted">Es el camino de todos los días y no necesita terminal: basta con
      tener el conector MCP agregado en Claude.</p>

    <h3>Guardar un dato</h3>
    <p class="muted">Díselo en lenguaje natural. Claude decide el ámbito y llama a la
      herramienta por ti.</p>
    <div class="quote">Guarda que mi cuenta del Banco X es Y</div>
    <ul>
      <li><strong>Menciona las relaciones explícitamente</strong>: “la cuenta <em>del Banco X</em>
        es <em>mía</em>”, “el contrato es <em>con</em> tal empresa”. El grafo extrae lo que
        dices, no lo que se sobreentiende.</li>
      <li><strong>Menciona la fecha real del hecho</strong>, no la de hoy: “desde marzo de
        2024”. Esa fecha viaja en <code>reference_time</code> y es la que define desde
        cuándo el hecho está vigente.</li>
    </ul>

    <h3>Ingerir un documento</h3>
    <p class="muted">Adjunta el archivo en el chat y pide que lo ingiera. Claude lo lee
      —incluso PDFs escaneados o imágenes, usando visión—, lo trocea y lo guarda por
      secciones.</p>
    <div class="quote">Ingiere este contrato a mi second brain <em>(adjunto)</em></div>

    <h3>Consultar</h3>
    <p class="muted">Por defecto te responde con el <strong>estado actual</strong>. Si quieres
      la <strong>historia</strong>, pídela: el hecho anterior no se borró, quedó cerrado con
      su periodo de vigencia.</p>
    <div class="quote">¿Cuál es mi cuenta bancaria?</div>
    <div class="quote">Dame el historial completo de mis cuentas bancarias</div>

    <p class="warn">Nunca pegues contraseñas ni tokens en el chat. El servidor los redacta
      igual antes de escribir nada, pero lo mejor es que no salgan de tu gestor de claves.</p>
  </section>

  <section id="herramientas">
    <h2>3. Las 9 herramientas MCP</h2>
    <p class="muted">No necesitas llamarlas a mano: Claude las usa por ti. Están aquí para
      que sepas exactamente qué puede hacer el conector con tu memoria.</p>
    <div class="scroll"><table>
      <thead><tr><th>Herramienta</th><th>Qué hace</th><th>Parámetros</th></tr></thead>
      <tbody>
${toolRows}
      </tbody>
    </table></div>

    <ul>
      <li><code>reference_time</code> es ISO-8601 y es la <strong>fecha real del hecho</strong>.
        El servidor valida que caiga entre 1900 y como máximo un año en el futuro.</li>
      <li><code>only_current</code> viene en <code>true</code> por defecto: devuelve solo los
        hechos vigentes. Ponlo en <code>false</code> para incluir los invalidados y ver la
        historia completa.</li>
      <li><code>clear_graph</code> es destructivo y no tiene deshacer. Exporta antes desde
        <a href="/export">/export</a> si tienes cualquier duda.</li>
    </ul>

    <p class="notice"><strong>Aislamiento:</strong> el servidor fuerza el <code>group_id</code>
      de tu usuario en cada llamada y comprueba la pertenencia de cada UUID antes de
      tocarlo. No es posible leer ni modificar el grafo de otra persona, ni siquiera
      pasando un <code>group_id</code> ajeno a mano.</p>
  </section>

  <section id="masiva">
    <h2>4. Ingesta masiva de una carpeta (CLI <code>brain</code>)</h2>
    <p class="muted">Para cuando tienes cientos de documentos en el disco y adjuntarlos de
      a uno en el chat no tiene sentido. Requiere terminal.</p>

    <h3>Instalar el CLI</h3>
    <p class="muted">No se descarga aparte: vive en el repo del proyecto, en
      <code>ingest/</code>.</p>
    <pre><code>${escapeHtml(INSTALL_BLOCK)}</code></pre>

    <h3>El pipeline</h3>
    ${avisoTenant}
    <p class="muted">Los pasos van en orden y cada uno deja su resultado en el ledger, así
      que puedes cortar y retomar donde ibas.</p>
    <pre><code>${escapeHtml(pipeline)}</code></pre>

    <h3>Comandos</h3>
    <div class="scroll"><table>
      <thead><tr><th>Comando</th><th>Qué hace</th></tr></thead>
      <tbody>
${cliRows}
      </tbody>
    </table></div>
    <p class="muted">Flag global: <code>--tenant &lt;slug&gt;</code> elige sobre qué espacio
      trabajar.</p>

    <ul>
      <li><strong>Ledger reanudable</strong> en <code>~/.brain/&lt;tenant&gt;/</code>: si algo
        falla, vuelves a lanzar el comando y sigue desde donde quedó.</li>
      <li><strong>OCR</strong> de imágenes y de PDFs escaneados en el paso <code>extract</code>.</li>
      <li><strong>Redacción de credenciales</strong>: claves, tokens y números de tarjeta se
        reemplazan antes de escribir nada en el grafo.</li>
      <li><strong>Tus originales no se tocan</strong>: el pipeline solo lee de la carpeta.</li>
    </ul>

    <h3>Ingerir contra este servidor (sin SSH)</h3>
    <p class="muted">Esta es la forma recomendada y la única disponible si no administras el
      servidor. El último paso del pipeline se hace por el mismo conector MCP que usa Claude:
      te autenticas con tu cuenta, el gateway te enruta a tu espacio y el servidor hace la
      extracción con su propio modelo.</p>
    <pre><code>${escapeHtml(remoto)}</code></pre>
    <p class="muted">La primera vez se abre el navegador para autorizar; el token queda
      guardado en <code>~/.brain/&lt;tenant&gt;/</code> y las siguientes no preguntan.
      Los pasos anteriores (<code>scan</code>, <code>extract</code>, <code>classify</code>,
      <code>chunk</code>) son locales y no necesitan nada de esto.</p>

    <h3>Ingerir escribiendo directo a FalkorDB (requiere ser administrador)</h3>
    <p class="muted">Más rápido para lotes muy grandes, porque evita la latencia del MCP,
      pero FalkorDB solo escucha en el localhost del servidor: hace falta un túnel SSH y
      configurar los modelos a mano.</p>
    <pre><code>${escapeHtml(entorno)}</code></pre>

    <p class="warn">⚠️ El modelo de embeddings y sus dimensiones DEBEN coincidir con los del
      servidor (<code>nvidia/nv-embed-v1</code>, <code>4096</code>). Si ingieres con otro
      modelo u otra dimensión, la búsqueda semántica del grafo se corrompe. Por eso la vía
      MCP es más segura: ahí los modelos los pone el servidor y no hay nada que igualar.</p>

    <p class="notice"><strong>Sin terminal:</strong> adjunta los documentos en Claude y pídele
      que los guarde. No requiere instalar nada.</p>
  </section>

  <section id="accesos">
    <h2>5. Exportar y cerrar accesos</h2>
    <p class="muted">Tu memoria es tuya y sale entera cuando quieras: un JSON con los
      episodios (texto original), las entidades y los hechos con su vigencia.</p>
    <p><a class="btn" href="/export">Descargar mi memoria (JSON)</a></p>
    <p class="muted">En <a href="/cuenta">tu cuenta</a> puedes revisar las sesiones abiertas,
      cerrarlas todas de golpe y revocar cualquier aplicación OAuth que hayas autorizado.</p>
  </section>`;

  return dashboardShell({
    title: "Guía de uso",
    active: "guia",
    session: opts.session ?? null,
    body,
  });
}
