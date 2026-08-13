/** panelMemoria: una sola sesión MCP, y aislamiento entre consultas. */
import { describe, it, expect, vi } from "vitest";

import { panelMemoria } from "../src/export.js";

/** Servidor MCP falso: cuenta los `initialize` y responde por herramienta. */
function servidorFalso(
  respuestas: Record<string, unknown>,
  fallan: string[] = [],
): { fetch: typeof fetch; handshakes: () => number; llamadas: () => string[] } {
  let handshakes = 0;
  const llamadas: string[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.method === "initialize") {
      handshakes += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "s1" },
      });
    }
    if (body.method !== "tools/call") {
      return new Response("", { status: 202 });
    }
    const nombre = body.params.name as string;
    llamadas.push(nombre);
    if (fallan.includes(nombre)) {
      return new Response("boom", { status: 500 });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: { result: respuestas[nombre] ?? {} } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetch: f, handshakes: () => handshakes, llamadas: () => llamadas };
}

const RESPUESTAS = {
  get_stats: {
    documentos: 17,
    fragmentos: 47,
    personas_y_empresas: 124,
    datos_actuales: 137,
    datos_que_cambiaron: 3,
    por_dominio: { finanzas: 12 },
    ultimos_documentos: [{ documento: "Escritura.pdf", dominio: "finanzas", guardado: "2026-08-13" }],
  },
  search_memory_facts: { facts: [{ fact: "Linets posee el 99,9%", valid_at: "2022-10-31" }] },
  search_nodes: { nodes: [{ name: "Invest Andes LP", uuid: "u-1", summary: "sociedad" }] },
  get_neighbors: { entidad: "Invest Andes LP", uuid: "u-1", relaciones: [] },
};

describe("panelMemoria", () => {
  it("abre UNA sola sesión para las cuatro consultas", async () => {
    const s = servidorFalso(RESPUESTAS);
    const panel = await panelMemoria(
      "http://x/mcp",
      { consulta: "socios", entidad: "u-1" },
      s.fetch,
    );

    // Antes cada helper hacia su propio initialize: 3 handshakes para pintar
    // la pagina, contra un servidor que ya va justo.
    expect(s.handshakes()).toBe(1);
    expect(s.llamadas().sort()).toEqual([
      "get_neighbors",
      "get_stats",
      "search_memory_facts",
      "search_nodes",
    ]);
    expect(panel.resumen?.documentos).toBe(17);
    expect(panel.datos[0].texto).toContain("99,9%");
    expect(panel.entidades[0].nombre).toBe("Invest Andes LP");
    expect(panel.constelacion?.entidad).toBe("Invest Andes LP");
  });

  it("sin búsqueda solo pide el resumen", async () => {
    const s = servidorFalso(RESPUESTAS);
    await panelMemoria("http://x/mcp", {}, s.fetch);
    expect(s.llamadas()).toEqual(["get_stats"]);
  });

  it("un fallo aísla: si la búsqueda revienta, el resumen igual se pinta", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = servidorFalso(RESPUESTAS, ["search_memory_facts"]);
    const panel = await panelMemoria("http://x/mcp", { consulta: "socios" }, s.fetch);

    expect(panel.resumen?.documentos).toBe(17);
    expect(panel.datos).toEqual([]);
    expect(panel.entidades).toHaveLength(1);
    // Y se registra: tragarselo hace que un upstream caido se vea igual que
    // "este servidor no soporta la funcion".
    expect(aviso).toHaveBeenCalled();
    aviso.mockRestore();
  });

  it("si no se puede abrir la sesión devuelve vacío sin lanzar", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const panel = await panelMemoria("http://x/mcp", { consulta: "x" }, f);
    expect(panel).toEqual({ resumen: null, datos: [], entidades: [], constelacion: null });
    aviso.mockRestore();
  });

  it("una respuesta con forma inesperada no se lee como memoria vacía", async () => {
    const s = servidorFalso({ get_stats: { cualquier: "cosa" } });
    const panel = await panelMemoria("http://x/mcp", {}, s.fetch);
    // null => el panel omite la sección. Cero se leería como "no tienes nada".
    expect(panel.resumen).toBeNull();
  });
});
