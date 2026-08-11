import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import type { Auth } from "../src/auth.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer, obtainAccessToken } from "./helpers.js";

const CODE = "codigo-super-secreto";
const PASSWORD = "clave-larga-123";
const SECRET = "test-secret-test-secret-test-secret-0000";
const FAKE_GOOGLE = {
  googleClientId: "fake-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "fake-google-client-secret",
};

function mockUpstream(label: string): Hono {
  const app = new Hono();
  app.post("/mcp", async (c) => {
    const body = await c.req.json<{ id: number }>();
    return c.json({ jsonrpc: "2.0", id: body.id, result: { upstream: label } });
  });
  return app;
}

/** Cookies de un Set-Cookie -> "name=value" unidos por "; ". */
function cookieHeader(res: Response, only?: (name: string) => boolean): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => (only ? only(c.split("=")[0]!) : true))
    .join("; ");
}

// ---------------------------------------------------------------------------
// Google CONFIGURADO (credenciales falsas, sin llamadas de red reales).
// ---------------------------------------------------------------------------
describe("Google configurado", () => {
  const servers: ServerType[] = [];
  let tmpRoot: string;
  let tenantsDir: string;
  let tenantsFile: string;
  let stubLog: string;
  let baseUrl: string;
  let upstreamPort: number;
  let auth: Auth;

  /**
   * Crea un usuario server-side (sin aprovisionar tenant) e inicia sesión para
   * obtener la cookie de sesión. Simula el estado tras el callback de Google de
   * un usuario nuevo: autenticado pero SIN mapeo de tenant. /post-google solo
   * depende de la sesión + mapeo + cookie registro_ok, así que esto ejercita el
   * gate sin ninguna llamada de red a Google.
   */
  async function makeAuthedSession(email: string): Promise<string> {
    await auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: email.split("@")[0] ?? email },
    });
    const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (!login.ok) throw new Error(`login failed: ${login.status}`);
    return cookieHeader(login);
  }

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gw-google-"));
    tenantsDir = path.join(tmpRoot, "infra", "tenants");
    fs.mkdirSync(tenantsDir, { recursive: true });
    stubLog = path.join(tmpRoot, "provision.log");
    const stub = path.join(tmpRoot, "stub-provision.sh");
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash
set -euo pipefail
echo "$1 $2" >> "${stubLog}"
printf 'TENANT_NAME=%s\\nMCP_PORT=%s\\n' "$1" "$2" > "${tenantsDir}/$1.env"
`,
      { mode: 0o755 },
    );

    const upstream = await listen(mockUpstream("tenant-google"));
    servers.push(upstream.server);
    upstreamPort = Number(new URL(upstream.baseUrl).port);

    tenantsFile = path.join(tmpRoot, "tenants.json");
    const config = loadConfig({
      dbPath: ":memory:",
      authSecret: SECRET,
      baseUrl: "https://brain.example.com",
      tenantsFile,
      allowSignup: false,
      registrationCode: CODE,
      brainRepoRoot: tmpRoot,
      provisionCmd: `bash ${stub} {slug} {port}`,
      tenantPortBase: upstreamPort,
      registroRateLimit: 100,
      ...FAKE_GOOGLE,
    });
    const created = createAuth(config);
    auth = created.auth;
    await migrate(auth);
    const gw = await listen(
      buildApp(auth, config, created.db, createTenantRegistry(tenantsFile)),
    );
    servers.push(gw.server);
    baseUrl = gw.baseUrl;
  });

  afterAll(async () => {
    await Promise.all(servers.map(closeServer));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("renders the Google button on /login", async () => {
    const html = await (await fetch(`${baseUrl}/login`)).text();
    expect(html).toContain("Continuar con Google");
  });

  it("renders the Google button on /registro (disabled until a code is entered)", async () => {
    const html = await (await fetch(`${baseUrl}/registro`)).text();
    expect(html).toContain("Continuar con Google");
    expect(html).toContain('id="google" class="google" disabled');
    expect(html).toContain("código de invitación");
  });

  it("wires the google provider: sign-in/social returns a Google authorize URL", async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        callbackURL: "/post-google",
        disableRedirect: true,
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { url?: string };
    expect(data.url ?? "").toContain("accounts.google.com");
  });

  it("validar-codigo rejects a wrong code without setting the cookie", async () => {
    const res = await fetch(`${baseUrl}/registro/validar-codigo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "codigo-incorrecto" }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("registro_ok="))).toBe(false);
  });

  it("INVARIANTE: Google user without a valid invite cookie is NOT provisioned and is signed out", async () => {
    const email = "sininvitacion@test.dev";
    const sessionCookie = await makeAuthedSession(email);

    const res = await fetch(`${baseUrl}/post-google`, {
      headers: { cookie: sessionCookie },
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("código de invitación");
    // La sesión se termina (cookie de sesión borrada en la respuesta).
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0);

    // NINGÚN mapeo de tenant fue escrito para este correo.
    const mapping = fs.existsSync(tenantsFile)
      ? JSON.parse(fs.readFileSync(tenantsFile, "utf8"))
      : {};
    expect(mapping[email]).toBeUndefined();

    // Comportamiento existente: usuario sin tenant -> 403 en /mcp.
    const token = await obtainAccessToken(baseUrl, email, PASSWORD);
    const mcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.status).toBe(403);
  });

  it("INVARIANTE: Google user WITH a valid invite cookie is provisioned and mapped", async () => {
    const email = "coninvitacion@test.dev";
    const sessionCookie = await makeAuthedSession(email);

    // Valida el código -> obtiene la cookie registro_ok (integración real).
    const valid = await fetch(`${baseUrl}/registro/validar-codigo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: CODE }),
    });
    expect(valid.status).toBe(200);
    const regCookie = cookieHeader(valid, (name) => name === "registro_ok");
    expect(regCookie).toContain("registro_ok=");

    const res = await fetch(`${baseUrl}/post-google`, {
      headers: { cookie: `${sessionCookie}; ${regCookie}` },
      redirect: "manual",
    });
    // Tras aprovisionar se entra DIRECTO al panel (antes habia una pantalla
    // intermedia de "sesion iniciada").
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location")).toBe("/cuenta");

    // El aprovisionamiento se ejecutó y el mapeo quedó escrito.
    expect(fs.readFileSync(stubLog, "utf8")).toContain(`coninvitacion ${upstreamPort}`);
    const mapping = JSON.parse(fs.readFileSync(tenantsFile, "utf8"));
    expect(mapping[email]).toBe(`http://127.0.0.1:${upstreamPort}/mcp`);

    // Flujo OAuth completo -> /mcp llega al upstream del tenant.
    const token = await obtainAccessToken(baseUrl, email, PASSWORD);
    const mcp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(mcp.status).toBe(200);
    expect((await mcp.json()).result.upstream).toBe("tenant-google");
  });
});

