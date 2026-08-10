/**
 * Guía de uso (/guia), en español y con el mismo lenguaje visual que /cuenta,
 * /login y /consentimiento.
 *
 * Documenta las dos formas de meter información al cerebro: hablando con Claude
 * por el conector MCP (el camino de todos los días) y la ingesta masiva de una
 * carpeta con el CLI `brain` (el camino para quien tiene terminal). Todo lo que
 * aparece aquí está verificado contra el servidor real.
 */
import { escapeHtml } from "./html.js";

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

const ENV_BLOCK = `ssh -f -N -L 16380:127.0.0.1:6380 usuario@servidor

export FALKORDB_HOST=127.0.0.1 FALKORDB_PORT=16380
export FALKORDB_TENANT_USER=tenant_<slug> FALKORDB_TENANT_PASSWORD=<password del tenant>
export OPENAI_API_KEY=<key> OPENAI_API_URL=https://integrate.api.nvidia.com/v1 MODEL_NAME=meta/llama-3.1-8b-instruct
export EMBEDDER_API_URL=https://integrate.api.nvidia.com/v1 EMBEDDER_MODEL=nvidia/nv-embed-v1 EMBEDDER_DIMENSIONS=4096`;

const PIPELINE_BLOCK = `brain --tenant <slug> scan ~/Documentos/inbox
brain --tenant <slug> extract
brain --tenant <slug> classify            # emite el manifiesto JSON
# Claude completa el manifiesto: dominio, tipo y fecha REAL de cada documento
brain --tenant <slug> classify --apply manifiesto.json
brain --tenant <slug> chunk
brain --tenant <slug> ingest-graph`;

export function guiaPageHtml(): string {
  const toolRows = TOOLS.map(
    (t) => `      <tr>
        <td><code>${escapeHtml(t.name)}</code></td>
        <td>${escapeHtml(t.what)}</td>
        <td class="params"><code>${escapeHtml(t.params)}</code></td>
      </tr>`,
  ).join("\n");

  const cliRows = CLI_COMMANDS.map(
    ([cmd, what]) => `      <tr>
        <td><code>${escapeHtml(cmd)}</code></td>
        <td>${escapeHtml(what)}</td>
      </tr>`,
  ).join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Second Brain — Guía de uso</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f5f5f4; padding: 2rem 1rem; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } }
  main { width: min(94vw, 48rem); margin-inline: auto; display: grid; gap: 1.2rem; }
  section { background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; padding: 1.5rem; display: grid; gap: .8rem; }
  h1 { font-size: 1.3rem; margin: 0; }
  h2 { font-size: 1rem; margin: 0; }
  h3 { font-size: .92rem; margin: .4rem 0 0; }
  p { margin: 0; }
  ul, ol { margin: 0; padding-left: 1.2rem; display: grid; gap: .35rem; font-size: .92rem; }
  .muted { font-size: .85rem; opacity: .7; }
  .notice { border-left: 3px solid #4f46e5; padding: .5rem .7rem; background: color-mix(in srgb, #4f46e5 12%, transparent); border-radius: 4px; font-size: .9rem; }
  .warn { border-left: 3px solid #b91c1c; padding: .6rem .8rem; background: color-mix(in srgb, #b91c1c 12%, transparent); border-radius: 4px; font-size: .9rem; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); vertical-align: top; }
  td.params { opacity: .75; overflow-wrap: anywhere; }
  .tag { font-size: .7rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 999px; padding: 0 .4rem; }
  a.btn { display: inline-block; font-weight: 600; padding: .5rem .9rem; border-radius: 8px; background: #4f46e5; color: #fff; text-decoration: none; }
  .scroll { overflow-x: auto; }
  pre { margin: 0; overflow-x: auto; background: color-mix(in srgb, CanvasText 7%, transparent); border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: .8rem .9rem; font-size: .8rem; line-height: 1.5; }
  pre code { font-size: inherit; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; overflow-wrap: anywhere; }
  .quote { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: .55rem .7rem; }
  .toc { display: flex; flex-wrap: wrap; gap: .4rem .9rem; font-size: .88rem; }
  a { color: #4f46e5; }
  :target { scroll-margin-top: 1rem; }
</style>
</head>
<body>
<main>
  <section>
    <h1>Guía de uso</h1>
    <p class="muted">Cómo guardar, consultar e ingerir información en tu second brain.
      Todo lo de esta página está verificado contra el servidor real.</p>
    <nav class="toc">
      <a href="#conversar">1. Conversar con el cerebro</a>
      <a href="#herramientas">2. Las 9 herramientas MCP</a>
      <a href="#masiva">3. Ingesta masiva de una carpeta</a>
      <a href="#accesos">4. Exportar y cerrar accesos</a>
    </nav>
    <p class="muted"><a href="/cuenta">← Tu cuenta</a> · <a href="/">Inicio</a></p>
  </section>

  <section id="conversar">
    <h2>1. Conversar con el cerebro</h2>
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
    <h2>2. Las 9 herramientas MCP</h2>
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
    <h2>3. Ingesta masiva de una carpeta (CLI <code>brain</code>)</h2>
    <p class="muted">Para cuando tienes cientos de documentos en el disco y adjuntarlos de
      a uno en el chat no tiene sentido. Requiere terminal.</p>

    <h3>El pipeline</h3>
    <p class="muted">Los pasos van en orden y cada uno deja su resultado en el ledger, así
      que puedes cortar y retomar donde ibas.</p>
    <pre><code>${escapeHtml(PIPELINE_BLOCK)}</code></pre>

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

    <h3>Ingerir contra este servidor</h3>
    <p class="muted">El CLI habla directo con FalkorDB, así que necesitas un túnel SSH y las
      variables de entorno apuntando a él:</p>
    <pre><code>${escapeHtml(ENV_BLOCK)}</code></pre>

    <p class="warn">⚠️ El modelo de embeddings y sus dimensiones DEBEN coincidir con los del
      servidor (<code>nvidia/nv-embed-v1</code>, <code>4096</code>). Si ingieres con otro
      modelo u otra dimensión, la búsqueda semántica del grafo se corrompe.</p>

    <p class="notice"><strong>Alternativa sin terminal:</strong> adjunta los documentos en
      Claude de a poco. La ingesta por MCP no requiere SSH ni variables de entorno.</p>
  </section>

  <section id="accesos">
    <h2>4. Exportar y cerrar accesos</h2>
    <p class="muted">Tu memoria es tuya y sale entera cuando quieras: un JSON con los
      episodios (texto original), las entidades y los hechos con su vigencia.</p>
    <p><a class="btn" href="/export">Descargar mi memoria (JSON)</a></p>
    <p class="muted">En <a href="/cuenta">tu cuenta</a> puedes revisar las sesiones abiertas,
      cerrarlas todas de golpe y revocar cualquier aplicación OAuth que hayas autorizado.</p>
  </section>
</main>
</body>
</html>`;
}
