/**
 * Exportación completa del grafo de una persona (GET /export).
 *
 * Se hace SIEMPRE a través del MCP upstream del propio tenant, nunca contra la
 * base de datos del grafo: así el aislamiento multi-tenant sigue siendo el
 * mismo que aplica a Claude (cada proceso Graphiti solo ve su grafo, y el
 * gateway solo resuelve el upstream del usuario autenticado). Un bug aquí no
 * puede filtrar el grafo de otra persona porque nunca tuvo acceso a él.
 *
 * Herramientas usadas (ver infra/graphiti/patches/graphiti_mcp_server.py):
 *   - get_episodes(max_episodes)            -> episodios con su texto original
 *   - search_nodes(query, max_nodes)        -> entidades
 *   - search_memory_facts(query, max_facts, only_current=false)
 *                                           -> hechos con valid_at / invalid_at
 *
 * Limitación conocida y documentada: `search_nodes` / `search_memory_facts` son
 * búsquedas híbridas top-N, no un volcado. Con una consulta amplia y un tope
 * alto (EXPORT_MAX_NODES) devuelven prácticamente todo un grafo personal, pero
 * la fuente autoritativa e íntegra son los episodios: cada hecho fue derivado
 * de un episodio y todos los episodios se exportan.
 */

const PROTOCOL_VERSION = "2025-06-18";
/** Consulta amplia para arrastrar el máximo de nodos/hechos en la búsqueda híbrida. */
// La búsqueda es SEMÁNTICA: un comodín ("*") no devuelve nada (verificado en
// vivo: 0 nodos). Para exportar todo se lanzan varias consultas amplias —
// semillas genéricas + términos extraídos de los propios episodios— y se unen
// los resultados deduplicando por uuid.
const SEED_QUERIES = [
  "informacion",
  "persona nombre",
  "fecha lugar organizacion",
  "cuenta documento proyecto",
];
const MAX_DERIVED_QUERIES = 6;
const STOPWORDS = new Set([
  "para","como","este","esta","esto","desde","donde","cuando","porque","sobre",
  "entre","hasta","todo","toda","mientras","tiene","tengo","que","los","las",
  "del","con","por","una","uno","mi","mis","es","son","the","and","with",
]);

/** Palabras significativas de los episodios, para cubrir el grafo real. */
function derivedQueries(episodes: unknown[]): string[] {
  const freq = new Map<string, number>();
  for (const ep of episodes.slice(0, 200)) {
    const e = ep as { name?: unknown; content?: unknown };
    const text = `${String(e?.name ?? "")} ${String(e?.content ?? "")}`.toLowerCase();
    for (const w of text.split(/[^\p{L}\p{N}]+/u)) {
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DERIVED_QUERIES)
    .map(([w]) => w);
}

/** Une listas de resultados deduplicando por uuid. */
function unionByUuid(lists: unknown[][]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const list of lists) {
    for (const item of list) {
      const uuid = (item as { uuid?: unknown })?.uuid;
      const key = typeof uuid === "string" ? uuid : JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export interface GraphExport {
  exportedAt: string;
  user: { id: string; email: string };
  upstream: string;
  episodes: unknown[];
  entities: unknown[];
  facts: unknown[];
  /** Herramientas que fallaron o devolvieron algo inesperado (export parcial). */
  warnings: string[];
}

export interface ExportOptions {
  maxEpisodes?: number;
  maxNodes?: number;
  /** Inyectable para tests. */
  fetchImpl?: typeof fetch;
}

/** Cliente JSON-RPC mínimo para el transporte streamable-HTTP de MCP. */
export class McpHttpClient {
  private id = 0;
  private sessionId: string | null = null;
  constructor(
    private readonly url: string,
    private readonly doFetch: typeof fetch,
  ) {}

  private headers(): Headers {
    const h = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    });
    if (this.sessionId) h.set("mcp-session-id", this.sessionId);
    return h;
  }

  async initialize(): Promise<void> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: ++this.id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "secondbrain-gateway-export", version: "1" },
      },
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    await readRpcResult(res); // valida que el upstream contestó algo sensato
    // Notificación (sin id): el servidor responde 202 sin cuerpo.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const res = await this.post({
      jsonrpc: "2.0",
      id: ++this.id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = await readRpcResult(res);
    return unwrapToolResult(result);
  }

  private async post(payload: unknown): Promise<Response> {
    const res = await this.doFetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`upstream MCP respondió ${res.status}`);
    }
    return res;
  }
}

