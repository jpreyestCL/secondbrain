/**
 * Guía de uso (/guia): exige sesión y documenta con exactitud lo que el
 * servidor MCP y el CLI `brain` ofrecen de verdad.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerType } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer } from "./helpers.js";

const PASSWORD = "supersecret-123";
const EMAIL = "guia@test.dev";
const UPSTREAM = "http://127.0.0.1:9099/mcp";

const TOOLS = [
  "add_memory",
  "search_memory_facts",
  "search_nodes",
  "get_episodes",
  "get_entity_edge",
  "delete_entity_edge",
  "delete_episode",
  "clear_graph",
  "get_status",
];

let server: ServerType;
let baseUrl: string;
let tenantsFile: string;

async function signIn(): Promise<string> {
  const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

beforeAll(async () => {
  tenantsFile = path.join(os.tmpdir(), `gw-guia-${process.pid}.json`);
  fs.writeFileSync(tenantsFile, JSON.stringify({ [EMAIL]: UPSTREAM }));
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile,
  });
  const created = createAuth(config);
  await migrate(created.auth);
  await created.auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "g" } });
  const gw = await listen(
    buildApp(created.auth, config, created.db, createTenantRegistry(tenantsFile)),
  );
  server = gw.server;
  baseUrl = gw.baseUrl;
});

afterAll(async () => {
  await closeServer(server);
  fs.rmSync(tenantsFile, { force: true });
});

describe("guía de uso", () => {
  it("sin sesión no se puede ver", async () => {
    // La guía es pública por diseño: documentación enlazada desde la landing.
    const res = await fetch(`${baseUrl}/guia`, { redirect: "manual" });
    expect(res.status).toBe(200);
    if (res.status === 302) expect(res.headers.get("location")).toBe("/login");
  });

  it("con sesión responde 200 con las secciones clave", async () => {
    const cookie = await signIn();
    const res = await fetch(`${baseUrl}/guia`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("Guía de uso");
    // Índice de navegación interna + anclas.
    for (const anchor of ["#conversar", "#herramientas", "#masiva", "#accesos"]) {
      expect(html).toContain(`href="${anchor}"`);
      expect(html).toContain(`id="${anchor.slice(1)}"`);
    }
    // Bloques temáticos.
    expect(html).toContain("Conversar con el cerebro");
    expect(html).toContain("Las 9 herramientas MCP");
    expect(html).toContain("Ingesta masiva");
    expect(html).toContain("Exportar y cerrar accesos");
  });

  it("lista las 9 herramientas MCP con sus parámetros y salvedades", async () => {
    const cookie = await signIn();
    const html = await (await fetch(`${baseUrl}/guia`, { headers: { cookie } })).text();
    for (const tool of TOOLS) expect(html).toContain(tool);
    expect(html).toContain("reference_time");
    expect(html).toContain("only_current");
    expect(html).toContain("group_id");
  });

  it("documenta el pipeline del CLI y el túnel SSH con la advertencia de embeddings", async () => {
    const cookie = await signIn();
    const html = await (await fetch(`${baseUrl}/guia`, { headers: { cookie } })).text();
    for (const cmd of [
      "scan",
      "extract",
      "classify",
      "--apply",
      "chunk",
      "ingest-graph",
      "status",
      "expire",
      "version",
      "--tenant",
    ]) {
      expect(html).toContain(cmd);
    }
    expect(html).toContain("ssh -f -N -L 16380:127.0.0.1:6380");
    expect(html).toContain("EMBEDDER_DIMENSIONS=4096");
    expect(html).toContain("nvidia/nv-embed-v1");
    expect(html).toContain("~/.brain/");
    // El aviso crítico va destacado, no en texto corrido.
    expect(html).toMatch(/class="warn"[^>]*>[\s\S]*?nv-embed-v1/);
    // Los bloques de código no desbordan en móvil.
    expect(html).toContain("overflow-x: auto");
  });

  it("se enlaza desde /cuenta y desde la landing", async () => {
    const cookie = await signIn();
    const cuenta = await (await fetch(`${baseUrl}/cuenta`, { headers: { cookie } })).text();
    expect(cuenta).toContain('href="/guia"');

    const landing = await (await fetch(`${baseUrl}/`)).text();
    expect(landing).toContain('href="/guia"');
  });
});
