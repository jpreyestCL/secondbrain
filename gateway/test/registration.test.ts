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
import { slugFromEmail, dedupeSlug } from "../src/provision.js";
import { listen, closeServer, obtainAccessToken } from "./helpers.js";

const CODE = "codigo-super-secreto";
const PASSWORD = "clave-larga-123";

function mockUpstream(label: string): Hono {
  const app = new Hono();
  app.post("/mcp", async (c) => {
    const body = await c.req.json<{ id: number }>();
    return c.json({ jsonrpc: "2.0", id: body.id, result: { upstream: label } });
  });
  return app;
}

async function postRegistro(
  baseUrl: string,
  fields: Record<string, string>,
  ip = "10.0.0.1",
): Promise<Response> {
  return fetch(`${baseUrl}/registro`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": ip,
    },
    body: new URLSearchParams(fields),
  });
}

let servers: ServerType[] = [];
let tmpRoot: string;
let tenantsDir: string;
let tenantsFile: string;
let stubLog: string;
let baseUrl: string; // gateway with registration enabled
let upstreamPort: number;

beforeAll(async () => {
  // Falso BRAIN_REPO_ROOT con infra/tenants y un script stub de provisión que
  // emula al real: registra la llamada y crea el .env del tenant.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gw-registro-"));
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

  const upstream = await listen(mockUpstream("tenant-dave"));
  servers.push(upstream.server);
  upstreamPort = Number(new URL(upstream.baseUrl).port);

  tenantsFile = path.join(tmpRoot, "tenants.json");
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "https://brain.example.com",
    tenantsFile,
    allowSignup: false,
    registrationCode: CODE,
    brainRepoRoot: tmpRoot,
    provisionCmd: `bash ${stub} {slug} {port}`,
    tenantPortBase: upstreamPort, // el primer puerto asignado = mock upstream
    registroRateLimit: 100, // sin límite efectivo en esta suite
  });
  const { auth, db } = createAuth(config);
  await migrate(auth);
  const gw = await listen(buildApp(auth, config, db, createTenantRegistry(tenantsFile)));
  servers.push(gw.server);
  baseUrl = gw.baseUrl;
});

