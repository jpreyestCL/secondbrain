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
import { listen, closeServer, obtainAccessToken } from "./helpers.js";

/** A mock upstream Graphiti MCP server that labels its responses. */
function mockUpstream(label: string): Hono {
  const app = new Hono();
  app.post("/mcp", async (c) => {
    const body = await c.req.json<{ id: number }>();
    c.header("Mcp-Session-Id", `session-${label}`);
    return c.json({
      jsonrpc: "2.0",
      id: body.id,
      result: { upstream: label, receivedSession: c.req.header("mcp-session-id") ?? null },
    });
  });
  return app;
}

const PASSWORD = "supersecret-123";
let servers: ServerType[] = [];
let baseUrl: string;
let tenantsFile: string;

beforeAll(async () => {
  const upstreamA = await listen(mockUpstream("tenant-a"));
  const upstreamB = await listen(mockUpstream("tenant-b"));
  servers.push(upstreamA.server, upstreamB.server);

  tenantsFile = path.join(os.tmpdir(), `gw-mt-tenants-${process.pid}.json`);
  fs.writeFileSync(
    tenantsFile,
    JSON.stringify({
      "alice@test.dev": `${upstreamA.baseUrl}/mcp`,
      "bob@test.dev": `${upstreamB.baseUrl}/mcp`,
      // carol@test.dev intentionally unmapped
    }),
  );

  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile,
  });
  const { auth, db } = createAuth(config, { forceAllowSignup: true });
  await migrate(auth);
  for (const email of ["alice@test.dev", "bob@test.dev", "carol@test.dev"]) {
    await auth.api.signUpEmail({ body: { email, password: PASSWORD, name: email } });
  }

  const gateway = await listen(buildApp(auth, config, db, createTenantRegistry(tenantsFile)));
  servers.push(gateway.server);
  baseUrl = gateway.baseUrl;
});

afterAll(async () => {
  await Promise.all(servers.map(closeServer));
  fs.rmSync(tenantsFile, { force: true });
});

async function callMcp(token: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": "client-session-1",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("multi-tenant routing", () => {
  it("routes each user to their own upstream, forwarding session headers", async () => {
    const tokenA = await obtainAccessToken(baseUrl, "alice@test.dev", PASSWORD);
    const tokenB = await obtainAccessToken(baseUrl, "bob@test.dev", PASSWORD);

    const resA = await callMcp(tokenA);
    expect(resA.status).toBe(200);
    expect(resA.headers.get("mcp-session-id")).toBe("session-tenant-a");
    const bodyA = await resA.json();
    expect(bodyA.result.upstream).toBe("tenant-a");
    expect(bodyA.result.receivedSession).toBe("client-session-1");

    const resB = await callMcp(tokenB);
    expect(resB.status).toBe(200);
    expect(resB.headers.get("mcp-session-id")).toBe("session-tenant-b");
    const bodyB = await resB.json();
    expect(bodyB.result.upstream).toBe("tenant-b");
  });

  it("returns 403 (never a default upstream) for an authenticated user without mapping", async () => {
    const tokenC = await obtainAccessToken(baseUrl, "carol@test.dev", PASSWORD);
    const res = await callMcp(tokenC);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toContain("sin tenant");
  });

  it("rejects authorize requests without PKCE", async () => {
    // Registered client + logged-in session but no code_challenge.
    const reg = await fetch(`${baseUrl}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "no-pkce-client",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = await reg.json();
    const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@test.dev", password: PASSWORD }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      scope: "openid",
      state: "s",
    });
    const authz = await fetch(`${baseUrl}/api/auth/mcp/authorize?${query}`, {
      redirect: "manual",
      headers: { cookie },
    });
    const location = authz.headers.get("location") ?? "";
    expect(location).not.toContain("code=");
    const target = location.startsWith("http") ? location : `${baseUrl}${location}`;
    expect(`${authz.status} ${target}`).toMatch(/error|invalid|pkce/i);
  });
});