/** Lee una respuesta JSON o SSE y devuelve el `result` del JSON-RPC. */
async function readRpcResult(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text.trim()) return null;
  let message: unknown;
  if (contentType.includes("text/event-stream")) {
    const payloads = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    if (!payloads.length) return null;
    message = JSON.parse(payloads[payloads.length - 1]!);
  } else {
    message = JSON.parse(text);
  }
  const rpc = message as { result?: unknown; error?: { message?: string } };
  if (rpc?.error) throw new Error(rpc.error.message ?? "error JSON-RPC del upstream");
  return rpc?.result ?? null;
}

/**
 * Un `tools/call` de FastMCP devuelve `structuredContent` y/o `content:
 * [{type:"text", text}]`. Preferimos lo estructurado y, si no, parseamos el
 * texto como JSON.
 */
function unwrapToolResult(result: unknown): unknown {
  const r = result as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  } | null;
  if (!r) return null;
  if (r.structuredContent !== undefined && r.structuredContent !== null) {
    // FastMCP envuelve la salida de la tool en `structuredContent.result`
    // (verificado en vivo: {"structuredContent":{"result":{"episodes":[...]}}}).
    // Sin desenvolver, las listas quedaban siempre vacías.
    const sc = r.structuredContent as Record<string, unknown>;
    if (sc && typeof sc === "object" && !Array.isArray(sc) && "result" in sc) {
      return sc["result"];
    }
    return r.structuredContent;
  }
  const text = r.content?.find((c) => c?.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Saca la lista bajo `key` de lo que devolvió la herramienta. */
function pickList(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  const value = (payload as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value : [];
}

function errorOf(payload: unknown): string | null {
  const err = (payload as Record<string, unknown> | null)?.["error"];
  return typeof err === "string" ? err : null;
}

/**
 * Descarga el grafo completo del usuario desde SU MCP upstream. Nunca lanza por
 * un fallo parcial: lo anota en `warnings` para que el archivo descargado deje
 * claro que le falta una parte.
 */
export async function exportGraph(
  upstreamUrl: string,
  user: { id: string; email: string },
  opts: ExportOptions = {},
): Promise<GraphExport> {
  const maxEpisodes = opts.maxEpisodes ?? 1000;
  const maxNodes = opts.maxNodes ?? 500;
  const client = new McpHttpClient(upstreamUrl, opts.fetchImpl ?? fetch);
  const out: GraphExport = {
    exportedAt: new Date().toISOString(),
    user,
    upstream: upstreamUrl,
    episodes: [],
    entities: [],
    facts: [],
    warnings: [],
  };

  try {
    await client.initialize();
  } catch (err) {
    out.warnings.push(`No se pudo conectar con tu servidor de memoria: ${String(err)}`);
    return out;
  }

  const grab = async (
    label: string,
    tool: string,
    args: Record<string, unknown>,
    key: string,
  ): Promise<unknown[]> => {
    try {
      const payload = await client.callTool(tool, args);
      const err = errorOf(payload);
      if (err) {
        out.warnings.push(`${label}: ${err}`);
        return [];
      }
      return pickList(payload, key);
    } catch (err) {
      out.warnings.push(`${label}: ${String(err)}`);
      return [];
    }
  };

  out.episodes = await grab("episodios", "get_episodes", { max_episodes: maxEpisodes }, "episodes");
  const queries = [...SEED_QUERIES, ...derivedQueries(out.episodes)];
  const nodeLists: unknown[][] = [];
  for (const q of queries) {
    nodeLists.push(await grab("entidades", "search_nodes", { query: q, max_nodes: maxNodes }, "nodes"));
  }
  out.entities = unionByUuid(nodeLists).slice(0, maxNodes);
  const factLists: unknown[][] = [];
  for (const q of queries) {
    factLists.push(
      await grab(
        "hechos",
        "search_memory_facts",
        { query: q, max_facts: maxNodes, only_current: false },
        "facts",
      ),
    );
  }
  out.facts = unionByUuid(factLists).slice(0, maxNodes);

  return out;
}


// ---------------------------------------------------------------------------
// Resumen y búsqueda para el panel web
// ---------------------------------------------------------------------------

/** Resumen de lo guardado, en el vocabulario del usuario (no en el de Graphiti). */
export interface ResumenMemoria {
  documentos: number;
  fragmentos: number;
  personasYEmpresas: number;
  datosActuales: number;
  datosQueCambiaron: number;
  porDominio: Record<string, number>;
  ultimos: Array<{ documento: string; dominio: string; guardado: string }>;
}

function comoNumero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Pide el resumen al MCP del tenant.
 *
 * Devuelve null si el servidor no expone `get_stats` (versión anterior del
 * patch): el panel entonces omite la sección en vez de mostrar ceros, que se
 * leerían como "no tienes nada guardado" — exactamente el mensaje equivocado.
 */
export async function resumenMemoria(
  upstreamUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResumenMemoria | null> {
  const client = new McpHttpClient(upstreamUrl, fetchImpl);
  try {
    await client.initialize();
    const crudo = (await client.callTool("get_stats", {})) as Record<string, unknown> | null;
    if (!crudo || typeof crudo !== "object" || "error" in crudo) return null;
    const dominios = (crudo.por_dominio ?? {}) as Record<string, unknown>;
    const porDominio: Record<string, number> = {};
    for (const [k, v] of Object.entries(dominios)) porDominio[k] = comoNumero(v);
    return {
      documentos: comoNumero(crudo.documentos),
      fragmentos: comoNumero(crudo.fragmentos),
      personasYEmpresas: comoNumero(crudo.personas_y_empresas),
      datosActuales: comoNumero(crudo.datos_actuales),
      datosQueCambiaron: comoNumero(crudo.datos_que_cambiaron),
      porDominio,
      ultimos: Array.isArray(crudo.ultimos_documentos)
        ? (crudo.ultimos_documentos as ResumenMemoria["ultimos"])
        : [],
    };
  } catch {
    return null;
  }
}

/** Un dato encontrado, con su vigencia. */
export interface DatoEncontrado {
  texto: string;
  desde: string | null;
  hasta: string | null;
}

/** Busca datos en la memoria del usuario. Vacío si el upstream falla. */
export async function buscarDatos(
  upstreamUrl: string,
  consulta: string,
  fetchImpl: typeof fetch = fetch,
  maximo = 15,
): Promise<DatoEncontrado[]> {
  const client = new McpHttpClient(upstreamUrl, fetchImpl);
  try {
    await client.initialize();
    const crudo = (await client.callTool("search_memory_facts", {
      query: consulta,
      max_facts: maximo,
    })) as Record<string, unknown> | null;
    const lista = (crudo?.facts ?? crudo?.result ?? []) as Array<Record<string, unknown>>;
    return (Array.isArray(lista) ? lista : [])
      .map((f) => ({
        texto: String(f.fact ?? f.name ?? ""),
        desde: (f.valid_at as string) ?? null,
        hasta: (f.invalid_at as string) ?? null,
      }))
      .filter((f) => f.texto);
  } catch {
    return [];
  }
}
