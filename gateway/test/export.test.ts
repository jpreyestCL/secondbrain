/**
 * GET /export: descarga del grafo completo a través del MCP del propio tenant
 * (el upstream se simula con un servidor MCP falso).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer } from "./helpers.js";
import { exportGraph } from "../src/export.js";

const PASSWORD = "supersecret-123";
const EMAIL = "export@test.dev";

const EPISODES = [
  { uuid: "e1", name: "cuenta", content: "Mi cuenta es la 123", created_at: "2026-01-01T00:00:00Z" },
];
const NODES = [{ uuid: "n1", name: "Banco de Chile", labels: ["Entity"] }];
const FACTS = [
  {
    uuid: "f1",
    fact: "Cuenta corriente en Banco de Chile",
    valid_at: "2018-01-01T00:00:00Z",
    invalid_at: "2026-08-01T00:00:00Z",
  },
];

/** MCP falso: responde initialize y tools/call como FastMCP (JSON simple). */
function mockUpstream(calls: string[]): Hono {
  const app = new Hono();
  app.post("/mcp", async (c) => {
    const body = await c.req.json<{ id?: number; method: string; params?: any }>();
    if (body.method === "initialize") {
      c.header("Mcp-Session-Id", "sess-1");
      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } },
      });
    }
    if (body.method === "notifications/initialized") return c.body(null, 202);
    if (body.method === "tools/call") {
      const name = body.params?.name as string;
      calls.push(name);
      const payload =
        name === "get_episodes"
          ? { message: "ok", episodes: EPISODES }
          : name === "search_nodes"
            ? { message: "ok", nodes: NODES }
            : { message: "ok", facts: FACTS };
      return c.json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      });
    }
    return c.json({ jsonrpc: "2.0", id: body.id ?? null, result: {} });
  });
  return app;
}

let servers: ServerType[] = [];
let baseUrl: string;
let tenantsFile: string;
let cookie: string;
const calls: string[] = [];

beforeAll(async () => {
  const upstream = await listen(mockUpstream(calls));
  servers.push(upstream.server);
  tenantsFile = path.join(os.tmpdir(), `gw-export-${process.pid}.json`);
  fs.writeFileSync(
    tenantsFile,
    JSON.stringify({ [EMAIL]: `${upstream.baseUrl}/mcp` }),
  );

  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile,
  });
  const { auth, db } = createAuth(config);
  await migrate(auth);
  await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "e" } });
  await auth.api.signUpEmail({
    body: { email: "sin-tenant@test.dev", password: PASSWORD, name: "s" },
  });

  const gw = await listen(buildApp(auth, config, db, createTenantRegistry(tenantsFile)));
  servers.push(gw.server);
  baseUrl = gw.baseUrl;

  const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});

afterAll(async () => {
  await Promise.all(servers.map(closeServer));
  fs.rmSync(tenantsFile, { force: true });
});

describe("GET /export", () => {
  it("sin sesión responde 401 (API) o redirige a /login (navegador)", async () => {
    const api = await fetch(`${baseUrl}/export`, { redirect: "manual" });
    expect(api.status).toBe(401);
    expect((await api.json()).error).toBe("unauthorized");

    const browser = await fetch(`${baseUrl}/export`, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe("/login");
  });

  it("con sesión devuelve el grafo completo del propio tenant", async () => {
    const res = await fetch(`${baseUrl}/export`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(
      ["entities", "episodes", "exportedAt", "facts", "upstream", "user", "warnings"].sort(),
    );
    expect(body.user.email).toBe(EMAIL);
    expect(body.warnings).toEqual([]);
    expect(body.episodes[0].content).toBe("Mi cuenta es la 123");
    expect(body.entities[0].name).toBe("Banco de Chile");
    expect(body.facts[0].valid_at).toBe("2018-01-01T00:00:00Z");
    expect(body.facts[0].invalid_at).toBe("2026-08-01T00:00:00Z");
    // El export lanza VARIAS consultas amplias (la búsqueda es semántica: un
    // comodín no devuelve nada) y une resultados deduplicando por uuid.
    expect(calls[0]).toBe("get_episodes");
    expect(calls.filter((c) => c === "search_nodes").length).toBeGreaterThan(0);
    expect(calls.filter((c) => c === "search_memory_facts").length).toBeGreaterThan(0);
  });

  it("usuario sin tenant asignado recibe 409, nunca el grafo de otro", async () => {
    const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sin-tenant@test.dev", password: PASSWORD }),
    });
    const otherCookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const res = await fetch(`${baseUrl}/export`, { headers: { cookie: otherCookie } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("sin_tenant");
  });
});

describe("idioma de los avisos del export", () => {
  /** Un upstream que nunca contesta: fuerza el aviso de conexión. */
  const fetchRoto: typeof fetch = async () => {
    throw new Error("sin ruta");
  };

  it("por defecto los avisos van en español", async () => {
    const out = await exportGraph(
      "http://127.0.0.1:1/mcp",
      { id: "u", email: "a@b.cl" },
      { fetchImpl: fetchRoto },
    );
    expect(out.warnings[0]).toContain("No se pudo conectar con tu servidor de memoria");
  });

  it("con idioma inglés los avisos van en inglés y no en español", async () => {
    const out = await exportGraph(
      "http://127.0.0.1:1/mcp",
      { id: "u", email: "a@b.cl" },
      { fetchImpl: fetchRoto, idioma: "en" },
    );
    expect(out.warnings[0]).toContain("Could not connect to your memory server");
    expect(out.warnings[0]).not.toContain("No se pudo conectar");
  });

  /** Abre la sesión MCP pero hace fallar toda herramienta: así salen las etiquetas. */
  const fetchToolsRotas: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result =
      body.method === "initialize"
        ? { result: { protocolVersion: "2025-06-18", capabilities: {} } }
        : { result: { content: [{ type: "text", text: JSON.stringify({ error: "boom" }) }] } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...result }), {
      headers: { "content-type": "application/json" },
    });
  };

  it("las etiquetas inglesas hablan de documentos, no de episodios", async () => {
    const out = await exportGraph(
      "http://interno/mcp",
      { id: "u", email: "a@b.cl" },
      { fetchImpl: fetchToolsRotas, idioma: "en" },
    );
    expect(out.warnings.join(" ")).toContain("documents: boom");
    expect(out.warnings.join(" ")).not.toContain("episodios");
    // Y en español se mantiene el texto de siempre.
    const es = await exportGraph(
      "http://interno/mcp",
      { id: "u", email: "a@b.cl" },
      { fetchImpl: fetchToolsRotas },
    );
    expect(es.warnings.join(" ")).toContain("episodios: boom");
  });
});
