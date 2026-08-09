import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerType } from "@hono/node-server";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer } from "./helpers.js";

let server: ServerType;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile: path.join(os.tmpdir(), `gw-smoke-tenants-${process.pid}.json`),
  });
  const { auth, db } = createAuth(config);
  await migrate(auth);
  const tenants = createTenantRegistry(config.tenantsFile);
  const app = buildApp(auth, config, db, tenants);
  ({ server, baseUrl } = await listen(app));
});

afterAll(async () => {
  await closeServer(server);
});

describe("gateway smoke", () => {
  it("serves OAuth authorization server metadata as JSON", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.authorization_endpoint).toContain("/api/auth/mcp/authorize");
    expect(body.token_endpoint).toContain("/api/auth/mcp/token");
    expect(body.registration_endpoint).toContain("/api/auth/mcp/register");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  it("serves OAuth protected resource metadata", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBeTruthy();
    expect(body.authorization_servers?.length).toBeGreaterThan(0);
  });

  it("rejects /mcp without a bearer token with 401 + WWW-Authenticate", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeTruthy();
  });

  it("serves the Spanish login page", async () => {
    const res = await fetch(`${baseUrl}/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Iniciar sesión");
  });
});
