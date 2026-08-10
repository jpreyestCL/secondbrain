/**
 * REGISTRATION_MODE (open | invite | closed) y la válvula MAX_TENANTS.
 *
 * Invariantes que se verifican aquí:
 *  - `open`  : /registro sin campo de código; un POST sin código crea la cuenta
 *              y aprovisiona el tenant. Google entra sin cookie `registro_ok`.
 *  - `invite`: el código sigue siendo obligatorio (también para Google).
 *  - `closed`: 403 en /registro.
 *  - MAX_TENANTS alcanzado: NO se crea usuario ni tenant.
 *  - Fallo de aprovisionamiento: se borra el usuario recién creado y un
 *    reintento con el MISMO correo funciona.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type GatewayConfig } from "../src/env.js";
import { createAuth, migrate, type Auth } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer } from "./helpers.js";

const PASSWORD = "clave-larga-123";
const CODE = "codigo-super-secreto";
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

interface Gateway {
  baseUrl: string;
  server: ServerType;
  db: Database.Database;
  auth: Auth;
  tenantsFile: string;
  stubLog: string;
  tmpRoot: string;
  upstreamPort: number;
  upstreamServer: ServerType;
}

/**
 * Levanta un gateway aislado con un PROVISION_CMD stub (igual que el resto de
 * la suite). Si `failUntil` se pasa, el stub falla mientras ese archivo NO
 * exista: sirve para provocar un fallo de aprovisionamiento y luego reintentar.
 */
