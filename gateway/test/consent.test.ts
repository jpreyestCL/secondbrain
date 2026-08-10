/**
 * Pantalla de consentimiento propia del gateway.
 *
 * El plugin MCP de Better Auth deja la decisión de pedir consentimiento en
 * manos del cliente (`prompt=consent`). Estas pruebas fijan el comportamiento
 * contrario: sin una aprobación explícita del dueño NO sale ningún `code`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerType } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer, hiddenFields } from "./helpers.js";

const PASSWORD = "supersecret-123";
const EMAIL = "consent@test.dev";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

let server: ServerType;
let baseUrl: string;
let tenantsFile: string;
let cookie: string;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  tenantsFile = path.join(os.tmpdir(), `gw-consent-${process.pid}.json`);
  fs.writeFileSync(tenantsFile, JSON.stringify({ [EMAIL]: "http://127.0.0.1:1/mcp" }));
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

  const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});

afterAll(async () => {
  await closeServer(server);
  fs.rmSync(tenantsFile, { force: true });
});

async function registerClient(name: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string): string {
  const verifier = randomBytes(32).toString("base64url");
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    state: "st-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
}

const authorize = (clientId: string) =>
  fetch(`${baseUrl}/api/auth/mcp/authorize?${authorizeQuery(clientId)}`, {
    redirect: "manual",
    headers: { cookie },
  });

const decide = (fields: Record<string, string>, decision: string, origin = baseUrl) =>
  fetch(`${baseUrl}/consentimiento`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie,
      origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ...fields, decision }),
  });

describe("pantalla de consentimiento propia", () => {
  it("el primer authorize muestra la pantalla y NO emite ningún code", async () => {
    const clientId = await registerClient("cliente-uno");
    const res = await authorize(clientId);

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("¿Autorizar el acceso a tu memoria?");
    expect(html).toContain("leer y escribir toda tu");
    expect(html).toContain("cliente-uno");
    expect(html).toContain("https://claude.ai");
    expect(html).toContain("Autorizar");
    expect(html).toContain("Cancelar");
    expect(html).not.toContain("code=");
    // Y no quedó ningún código de autorización guardado.
    const verifications = db.prepare('SELECT COUNT(*) AS n FROM "verification"').get() as {
      n: number;
    };
    expect(verifications.n).toBe(0);
  });

  it("al autorizar se emite el code y el segundo authorize ya no pregunta", async () => {
    const clientId = await registerClient("cliente-dos");
    const first = await authorize(clientId);
    expect(first.status).toBe(200);
    const fields = hiddenFields(await first.text());

    const posted = await decide(fields, "autorizar");
    expect(posted.status).toBe(302);
    const next = posted.headers.get("location") ?? "";
    expect(next).toContain("/api/auth/mcp/authorize");

    const authz = await fetch(`${baseUrl}${next}`, { redirect: "manual", headers: { cookie } });
    const location = authz.headers.get("location") ?? "";
    expect(location.startsWith(REDIRECT_URI)).toBe(true);
    expect(new URL(location).searchParams.get("code")).toBeTruthy();
    expect(new URL(location).searchParams.get("state")).toBe("st-1");

    // Quedó registrado el consentimiento para (usuario, cliente).
    const consent = db
      .prepare('SELECT consentGiven FROM "oauthConsent" WHERE clientId = ?')
      .get(clientId) as { consentGiven: number } | undefined;
    expect(consent?.consentGiven).toBeTruthy();

    // Segunda conexión del MISMO cliente: sin pantalla, code directo.
    const second = await authorize(clientId);
    expect(second.status).toBe(302);
    const secondLocation = second.headers.get("location") ?? "";
    expect(secondLocation.startsWith(REDIRECT_URI)).toBe(true);
    expect(new URL(secondLocation).searchParams.get("code")).toBeTruthy();
  });

  it("cancelar devuelve al cliente con error=access_denied y sin code", async () => {
    const clientId = await registerClient("cliente-tres");
    const first = await authorize(clientId);
    const fields = hiddenFields(await first.text());

    const posted = await decide(fields, "cancelar");
    expect(posted.status).toBe(302);
    const location = new URL(posted.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("st-1");
    expect(location.searchParams.get("code")).toBeNull();

    // No se guardó consentimiento: la próxima vez vuelve a preguntar.
    const again = await authorize(clientId);
    expect(again.status).toBe(200);
  });

  it("rechaza la decisión enviada desde otro origen (CSRF)", async () => {
    const clientId = await registerClient("cliente-cuatro");
    const first = await authorize(clientId);
    const fields = hiddenFields(await first.text());

    const posted = await decide(fields, "autorizar", "https://evil.example.com");
    expect(posted.status).toBe(403);
  });

  it("rechaza la decisión con un token CSRF inválido", async () => {
    const clientId = await registerClient("cliente-cinco");
    const first = await authorize(clientId);
    const fields = { ...hiddenFields(await first.text()), csrf: "0".repeat(64) };

    const posted = await decide(fields, "autorizar");
    expect(posted.status).toBe(403);
  });

  it("sin sesión no muestra la pantalla: sigue el flujo normal hacia /login", async () => {
    const clientId = await registerClient("cliente-seis");
    const res = await fetch(`${baseUrl}/api/auth/mcp/authorize?${authorizeQuery(clientId)}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/login");
  });
});
