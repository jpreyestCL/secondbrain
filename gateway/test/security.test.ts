import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { createRateLimiter, clientIpFrom } from "../src/rate-limit.js";
import { hardenSecretFilePerms } from "../src/harden.js";
import { createProvisioner, redactSecrets } from "../src/provision.js";
import { proxyMcp } from "../src/proxy.js";
import { listen, closeServer, obtainAccessToken } from "./helpers.js";

const CODE = "codigo-super-secreto";
const PASSWORD = "clave-larga-123";
const SECRET = "test-secret-test-secret-test-secret-0000";

// ---------------------------------------------------------------------------
// Unidad: rate limiter y derivación de IP
// ---------------------------------------------------------------------------

describe("rate limiter", () => {
  afterEach(() => vi.useRealTimers());

  it("purges Map entries whose recent hits emptied (no unbounded growth)", () => {
    vi.useFakeTimers();
    const rl = createRateLimiter(5, 60_000);
    rl.ok("1.1.1.1");
    rl.ok("2.2.2.2");
    expect(rl.size()).toBe(2);
    vi.advanceTimersByTime(61_000);
    rl.ok("3.3.3.3"); // el sweep corre en cada hit
    expect(rl.size()).toBe(1); // 1.1.1.1 y 2.2.2.2 purgadas
  });

  it("clientIpFrom prefers cf-connecting-ip, else RIGHTMOST XFF hop, else local", () => {
    const h = (obj: Record<string, string>) => new Headers(obj);
    expect(clientIpFrom(h({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1" }))).toBe(
      "9.9.9.9",
    );
    expect(clientIpFrom(h({ "x-forwarded-for": "spoofed, 4.4.4.4, 8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIpFrom(h({}))).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// HTTP: gateway compartido para las pruebas de integración
// ---------------------------------------------------------------------------

let servers: ServerType[] = [];
let tmpRoot: string;
let baseUrl: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gw-security-"));
  fs.mkdirSync(path.join(tmpRoot, "infra", "tenants"), { recursive: true });
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: SECRET,
    baseUrl: "https://brain.example.com",
    tenantsFile: path.join(tmpRoot, "tenants.json"),
    registrationCode: CODE,
    brainRepoRoot: tmpRoot,
    provisionCmd: "true",
    registroRateLimit: 2,
    dcrRateLimit: 3,
  });
  const { auth, db } = createAuth(config);
  await migrate(auth);
  const gw = await listen(buildApp(auth, config, db, createTenantRegistry(config.tenantsFile)));
  servers.push(gw.server);
  baseUrl = gw.baseUrl;
});

afterAll(async () => {
  await Promise.all(servers.map(closeServer));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function postRegistro(xff: string): Promise<Response> {
  return fetch(`${baseUrl}/registro`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": xff,
    },
    body: new URLSearchParams({ email: "a@b.dev", password: "x", confirm: "x", code: "bad" }),
  });
}

describe("rate limit por IP de confianza (finding 1)", () => {
  it("spoofed differing LEFTMOST XFF values still share the trusted-hop bucket", async () => {
    // límite = 2/min; el atacante varía el primer valor de XFF pero el último
    // salto (agregado por el proxy de confianza) es el mismo.
    expect((await postRegistro("11.11.11.11, 7.7.7.7")).status).toBe(403);
    expect((await postRegistro("22.22.22.22, 7.7.7.7")).status).toBe(403);
    expect((await postRegistro("33.33.33.33, 7.7.7.7")).status).toBe(429);
    // Otra IP real (otro último salto) no está limitada.
    expect((await postRegistro("33.33.33.33, 7.7.7.8")).status).toBe(403);
  });
});

describe("rate limit del DCR /api/auth/mcp/register (finding 2)", () => {
  const dcr = (xff?: string) =>
    fetch(`${baseUrl}/api/auth/mcp/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(xff ? { "X-Forwarded-For": xff } : {}),
      },
      body: JSON.stringify({
        client_name: "flood-client",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });

  it("returns 429 after the per-IP cap", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await dcr("6.6.6.6");
      expect(res.status).toBeLessThan(400);
    }
    const blocked = await dcr("6.6.6.6");
    expect(blocked.status).toBe(429);
  });

  it("a normal single OAuth flow still succeeds", async () => {
    // Registro de usuario + flujo OAuth completo desde otra IP ("local").
    const email = "flujo-normal@test.dev";
    const reg = await fetch(`${baseUrl}/registro`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password: PASSWORD, confirm: PASSWORD, code: CODE }),
    });
    expect(reg.status).toBe(200);
    const token = await obtainAccessToken(baseUrl, email, PASSWORD);
    expect(token).toBeTruthy();
  });
});

describe("cabeceras de seguridad (finding 6)", () => {
  it("/login and /registro responses carry the headers", async () => {
    for (const route of ["/login", "/registro"]) {
      const res = await fetch(`${baseUrl}${route}`);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      // Petición http directa sin proxy => sin HSTS.
      expect(res.headers.get("strict-transport-security")).toBeNull();
    }
  });

  it("adds Strict-Transport-Security when behind an https proxy", async () => {
    const res = await fetch(`${baseUrl}/login`, {
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });
});

// ---------------------------------------------------------------------------
// Permisos de archivos con secretos (finding 3)
// ---------------------------------------------------------------------------

describe("permisos de archivos con secretos", () => {
  it("chmods auth.sqlite (+wal/shm), tenants.json and gateway.log to 0600 on boot", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-perms-"));
    try {
      const dbPath = path.join(tmp, "auth.sqlite");
      const tenantsFile = path.join(tmp, "tenants.json");
      const logPath = path.join(tmp, "gateway.log");
      const config = loadConfig({
        dbPath,
        authSecret: SECRET,
        tenantsFile,
        brainRepoRoot: tmp,
      });
      const { auth, db } = createAuth(config);
      await migrate(auth);
      fs.writeFileSync(tenantsFile, "{}", { mode: 0o644 });
      fs.writeFileSync(logPath, "log\n", { mode: 0o644 });
      fs.chmodSync(dbPath, 0o644); // simular un despliegue previo laxo

      hardenSecretFilePerms(config, logPath);

      expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(tenantsFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
      db.close();
      void auth;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Provisión: liberación de reservas y redacción de secretos (findings 4 y 8)
// ---------------------------------------------------------------------------

describe("provisioner", () => {
  it("releases slug/port reservations when the command fails, so the next registration reuses them", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-prov-"));
    try {
      const tenantsDir = path.join(tmp, "infra", "tenants");
      fs.mkdirSync(tenantsDir, { recursive: true });
      const marker = path.join(tmp, "already-failed");
      const stub = path.join(tmp, "stub.sh");
      // Falla la PRIMERA vez (sin escribir el .env); después funciona.
      fs.writeFileSync(
        stub,
        `#!/usr/bin/env bash
set -euo pipefail
if [ ! -f "${marker}" ]; then touch "${marker}"; echo "boom" >&2; exit 1; fi
printf 'TENANT_NAME=%s\\nMCP_PORT=%s\\n' "$1" "$2" > "${tenantsDir}/$1.env"
`,
        { mode: 0o755 },
      );
      const config = loadConfig({
        authSecret: SECRET,
        brainRepoRoot: tmp,
        provisionCmd: `bash ${stub} {slug} {port}`,
        tenantPortBase: 9500,
      });
      const provisioner = createProvisioner(config);

      await expect(provisioner.provision("eva@test.dev")).rejects.toThrow(/PROVISION_CMD/);
      // La reserva se liberó: el reintento reutiliza el MISMO slug y puerto.
      const result = await provisioner.provision("eva@test.dev");
      expect(result.slug).toBe("eva"); // no "eva-2"
      expect(result.port).toBe(9500); // no 9501
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("redacts PASSWORD/SECRET/KEY values from captured output before logging", async () => {
    expect(redactSecrets("FALKORDB_TENANT_PASSWORD=abc123 done")).toBe(
      "FALKORDB_TENANT_PASSWORD=[REDACTED] done",
    );
    expect(redactSecrets("AUTH_SECRET=s3cr3t\nAPI_KEY=xyz\nPORT=9000")).toBe(
      "AUTH_SECRET=[REDACTED]\nAPI_KEY=[REDACTED]\nPORT=9000",
    );

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gw-redact-"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const tenantsDir = path.join(tmp, "infra", "tenants");
      fs.mkdirSync(tenantsDir, { recursive: true });
      const stub = path.join(tmp, "stub.sh");
      fs.writeFileSync(
        stub,
        `#!/usr/bin/env bash
echo "FALKORDB_TENANT_PASSWORD=abc"
printf 'TENANT_NAME=%s\\nMCP_PORT=%s\\n' "$1" "$2" > "${tenantsDir}/$1.env"
`,
        { mode: 0o755 },
      );
      const config = loadConfig({
        authSecret: SECRET,
        brainRepoRoot: tmp,
        provisionCmd: `bash ${stub} {slug} {port}`,
        tenantPortBase: 9600,
      });
      await createProvisioner(config).provision("leak@test.dev");
      const logged = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(logged).toContain("FALKORDB_TENANT_PASSWORD=[REDACTED]");
      expect(logged).not.toContain("FALKORDB_TENANT_PASSWORD=abc");
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Proxy: no reenviar accept-encoding al upstream (finding 7)
// ---------------------------------------------------------------------------

describe("proxy /mcp", () => {
  it("does not forward the client accept-encoding header to the upstream", async () => {
    let received: Record<string, string | undefined> | null = null;
    const upstream = new Hono();
    upstream.post("/mcp", (c) => {
      received = { "accept-encoding": c.req.header("accept-encoding") };
      return c.json({ jsonrpc: "2.0", id: 1, result: {} });
    });
    const up = await listen(upstream);
    try {
      const req = new Request("http://gateway.local/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Accept-Encoding": "br-marker-no-reenviar",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const res = await proxyMcp(`${up.baseUrl}/mcp`, req);
      expect(res.status).toBe(200);
      expect(received).not.toBeNull();
      // El valor del cliente jamás llega al upstream (undici negocia el suyo).
      expect(received!["accept-encoding"] ?? "").not.toContain("br-marker-no-reenviar");
    } finally {
      await closeServer(up.server);
    }
  });
});