// ---------------------------------------------------------------------------
// Google DESHABILITADO (sin credenciales): sin botón, callback seguro.
// ---------------------------------------------------------------------------
describe("Google deshabilitado (sin credenciales)", () => {
  let server: ServerType;
  let baseUrl: string;
  let tmp: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-nogoogle-"));
    const config = loadConfig({
      dbPath: ":memory:",
      authSecret: SECRET,
      baseUrl: "http://127.0.0.1:8787",
      tenantsFile: path.join(tmp, "tenants.json"),
      registrationCode: CODE,
      brainRepoRoot: tmp,
      provisionCmd: "false",
      googleClientId: "",
      googleClientSecret: "",
    });
    const { auth, db } = createAuth(config);
    await migrate(auth);
    const gw = await listen(buildApp(auth, config, db, createTenantRegistry(config.tenantsFile)));
    server = gw.server;
    baseUrl = gw.baseUrl;
  });

  afterAll(async () => {
    await closeServer(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not render the Google button on /login", async () => {
    const html = await (await fetch(`${baseUrl}/login`)).text();
    expect(html).not.toContain("Continuar con Google");
  });

  it("does not render the Google button on /registro", async () => {
    const html = await (await fetch(`${baseUrl}/registro`)).text();
    expect(html).not.toContain("Continuar con Google");
  });

  it("does not wire the google provider (sign-in/social fails, no crash)", async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: "/post-google", disableRedirect: true }),
    });
    expect(res.status).not.toBe(200);
    const data = (await res.json().catch(() => ({}))) as { url?: string };
    expect(data.url).toBeUndefined();
  });

  it("/post-google without a session safely redirects to /login", async () => {
    const res = await fetch(`${baseUrl}/post-google`, { redirect: "manual" });
    expect([302, 307]).toContain(res.status);
    expect(res.headers.get("location")).toBe("/login");
  });
});
