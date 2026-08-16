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

import { traductor, type Idioma, type Textos } from "./i18n.js";

const PROTOCOL_VERSION = "2025-06-18";

/**
 * Lo único de este módulo que lee una persona: los avisos que viajan en
 * `warnings` dentro del archivo descargado. Los nombres de las herramientas MCP
 * (`get_episodes`, `search_nodes`, …) y las claves del JSON exportado
 * (`episodes`, `entities`, `facts`) son contrato con el servidor y NO se
 * traducen. Las etiquetas sí, y en el vocabulario del usuario.
 */
const T: Textos<"sinConexion" | "etqDocumentos" | "etqPersonas" | "etqDatos"> = {
  sinConexion: {
    es: "No se pudo conectar con tu servidor de memoria:",
    en: "Could not connect to your memory server:",
  },
  etqDocumentos: { es: "episodios", en: "documents" },
  etqPersonas: { es: "entidades", en: "people and companies" },
  etqDatos: { es: "hechos", en: "data" },
};
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
  /** Idioma de los avisos que viajan en el archivo descargado. */
  idioma?: Idioma;
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
      throw new Error(`the memory server replied ${res.status}`);
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
  if (rpc?.error) throw new Error(rpc.error.message ?? "JSON-RPC error from the memory server");
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
  const t = traductor(T, opts.idioma ?? "es");
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
    out.warnings.push(`${t("sinConexion")} ${String(err)}`);
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

  out.episodes = await grab(
    t("etqDocumentos"),
    "get_episodes",
    { max_episodes: maxEpisodes },
    "episodes",
  );
  const queries = [...SEED_QUERIES, ...derivedQueries(out.episodes)];
  const nodeLists: unknown[][] = [];
  for (const q of queries) {
    nodeLists.push(
      await grab(t("etqPersonas"), "search_nodes", { query: q, max_nodes: maxNodes }, "nodes"),
    );
  }
  out.entities = unionByUuid(nodeLists).slice(0, maxNodes);
  const factLists: unknown[][] = [];
  for (const q of queries) {
    factLists.push(
      await grab(
        t("etqDatos"),
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
// Panel web: resumen, búsqueda y constelación
//
// Todo pasa por UNA sola sesión MCP. Cada consulta abría antes su propio
// cliente con su propio `initialize`, así que pintar /cuenta con una búsqueda
// costaba tres handshakes y tres llamadas contra un servidor que ya va justo
// de recursos — y el usuario lo notaba como varios segundos de nada.
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

/** Un dato encontrado, con su vigencia. */
export interface DatoEncontrado {
  texto: string;
  desde: string | null;
  hasta: string | null;
}

/** Una persona, empresa o lugar encontrado en la memoria. */
export interface EntidadEncontrada {
  nombre: string;
  uuid: string;
  resumen: string;
}

export interface Relacion {
  con: string;
  uuid: string;
  dato: string;
  desde: string;
  hasta: string;
}

export interface Vecindario {
  entidad: string;
  uuid: string;
  relaciones: Relacion[];
}

export interface PanelMemoria {
  resumen: ResumenMemoria | null;
  datos: DatoEncontrado[];
  entidades: EntidadEncontrada[];
  constelacion: Vecindario | null;
}

function comoNumero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Saca la lista de una respuesta MCP, venga suelta o envuelta en `result`. */
function comoLista(crudo: unknown, ...claves: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(crudo)) return crudo as Array<Record<string, unknown>>;
  if (!crudo || typeof crudo !== "object") return [];
  const obj = crudo as Record<string, unknown>;
  for (const clave of [...claves, "result"]) {
    const v = obj[clave];
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    if (v && typeof v === "object") {
      const anidado = comoLista(v, ...claves);
      if (anidado.length) return anidado;
    }
  }
  return [];
}

async function leerResumen(client: McpHttpClient): Promise<ResumenMemoria | null> {
  const crudo = (await client.callTool("get_stats", {})) as Record<string, unknown> | null;
  // Una respuesta con forma inesperada NO es una memoria vacía: devolver ceros
  // se leería como "no tienes nada guardado", que es el mensaje equivocado.
  if (!crudo || typeof crudo !== "object" || typeof crudo.documentos !== "number") {
    return null;
  }
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
}

async function leerDatos(
  client: McpHttpClient,
  consulta: string,
  maximo = 15,
): Promise<DatoEncontrado[]> {
  const crudo = await client.callTool("search_memory_facts", {
    query: consulta,
    max_facts: maximo,
  });
  return comoLista(crudo, "facts")
    .map((f) => ({
      texto: String(f.fact ?? f.name ?? ""),
      desde: (f.valid_at as string) ?? null,
      hasta: (f.invalid_at as string) ?? null,
    }))
    .filter((f) => f.texto);
}

async function leerEntidades(
  client: McpHttpClient,
  consulta: string,
  maximo = 8,
): Promise<EntidadEncontrada[]> {
  const crudo = await client.callTool("search_nodes", {
    query: consulta,
    max_nodes: maximo,
  });
  return comoLista(crudo, "nodes")
    .map((n) => ({
      nombre: String(n.name ?? ""),
      uuid: String(n.uuid ?? ""),
      resumen: String(n.summary ?? ""),
    }))
    .filter((n) => n.nombre && n.uuid);
}

async function leerVecindario(client: McpHttpClient, uuid: string): Promise<Vecindario | null> {
  const crudo = (await client.callTool("get_neighbors", { uuid })) as Record<
    string,
    unknown
  > | null;
  if (!crudo || typeof crudo !== "object" || "error" in crudo) return null;
  const rels = comoLista(crudo, "relaciones");
  return {
    entidad: String(crudo.entidad ?? ""),
    uuid: String(crudo.uuid ?? uuid),
    relaciones: rels.map((r) => ({
      con: String(r.con ?? ""),
      uuid: String(r.uuid ?? ""),
      dato: String(r.dato ?? ""),
      desde: String(r.desde ?? ""),
      hasta: String(r.hasta ?? ""),
    })),
  };
}

/**
 * Todo lo que el panel necesita, en una sola sesión MCP.
 *
 * Cada consulta se aísla: si la búsqueda falla, el resumen igual se pinta. Los
 * fallos se registran — tragárselos en silencio hace que un upstream caído se
 * vea igual que "este servidor no soporta la función", que es el patrón de
 * fallo silencioso que ya costó caro en este proyecto.
 */
export async function panelMemoria(
  upstreamUrl: string,
  opciones: { consulta?: string; entidad?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<PanelMemoria> {
  const vacio: PanelMemoria = { resumen: null, datos: [], entidades: [], constelacion: null };
  const client = new McpHttpClient(upstreamUrl, fetchImpl);
  try {
    await client.initialize();
  } catch (e) {
    console.warn(`[panel] no se pudo abrir la sesión MCP: ${String(e)}`);
    return vacio;
  }

  async function seguro<T>(etiqueta: string, porDefecto: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      console.warn(`[panel] falló ${etiqueta}: ${String(e)}`);
      return porDefecto;
    }
  }

  const { consulta, entidad } = opciones;
  const [resumen, datos, entidades, constelacion] = await Promise.all([
    seguro<ResumenMemoria | null>("el resumen", null, () => leerResumen(client)),
    consulta
      ? seguro<DatoEncontrado[]>("la búsqueda de datos", [], () => leerDatos(client, consulta))
      : Promise.resolve<DatoEncontrado[]>([]),
    consulta
      ? seguro<EntidadEncontrada[]>("la búsqueda de entidades", [], () =>
          leerEntidades(client, consulta),
        )
      : Promise.resolve<EntidadEncontrada[]>([]),
    entidad
      ? seguro<Vecindario | null>("la constelación", null, () => leerVecindario(client, entidad))
      : Promise.resolve<Vecindario | null>(null),
  ]);
  return { resumen, datos, entidades, constelacion };
}

/** Solo el resumen (una sesión propia). Útil fuera del panel y en tests. */
export async function resumenMemoria(
  upstreamUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResumenMemoria | null> {
  return (await panelMemoria(upstreamUrl, {}, fetchImpl)).resumen;
}
