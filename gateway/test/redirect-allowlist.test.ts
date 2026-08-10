import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import type { Hono } from "hono";

let app: Hono;

beforeAll(async () => {
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile: path.join(os.tmpdir(), `gw-redir-tenants-${process.pid}.json`),
  });
  const { auth, db } = createAuth(config);
  await migrate(auth);
  app = buildApp(auth, config, db, createTenantRegistry(config.tenantsFile));
});

/**
 * Regresión del hallazgo A1 de la auditoría: un atacante registraba por DCR un
 * cliente con redirect_uri a su dominio y, con un clic del dueño en /authorize,
 * recibía el `code` y canjeaba un token con acceso total al grafo.
 */
describe("allowlist de redirect_uri", () => {
  it("rechaza DCR con redirect_uri de un dominio ajeno", async () => {
    const res = await app.request("/api/auth/mcp/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "evil",
        redirect_uris: ["https://evil.example.com/cb"],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("acepta DCR de un cliente MCP legítimo (claude.ai)", async () => {
    const res = await app.request("/api/auth/mcp/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    });
    expect(res.status).toBeLessThan(400);
  });

  it("acepta loopback para desarrollo (MCP Inspector)", async () => {
    const res = await app.request("/api/auth/mcp/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "inspector",
        redirect_uris: ["http://127.0.0.1:6274/oauth/callback"],
      }),
    });
    expect(res.status).toBeLessThan(400);
  });

  it("rechaza /authorize con redirect_uri ajeno aunque el cliente exista", async () => {
    const res = await app.request(
      "/api/auth/mcp/authorize?response_type=code&client_id=x&redirect_uri=" +
        encodeURIComponent("https://evil.example.com/cb") +
        "&code_challenge=abc&code_challenge_method=S256",
    );
    expect(res.status).toBe(400);
  });

  it("rechaza esquemas no https (p.ej. javascript:)", async () => {
    const res = await app.request("/api/auth/mcp/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "x",
        redirect_uris: ["javascript:alert(1)"],
      }),
    });
    expect(res.status).toBe(400);
  });
});
