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
import { guiaPageHtml } from "../src/guia-page.js";

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
    // `add` es el camino normal; el resto son las etapas sueltas, que se
    // documentan porque sirven para reanudar y corregir a mitad de camino.
    for (const cmd of [
      "brain add",
      "login",
      "scan",
      "extract",
      "classify --auto",
      "--apply",
      "chunk",
      "ingest-graph",
      "status",
      "expire",
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

  it("explica como conectar el conector MCP y sus errores comunes", async () => {
    const res = await fetch(`${baseUrl}/guia`);
    const html = await res.text();
    expect(res.status).toBe(200);
    // pasos de conexion
    expect(html).toContain("Conectar tu Claude");
    expect(html).toMatch(/Ajustes\s*→\s*Conectores/);
    expect(html).toContain("Agregar conector personalizado");
    expect(html).toContain("/mcp");
    expect(html).toContain("Autorizar");
    // diagnostico de los fallos que vimos en produccion
    expect(html).toContain("invalid_client");
    expect(html).toContain("account_not_linked");
    // indice enlaza la seccion
    expect(html).toContain('href="#conectar"');
    expect(html).toContain('id="conectar"');
  });

  it("la tabla de comandos muestra los marcadores, no entidades HTML crudas", async () => {
    // Los comandos venian ya escapados en el dato Y la plantilla los volvia a
    // escapar, asi que la pagina mostraba literalmente "add &lt;carpeta&gt;".
    // El escape es responsabilidad de la plantilla; el dato va en crudo.
    const res = await fetch(`${baseUrl}/guia`);
    const html = await res.text();
    expect(html).not.toContain("&amp;lt;");
    expect(html).not.toContain("&amp;gt;");
    expect(html).toContain("add &lt;carpeta&gt;");
  });
});

describe("guía de uso en inglés", () => {
  const en = () => guiaPageHtml({ idioma: "en", url: "/guia?lang=en" });

  it("sin idioma sigue en español", () => {
    const html = guiaPageHtml();
    expect(html).toContain("Guía de uso");
    expect(html).toContain("Conversar con el cerebro");
    expect(html).toContain("Ingesta masiva de una carpeta");
    expect(html).not.toContain("Talk to your brain");
  });

  it("traduce las secciones y no deja español suelto", () => {
    const html = en();
    for (const texto of [
      "User guide",
      "Connect your Claude",
      "Talk to your brain",
      "The 9 MCP tools",
      "Bulk ingestion of a folder",
      "Export and revoke access",
      "Settings → Connectors",
      "Add custom connector",
    ]) {
      expect(html).toContain(texto);
    }
    for (const texto of [
      "Guía de uso",
      "Conversar con el cerebro",
      "Las 9 herramientas MCP",
      "Ingesta masiva",
      "Exportar y cerrar accesos",
      "Ajustes",
    ]) {
      expect(html).not.toContain(texto);
    }
  });

  it("traduce las descripciones de las 9 herramientas pero no sus nombres", () => {
    const html = en();
    for (const tool of TOOLS) expect(html).toContain(tool);
    expect(html).toContain("Saves a fact or a chunk of a document into your memory.");
    expect(html).toContain("Deletes ALL your memory. There is no undo.");
    expect(html).not.toContain("Guarda un dato o un trozo de documento");
    // Los parámetros son identificadores: iguales en los dos idiomas.
    expect(html).toContain("name, episode_body, source, source_description");
  });

  it("traduce la tabla del CLI y sus marcadores, no los comandos", () => {
    const html = en();
    expect(html).toContain("add &lt;folder&gt;");
    expect(html).toContain("classify --apply &lt;file&gt;");
    expect(html).not.toContain("&lt;carpeta&gt;");
    expect(html).toContain("The whole process in one command. With --review it stops before sending.");
    // Los flags y subcomandos no se traducen.
    for (const cmd of ["brain add", "classify --auto", "ingest-graph", "expire", "--tenant"]) {
      expect(html).toContain(cmd);
    }
  });

  it("traduce los comentarios del bloque de entorno sin tocar los comandos", () => {
    const html = en();
    expect(html).toContain("ssh -f -N -L 16380:127.0.0.1:6380");
    expect(html).toContain("EMBEDDER_DIMENSIONS=4096");
    expect(html).toContain("The local port CANNOT be 6379");
    expect(html).not.toContain("El puerto local NO puede ser 6379");
    // La advertencia crítica de embeddings sigue destacada, en inglés.
    expect(html).toMatch(/class="warn"[^>]*>[\s\S]*?nv-embed-v1/);
    expect(html).toContain("MUST match the server's");
  });

  it("no reintroduce el doble escape en inglés", () => {
    const html = en();
    expect(html).not.toContain("&amp;lt;");
    expect(html).not.toContain("&amp;gt;");
  });

  it("rellena el espacio del usuario también en inglés", () => {
    const html = guiaPageHtml({ idioma: "en", tenant: "jpreyest" });
    expect(html).toContain("The examples already carry your space");
    expect(html).toContain("<code>jpreyest</code>");
    expect(html).not.toContain("Los ejemplos ya vienen con tu espacio");
  });
});