async function makeGateway(
  overrides: Partial<GatewayConfig>,
  opts: { failUntil?: string } = {},
): Promise<Gateway> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gw-modes-"));
  const tenantsDir = path.join(tmpRoot, "infra", "tenants");
  fs.mkdirSync(tenantsDir, { recursive: true });
  const stubLog = path.join(tmpRoot, "provision.log");
  const stub = path.join(tmpRoot, "stub-provision.sh");
  const guard = opts.failUntil
    ? `if [ ! -f "${opts.failUntil}" ]; then echo "provision no disponible" >&2; exit 1; fi\n`
    : "";
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
set -euo pipefail
${guard}echo "$1 $2" >> "${stubLog}"
printf 'TENANT_NAME=%s\\nMCP_PORT=%s\\n' "$1" "$2" > "${tenantsDir}/$1.env"
`,
    { mode: 0o755 },
  );

  const upstream = await listen(mockUpstream("tenant-mock"));
  const upstreamPort = Number(new URL(upstream.baseUrl).port);

  const tenantsFile = path.join(tmpRoot, "tenants.json");
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: SECRET,
    baseUrl: "https://brain.example.com",
    tenantsFile,
    allowSignup: false,
    brainRepoRoot: tmpRoot,
    provisionCmd: `bash ${stub} {slug} {port}`,
    tenantPortBase: upstreamPort,
    registroRateLimit: 100,
    ...overrides,
  });
  const { auth, db } = createAuth(config);
  await migrate(auth);
  const gw = await listen(buildApp(auth, config, db, createTenantRegistry(tenantsFile)));
  return {
    baseUrl: gw.baseUrl,
    server: gw.server,
    db,
    auth,
    tenantsFile,
    stubLog,
    tmpRoot,
    upstreamPort,
    upstreamServer: upstream.server,
  };
}

async function tearDown(gw: Gateway): Promise<void> {
  await closeServer(gw.server);
  await closeServer(gw.upstreamServer);
  fs.rmSync(gw.tmpRoot, { recursive: true, force: true });
}

function postRegistro(
  baseUrl: string,
  fields: Record<string, string>,
  ip = "10.0.0.1",
): Promise<Response> {
  return fetch(`${baseUrl}/registro`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": ip },
    body: new URLSearchParams(fields),
  });
}

const countUsers = (db: Database.Database, email: string): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM "user" WHERE email = ?').get(email) as { n: number }).n;

const mapping = (file: string): Record<string, string> =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};

// ---------------------------------------------------------------------------
// Resolución del modo (incl. compatibilidad hacia atrás)
// ---------------------------------------------------------------------------
describe("REGISTRATION_MODE: resolución", () => {
  it("por defecto es `open`", () => {
    expect(loadConfig({}).registrationMode).toBe("open");
  });

  it("compatibilidad: sin REGISTRATION_MODE pero con REGISTRATION_CODE => invite", () => {
    expect(loadConfig({ registrationCode: "algo" }).registrationMode).toBe("invite");
  });

  it("un modo explícito gana sobre el código heredado", () => {
    expect(
      loadConfig({ registrationCode: "algo", registrationMode: "open" }).registrationMode,
    ).toBe("open");
  });

  it("MAX_TENANTS vale 5 por defecto", () => {
    expect(loadConfig({}).maxTenants).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------
describe("REGISTRATION_MODE=open", () => {
  let gw: Gateway;
  beforeAll(async () => {
    gw = await makeGateway({ registrationMode: "open", ...FAKE_GOOGLE });
  });
  afterAll(() => tearDown(gw));

  it("/registro no pide código de invitación", async () => {
    const res = await fetch(`${gw.baseUrl}/registro`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Crear cuenta");
    expect(html).not.toContain('name="code"');
    expect(html).not.toContain("código de invitación");
    expect(html).toContain("registro está abierto");
  });

  it("el botón de Google está habilitado desde el primer momento", async () => {
    const html = await (await fetch(`${gw.baseUrl}/registro`)).text();
    expect(html).toContain("Continuar con Google");
    expect(html).not.toContain('id="google" class="google" disabled');
    // Y no hay paso previo de canje de código.
    expect(html).not.toContain("/registro/validar-codigo");
  });

  it("un POST sin código crea la cuenta y aprovisiona el tenant", async () => {
    const email = "abierto@test.dev";
    const res = await postRegistro(gw.baseUrl, { email, password: PASSWORD, confirm: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Cuenta creada");

    expect(fs.readFileSync(gw.stubLog, "utf8")).toContain(`abierto ${gw.upstreamPort}`);
    expect(mapping(gw.tenantsFile)[email]).toBe(`http://127.0.0.1:${gw.upstreamPort}/mcp`);
    expect(countUsers(gw.db, email)).toBe(1);
  });

  it("/login y la landing invitan a registrarse sin mencionar códigos", async () => {
    const login = await (await fetch(`${gw.baseUrl}/login`)).text();
    expect(login).toContain('href="/registro"');
    expect(login).toContain("no necesitas código de invitación");

    const landing = await (await fetch(`${gw.baseUrl}/`)).text();
    expect(landing).toContain("El registro está abierto");
    expect(landing).not.toContain("El acceso es por invitación");
  });

  it("validar-codigo ya no aplica en modo open", async () => {
    const res = await fetch(`${gw.baseUrl}/registro/validar-codigo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: CODE }),
    });
    expect(res.status).toBe(403);
  });

  it("Google: un usuario nuevo se aprovisiona SIN la cookie registro_ok", async () => {
    const email = "google-abierto@test.dev";
    // Estado post-callback de Google: autenticado y sin tenant (sin red real).
    await gw.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "g" } });
    const login = await fetch(`${gw.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const res = await fetch(`${gw.baseUrl}/post-google`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Sesión iniciada");
    expect(mapping(gw.tenantsFile)[email]).toBe(
      `http://127.0.0.1:${gw.upstreamPort + 1}/mcp`,
    );
  });
});

// ---------------------------------------------------------------------------
// invite
// ---------------------------------------------------------------------------
describe("REGISTRATION_MODE=invite", () => {
  let gw: Gateway;
  beforeAll(async () => {
    gw = await makeGateway({
      registrationMode: "invite",
      registrationCode: CODE,
      ...FAKE_GOOGLE,
    });
  });
  afterAll(() => tearDown(gw));

  it("/registro sigue pidiendo el código", async () => {
    const html = await (await fetch(`${gw.baseUrl}/registro`)).text();
    expect(html).toContain('name="code"');
    expect(html).toContain("código de invitación");
    expect(html).toContain('id="google" class="google" disabled');
  });

  it("un POST sin código se rechaza y no aprovisiona nada", async () => {
    const res = await postRegistro(gw.baseUrl, {
      email: "sincodigo@test.dev",
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Código de invitación incorrecto");
    expect(fs.existsSync(gw.stubLog)).toBe(false);
    expect(countUsers(gw.db, "sincodigo@test.dev")).toBe(0);
  });

  it("con el código correcto sí registra y aprovisiona", async () => {
    const email = "coninvitacion@test.dev";
    const res = await postRegistro(gw.baseUrl, {
      email,
      password: PASSWORD,
      confirm: PASSWORD,
      code: CODE,
    });
    expect(res.status).toBe(200);
    expect(mapping(gw.tenantsFile)[email]).toBe(`http://127.0.0.1:${gw.upstreamPort}/mcp`);
  });

  it("Google sigue exigiendo la cookie registro_ok (usuario nuevo sin ella => 403)", async () => {
    const email = "google-invite@test.dev";
    await gw.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "g" } });
    const login = await fetch(`${gw.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const res = await fetch(`${gw.baseUrl}/post-google`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("código de invitación");
    expect(mapping(gw.tenantsFile)[email]).toBeUndefined();
  });

  it("la landing mantiene el mensaje de invitación", async () => {
    const landing = await (await fetch(`${gw.baseUrl}/`)).text();
    expect(landing).toContain("El acceso es por invitación");
  });
});

// ---------------------------------------------------------------------------
// closed
// ---------------------------------------------------------------------------
describe("REGISTRATION_MODE=closed", () => {
  let gw: Gateway;
  beforeAll(async () => {
    gw = await makeGateway({ registrationMode: "closed", registrationCode: CODE });
  });
  afterAll(() => tearDown(gw));

  it("GET /registro responde 403", async () => {
    const res = await fetch(`${gw.baseUrl}/registro`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Registro deshabilitado");
  });

  it("POST /registro responde 403 aunque traiga el código correcto", async () => {
    const res = await postRegistro(gw.baseUrl, {
      email: "cerrado@test.dev",
      password: PASSWORD,
      confirm: PASSWORD,
      code: CODE,
    });
    expect(res.status).toBe(403);
    expect(countUsers(gw.db, "cerrado@test.dev")).toBe(0);
  });

  it("/login no enlaza a /registro", async () => {
    const html = await (await fetch(`${gw.baseUrl}/login`)).text();
    expect(html).not.toContain("/registro");
  });
});

// ---------------------------------------------------------------------------
// MAX_TENANTS: válvula de seguridad de memoria
// ---------------------------------------------------------------------------
describe("MAX_TENANTS (válvula de capacidad)", () => {
  let gw: Gateway;
  beforeAll(async () => {
    gw = await makeGateway({ registrationMode: "open", maxTenants: 2, ...FAKE_GOOGLE });
    // Dos tenants ya existentes: la instancia queda justo en el tope.
    fs.writeFileSync(
      gw.tenantsFile,
      JSON.stringify({ "uno@x.dev": "http://127.0.0.1:9001/mcp", "dos@x.dev": "http://127.0.0.1:9002/mcp" }),
    );
  });
  afterAll(() => tearDown(gw));

  it("rechaza el registro con una página en español y NO crea ninguna fila de usuario", async () => {
    const email = "lleno@test.dev";
    const res = await postRegistro(gw.baseUrl, { email, password: PASSWORD, confirm: PASSWORD });
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Registro cerrado temporalmente");
    expect(html).toContain("capacidad máxima");

    expect(countUsers(gw.db, email)).toBe(0);
    expect(fs.existsSync(gw.stubLog)).toBe(false); // no se aprovisionó nada
    expect(Object.keys(mapping(gw.tenantsFile))).toHaveLength(2);
  });

  it("también corta el alta por Google (y cierra la sesión)", async () => {
    const email = "google-lleno@test.dev";
    await gw.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: "g" } });
    const login = await fetch(`${gw.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    const res = await fetch(`${gw.baseUrl}/post-google`, { headers: { cookie }, redirect: "manual" });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Registro cerrado temporalmente");
    expect(mapping(gw.tenantsFile)[email]).toBeUndefined();
    expect(res.headers.getSetCookie().length).toBeGreaterThan(0); // sesión cerrada
  });

  it("bajo el tope el registro vuelve a funcionar", async () => {
    fs.writeFileSync(gw.tenantsFile, JSON.stringify({ "uno@x.dev": "http://127.0.0.1:9001/mcp" }));
    const email = "cabe@test.dev";
    const res = await postRegistro(gw.baseUrl, { email, password: PASSWORD, confirm: PASSWORD });
    expect(res.status).toBe(200);
    expect(mapping(gw.tenantsFile)[email]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Rollback: un aprovisionamiento fallido no deja cuenta ni quema el correo
// ---------------------------------------------------------------------------
describe("fallo de aprovisionamiento", () => {
  let gw: Gateway;
  let flag: string;

  beforeAll(async () => {
    flag = path.join(os.tmpdir(), `gw-provision-ok-${process.pid}-${Date.now()}`);
    gw = await makeGateway({ registrationMode: "open" }, { failUntil: flag });
  });

  afterAll(async () => {
    await tearDown(gw);
    fs.rmSync(flag, { force: true });
  });

  it("borra el usuario recién creado y un reintento con el mismo correo funciona", async () => {
    const email = "reintento@test.dev";

    // 1) El provisionamiento falla: página de error y NINGÚN usuario en la base.
    const failed = await postRegistro(gw.baseUrl, {
      email,
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expect(failed.status).toBe(500);
    expect(await failed.text()).toContain("No pudimos preparar tu espacio");
    expect(countUsers(gw.db, email)).toBe(0); // correo NO quemado
    expect(mapping(gw.tenantsFile)[email]).toBeUndefined();

    // 2) Se arregla la provisión y el MISMO correo se registra sin problema.
    fs.writeFileSync(flag, "ok");
    const ok = await postRegistro(gw.baseUrl, { email, password: PASSWORD, confirm: PASSWORD });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Cuenta creada");
    expect(countUsers(gw.db, email)).toBe(1);
    expect(mapping(gw.tenantsFile)[email]).toBe(`http://127.0.0.1:${gw.upstreamPort}/mcp`);
  });
});
