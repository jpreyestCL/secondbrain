/**
 * Panel de cuenta (/cuenta): qué ve el usuario y qué puede cortar por sí mismo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerType } from "@hono/node-server";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer, obtainAccessToken, hiddenFields } from "./helpers.js";

const PASSWORD = "supersecret-123";
const EMAIL = "cuenta@test.dev";
const UPSTREAM = "http://127.0.0.1:9099/mcp";

let server: ServerType;
let baseUrl: string;
let tenantsFile: string;
let db: Database.Database;

async function signIn(): Promise<string> {
  const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function cuenta(cookie: string): Promise<string> {
  const res = await fetch(`${baseUrl}/cuenta`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
}

function post(
  cookie: string,
  url: string,
  fields: Record<string, string>,
  origin = baseUrl,
): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

const countSessions = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n;

beforeAll(async () => {
  tenantsFile = path.join(os.tmpdir(), `gw-cuenta-${process.pid}.json`);
  fs.writeFileSync(tenantsFile, JSON.stringify({ [EMAIL]: UPSTREAM }));
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile,
  });
  const created = createAuth(config);
  db = created.db;
  await migrate(created.auth);
  await created.auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "c" } });
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

describe("panel de cuenta", () => {
  it("sin sesión redirige a /login", async () => {
    const res = await fetch(`${baseUrl}/cuenta`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("muestra correo, upstream, sesiones y clientes autorizados", async () => {
    const cookie = await signIn();
    // Un cliente OAuth autorizado de verdad (DCR -> consentimiento -> token).
    await obtainAccessToken(baseUrl, EMAIL, PASSWORD);

    const html = await cuenta(cookie);
    expect(html).toContain(EMAIL);
    expect(html).toContain(UPSTREAM);
    expect(html).toContain("Sesiones activas");
    expect(html).toContain("test-client"); // nombre del cliente registrado
    expect(html).toContain("Revocar");
    expect(html).toContain("/export");
  });

  it("revocar un cliente borra su consentimiento y sus tokens de la base", async () => {
    const cookie = await signIn();
    await obtainAccessToken(baseUrl, EMAIL, PASSWORD);
    const clientId = (
      db
        .prepare('SELECT clientId FROM "oauthConsent" ORDER BY rowid DESC LIMIT 1')
        .get() as { clientId: string }
    ).clientId;
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM "oauthAccessToken" WHERE clientId = ?')
          .get(clientId) as { n: number }
      ).n,
    ).toBeGreaterThan(0);

    const csrf = hiddenFields(await cuenta(cookie))["csrf"]!;
    const res = await post(cookie, "/cuenta/revocar-cliente", { csrf, client_id: clientId });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/cuenta?ok=cliente-revocado");

    for (const table of ["oauthConsent", "oauthAccessToken", "oauthApplication"]) {
      const n = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE clientId = ?`)
          .get(clientId) as { n: number }
      ).n;
      expect(n).toBe(0);
    }
    expect(await cuenta(cookie)).not.toContain(clientId);
  });

  it("cerrar las demás sesiones deja solo la actual", async () => {
    const cookie = await signIn();
    await signIn();
    await signIn();
    expect(countSessions()).toBeGreaterThan(1);

    const csrf = hiddenFields(await cuenta(cookie))["csrf"]!;
    const res = await post(cookie, "/cuenta/cerrar-sesiones", { csrf });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/cuenta?ok=sesiones-cerradas");
    expect(countSessions()).toBe(1);
    // La sesión actual sigue viva.
    expect(await cuenta(cookie)).toContain("esta sesión");
  });

  it("en móvil no esconde los datos que la propia página pide revisar", async () => {
    // La página dice "si ves uno que no reconoces, ciérralos todos": para eso
    // hacen falta la hora de inicio y el User-Agent crudo, en cualquier pantalla.
    const cookie = await signIn();
    const html = await cuenta(cookie);
    expect(html).not.toMatch(/\.sesiones (th|td):nth-child\(2\)[^}]*display: none/);
    expect(html).not.toMatch(/\.sesiones td\.ua small \{ display: none/);
    // La tabla sigue siendo alcanzable: se desplaza en horizontal.
    expect(html).toContain('<div class="scroll">');
    expect(html).toContain(".scroll table { min-width:");
    // Y el User-Agent completo viaja en el HTML, no solo la etiqueta resumida.
    expect(html).toContain("<small>");
  });

  it("los POST rechazan peticiones cross-origin y tokens CSRF inválidos", async () => {
    const cookie = await signIn();
    const csrf = hiddenFields(await cuenta(cookie))["csrf"]!;

    const crossOrigin = await post(
      cookie,
      "/cuenta/cerrar-sesiones",
      { csrf },
      "https://evil.example.com",
    );
    expect(crossOrigin.status).toBe(403);

    const badToken = await post(cookie, "/cuenta/cerrar-sesiones", { csrf: "0".repeat(64) });
    expect(badToken.status).toBe(403);

    const noOrigin = await fetch(`${baseUrl}/cuenta/cerrar-sesiones`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
    });
    expect(noOrigin.status).toBe(403);
  });
});