afterAll(async () => {
  await Promise.all(servers.map(closeServer));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("slug helpers", () => {
  it("derives a valid slug from the email local part", () => {
    expect(slugFromEmail("Juan.Perez+test@x.cl")).toBe("juan-perez-test");
    expect(slugFromEmail("maria_123@x.cl")).toBe("maria_123");
    expect(slugFromEmail("---@x.cl")).toBe("tenant");
  });
  it("dedupes collisions with a numeric suffix", () => {
    expect(dedupeSlug("ana", new Set(["ana", "ana-2"]))).toBe("ana-3");
  });
});

describe("registro self-service", () => {
  it("serves the registration form when REGISTRATION_CODE is set", async () => {
    const res = await fetch(`${baseUrl}/registro`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Crear cuenta");
    expect(html).toContain("código de invitación");
  });

  it("shows the register link on /login when enabled", async () => {
    const html = await (await fetch(`${baseUrl}/login`)).text();
    expect(html).toContain("¿No tienes cuenta? Regístrate");
    expect(html).toContain('href="/registro"');
  });

  it("rejects registration without code", async () => {
    const res = await postRegistro(baseUrl, {
      email: "sin@codigo.dev",
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Código de invitación incorrecto");
    expect(fs.existsSync(stubLog)).toBe(false); // no se aprovisionó nada
  });

  it("rejects registration with a wrong code", async () => {
    const res = await postRegistro(baseUrl, {
      email: "mal@codigo.dev",
      password: PASSWORD,
      confirm: PASSWORD,
      code: "codigo-incorrecto",
    });
    expect(res.status).toBe(403);
    expect(fs.existsSync(stubLog)).toBe(false);
  });

  it("rejects mismatched passwords server-side", async () => {
    const res = await postRegistro(baseUrl, {
      email: "otra@clave.dev",
      password: PASSWORD,
      confirm: "otra-clave-distinta",
      code: CODE,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no coinciden");
  });

  it("registers, provisions the tenant, maps it, and the full OAuth->/mcp flow works", async () => {
    const email = "dave@test.dev";
    const res = await postRegistro(baseUrl, {
      email,
      password: PASSWORD,
      confirm: PASSWORD,
      code: CODE,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Cuenta creada");
    expect(html).toContain("https://brain.example.com/mcp");
    expect(html).toContain("Conectores");

    // La provisión se ejecutó con slug y puerto correctos.
    expect(fs.readFileSync(stubLog, "utf8")).toContain(`dave ${upstreamPort}`);
    // Y el mapeo quedó en tenants.json.
    const mapping = JSON.parse(fs.readFileSync(tenantsFile, "utf8"));
    expect(mapping[email].url).toBe(`http://127.0.0.1:${upstreamPort}/mcp`);
    expect(mapping[email].slug).toBe("dave");

    // Flujo completo: OAuth (DCR -> login -> authorize PKCE -> token) -> /mcp.
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
    const body = await mcp.json();
    expect(body.result.upstream).toBe("tenant-dave");
  });

  it("handles slug collisions with a numeric suffix and allocates the next port", async () => {
    const first = await postRegistro(baseUrl, {
      email: "dave@otro-dominio.dev", // mismo local part "dave" => colisión
      password: PASSWORD,
      confirm: PASSWORD,
      code: CODE,
    });
    expect(first.status).toBe(200);
    const log = fs.readFileSync(stubLog, "utf8");
    expect(log).toContain(`dave-2 ${upstreamPort + 1}`);
    const mapping = JSON.parse(fs.readFileSync(tenantsFile, "utf8"));
    expect(mapping["dave@otro-dominio.dev"].url).toBe(
      `http://127.0.0.1:${upstreamPort + 1}/mcp`,
    );
    // El slug se persiste porque NO se puede derivar del correo: aqui "dave"
    // ya estaba tomado y el aprovisionamiento asigno "dave-2". El panel y la
    // guia muestran este valor, que es el que el CLI necesita.
    expect(mapping["dave@otro-dominio.dev"].slug).toBe("dave-2");
  });

  it("rejects a duplicate email without provisioning again", async () => {
    const before = fs.readFileSync(stubLog, "utf8");
    const res = await postRegistro(baseUrl, {
      email: "dave@test.dev",
      password: PASSWORD,
      confirm: PASSWORD,
      code: CODE,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    // Mensaje NEUTRO: no debe revelar que el correo ya existe (enumeración).
    expect(html).toContain("No se pudo crear la cuenta");
    expect(html).not.toContain("ya está registrado");
    expect(fs.readFileSync(stubLog, "utf8")).toBe(before);
  });

  it("keeps the public sign-up endpoint blocked with ALLOW_SIGNUP=false", async () => {
    const res = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "colado@test.dev", password: PASSWORD, name: "colado" }),
    });
    expect(res.status).toBe(403);
  });
});

// Antes "registro deshabilitado" era la ausencia de REGISTRATION_CODE. Ahora el
// registro es ABIERTO por defecto y cerrarlo es explícito: REGISTRATION_MODE=closed.
describe("registro deshabilitado (REGISTRATION_MODE=closed)", () => {
  let closedUrl: string;
  let closedServer: ServerType;
  let closedTmp: string;

  beforeAll(async () => {
    closedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-registro-off-"));
    const config = loadConfig({
      dbPath: ":memory:",
      authSecret: "test-secret-test-secret-test-secret-0000",
      baseUrl: "http://127.0.0.1:8787",
      tenantsFile: path.join(closedTmp, "tenants.json"),
      registrationCode: "",
      registrationMode: "closed",
      brainRepoRoot: closedTmp,
      provisionCmd: "false", // jamás debería ejecutarse
    });
    const { auth, db } = createAuth(config);
    await migrate(auth);
    const gw = await listen(buildApp(auth, config, db, createTenantRegistry(config.tenantsFile)));
    closedServer = gw.server;
    closedUrl = gw.baseUrl;
  });

  afterAll(async () => {
    await closeServer(closedServer);
    fs.rmSync(closedTmp, { recursive: true, force: true });
  });

  it("GET /registro says registro deshabilitado", async () => {
    const res = await fetch(`${closedUrl}/registro`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Registro deshabilitado");
  });

  it("POST /registro is rejected even with fields present", async () => {
    const res = await postRegistro(closedUrl, {
      email: "x@y.dev",
      password: PASSWORD,
      confirm: PASSWORD,
      code: "cualquiera",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Registro deshabilitado");
  });

  it("does not show the register link on /login", async () => {
    const html = await (await fetch(`${closedUrl}/login`)).text();
    expect(html).not.toContain("/registro");
  });
});

describe("rate limit de /registro", () => {
  it("returns 429 after the per-IP limit within a minute", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-registro-rate-"));
    const config = loadConfig({
      dbPath: ":memory:",
      authSecret: "test-secret-test-secret-test-secret-0000",
      baseUrl: "http://127.0.0.1:8787",
      tenantsFile: path.join(tmp, "tenants.json"),
      registrationCode: CODE,
      brainRepoRoot: tmp,
      provisionCmd: "true",
      registroRateLimit: 3,
    });
    const { auth, db } = createAuth(config);
    await migrate(auth);
    const gw = await listen(buildApp(auth, config, db, createTenantRegistry(config.tenantsFile)));
    try {
      const attempt = () =>
        postRegistro(gw.baseUrl, { email: "a@b.dev", password: "x", confirm: "x", code: "bad" });
      for (let i = 0; i < 3; i++) {
        expect((await attempt()).status).toBe(403); // código malo, pero pasa el limiter
      }
      expect((await attempt()).status).toBe(429);
      // Otra IP no está limitada.
      const other = await postRegistro(
        gw.baseUrl,
        { email: "a@b.dev", password: "x", confirm: "x", code: "bad" },
        "10.9.9.9",
      );
      expect(other.status).toBe(403);
    } finally {
      await closeServer(gw.server);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
