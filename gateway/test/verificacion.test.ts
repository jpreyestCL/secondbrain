/**
 * Verificación de correo de punta a punta: el alta manda el correo, el enlace
 * marca `emailVerified`, los enlaces rotos o caducados se explican, el reenvío
 * funciona y está limitado, y —lo que más importa con el dominio de Resend
 * todavía pendiente— un fallo de correo NO rompe el registro.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ServerType } from "@hono/node-server";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { resetDeliveries } from "../src/mailer.js";
import {
  listen,
  closeServer,
  fakeMailer,
  fakeProvisioner,
  urlInMail,
  onTestServer,
  type FakeMailer,
} from "./helpers.js";

const SECRET = "test-secret-test-secret-test-secret-0000";
const PASSWORD = "clave-larga-123";

let server: ServerType;
let baseUrl: string;
let db: Database.Database;
let mailer: FakeMailer;
let tenantsFile: string;

async function registrar(email: string, ip = "10.9.0.1"): Promise<Response> {
  return fetch(`${baseUrl}/registro`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": ip,
    },
    body: new URLSearchParams({ email, password: PASSWORD, confirm: PASSWORD }),
  });
}

const verifiedFlag = (email: string): number =>
  (
    db.prepare('SELECT emailVerified AS v FROM "user" WHERE email = ?').get(email) as
      | { v: number }
      | undefined
  )?.v ?? -1;

/** Sigue el enlace del correo contra el servidor de pruebas. */
async function abrirEnlace(url: string): Promise<Response> {
  const res = await fetch(onTestServer(url, baseUrl), { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) return res;
  const next = location.startsWith("http") ? new URL(location) : new URL(location, baseUrl);
  return fetch(`${baseUrl}${next.pathname}${next.search}`);
}

beforeAll(async () => {
  tenantsFile = path.join(os.tmpdir(), `gw-verif-${process.pid}.json`);
  fs.writeFileSync(tenantsFile, "{}");
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: SECRET,
    baseUrl: "https://mybrain.rlz.cl",
    tenantsFile,
    registrationMode: "open",
    registrationCode: "",
    maxTenants: 50,
    mailRateLimit: 3,
    emailVerificationExpiresIn: 24 * 60 * 60,
  });
  mailer = fakeMailer();
  const created = createAuth(config, { mailer });
  db = created.db;
  await migrate(created.auth);
  const app = buildApp(
    created.auth,
    config,
    created.db,
    createTenantRegistry(tenantsFile),
    fakeProvisioner(),
  );
  const listener = await listen(app);
  server = listener.server;
  baseUrl = listener.baseUrl;
});

afterAll(async () => {
  await closeServer(server);
  fs.rmSync(tenantsFile, { force: true });
});

beforeEach(() => {
  mailer.fail = false;
  mailer.clear();
});

describe("alta y correo de verificación", () => {
  it("el alta envía un correo en español con el enlace del gateway", async () => {
    const email = "ana@ejemplo.cl";
    const res = await registrar(email);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Cuenta creada");
    expect(html).toContain("Te enviamos un correo");

    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.last()!;
    expect(mail.to).toBe(email);
    expect(mail.subject).toContain("Confirma tu correo");
    // Motivo explícito + salida para quien no pidió nada.
    expect(mail.text).toContain("alguien creó una cuenta en mybrain.rlz.cl");
    expect(mail.text).toContain("ignora este mensaje");
    expect(mail.html).toContain("alguien creó una cuenta en <strong>mybrain.rlz.cl</strong>");
    // Ambas partes, y el enlace apunta al gateway con callback propio.
    const url = urlInMail(mail.text);
    expect(url).toContain("https://mybrain.rlz.cl/api/auth/verify-email?token=");
    expect(decodeURIComponent(url)).toContain("callbackURL=/verificado");
    expect(mail.html).toContain(url.replace(/&/g, "&amp;"));

    expect(verifiedFlag(email)).toBe(0);
  });

  it("el enlace marca emailVerified y muestra la página de cuenta lista", async () => {
    const email = "bruno@ejemplo.cl";
    await registrar(email, "10.9.0.2");
    const url = urlInMail(mailer.last()!.text);

    const res = await abrirEnlace(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Correo verificado");
    expect(html).toContain('href="/cuenta"');
    expect(html).toContain('href="/guia"');
    expect(verifiedFlag(email)).toBe(1);
  });

  it("un token inválido muestra un error claro, no un stacktrace", async () => {
    const res = await abrirEnlace(
      "https://mybrain.rlz.cl/api/auth/verify-email?token=basura&callbackURL=%2Fverificado",
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("No pudimos verificar tu correo");
    expect(html).toContain("El enlace no es válido");
  });

  it("un token caducado se distingue del inválido", async () => {
    const email = "caducado@ejemplo.cl";
    await registrar(email, "10.9.0.3");
    // Mismo formato que Better Auth (HS256 sobre AUTH_SECRET) pero ya vencido.
    const expired = await new SignJWT({ email })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(SECRET));

    const res = await abrirEnlace(
      `https://mybrain.rlz.cl/api/auth/verify-email?token=${expired}&callbackURL=%2Fverificado`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("El enlace caducó");
    expect(verifiedFlag(email)).toBe(0);
  });
});

describe("reenvío de la verificación", () => {
  it("reenvía a una cuenta pendiente y responde en neutro", async () => {
    const email = "carla@ejemplo.cl";
    await registrar(email, "10.9.1.1");
    mailer.clear();

    const res = await fetch(`${baseUrl}/reenviar-verificacion`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "10.9.1.2",
      },
      body: new URLSearchParams({ email }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Si esa dirección tiene una cuenta sin verificar");
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.last()!.to).toBe(email);
  });

  it("una dirección desconocida da la MISMA respuesta y no manda nada", async () => {
    const res = await fetch(`${baseUrl}/reenviar-verificacion`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "10.9.1.3",
      },
      body: new URLSearchParams({ email: "nadie@ejemplo.cl" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Si esa dirección tiene una cuenta sin verificar");
    expect(mailer.sent).toHaveLength(0);
  });

  it("está limitado por IP (MAIL_RATE_LIMIT)", async () => {
    const ip = "10.9.2.9";
    const call = () =>
      fetch(`${baseUrl}/reenviar-verificacion`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-forwarded-for": ip,
        },
        body: new URLSearchParams({ email: "nadie@ejemplo.cl" }),
      });
    // mailRateLimit = 3 en la config de este archivo.
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const cuarto = await call();
    expect(cuarto.status).toBe(429);
  });
});

describe("/cuenta muestra el estado de verificación", () => {
  async function cookieDe(email: string): Promise<string> {
    const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    return login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  it("pendiente: avisa y ofrece reenviar; verificado: lo dice y quita el botón", async () => {
    const email = "dora@ejemplo.cl";
    await registrar(email, "10.9.3.1");
    const cookie = await cookieDe(email);

    const pendiente = await fetch(`${baseUrl}/cuenta`, { headers: { cookie } });
    const htmlPendiente = await pendiente.text();
    expect(htmlPendiente).toContain("pendiente");
    expect(htmlPendiente).toContain("/cuenta/reenviar-verificacion");
    expect(htmlPendiente).toContain("Reenviar verificación");

    // El botón del panel manda el correo y avisa del resultado.
    const csrf = /name="csrf" value="([^"]+)"/.exec(htmlPendiente)?.[1] ?? "";
    mailer.clear();
    const reenvio = await fetch(`${baseUrl}/cuenta/reenviar-verificacion`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: baseUrl,
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "10.9.3.2",
      },
      body: new URLSearchParams({ csrf }),
    });
    expect(reenvio.status).toBe(302);
    expect(reenvio.headers.get("location")).toBe("/cuenta?ok=verificacion-enviada");
    expect(mailer.sent).toHaveLength(1);

    // Se verifica con el enlace y el panel cambia de estado.
    await abrirEnlace(urlInMail(mailer.last()!.text));
    const verificado = await fetch(`${baseUrl}/cuenta`, { headers: { cookie } });
    const htmlVerificado = await verificado.text();
    expect(htmlVerificado).toContain("verificado");
    expect(htmlVerificado).not.toContain("/cuenta/reenviar-verificacion");
  });
});

describe("degradación cuando el correo falla", () => {
  it("el registro crea cuenta y tenant, y muestra 'verificación pendiente'", async () => {
    mailer.fail = true; // Resend rechaza: dominio sin verificar
    const email = "elena@ejemplo.cl";
    const res = await registrar(email, "10.9.4.1");

    // NO es un 500: la cuenta existe, el tenant también, y se explica.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Cuenta creada");
    expect(html).toContain("Verificación pendiente");
    expect(html).toContain('action="/reenviar-verificacion"');

    // El tenant aprovisionado NO se pierde por un fallo de correo.
    const registry = JSON.parse(fs.readFileSync(tenantsFile, "utf8")) as Record<string, string>;
    expect(registry[email]).toBe("http://127.0.0.1:9099/mcp");
    expect(verifiedFlag(email)).toBe(0);

    // Y la cuenta sirve: se puede iniciar sesión con ella.
    const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
  });
});

describe("sin RESEND_API_KEY (correo deshabilitado)", () => {
  let server2: ServerType;
  let base2: string;
  let tenants2: string;

  beforeAll(async () => {
    resetDeliveries();
    tenants2 = path.join(os.tmpdir(), `gw-verif-off-${process.pid}.json`);
    fs.writeFileSync(tenants2, "{}");
    const config = loadConfig({
      dbPath: ":memory:",
      authSecret: SECRET,
      baseUrl: "https://mybrain.rlz.cl",
      tenantsFile: tenants2,
      registrationMode: "open",
      registrationCode: "",
      maxTenants: 50,
      // Sin clave y sin modo debug => mailer real, deshabilitado.
      resendApiKey: "",
      mailDebug: false,
    });
    const created = createAuth(config); // mailer REAL (deshabilitado)
    await migrate(created.auth);
    const app = buildApp(
      created.auth,
      config,
      created.db,
      createTenantRegistry(tenants2),
      fakeProvisioner("http://127.0.0.1:9098/mcp"),
    );
    const listener = await listen(app);
    server2 = listener.server;
    base2 = listener.baseUrl;
  });

  afterAll(async () => {
    await closeServer(server2);
    fs.rmSync(tenants2, { force: true });
  });

  it("el registro sigue creando cuenta + tenant y muestra la página de pendiente", async () => {
    const email = "sinclave@ejemplo.cl";
    const res = await fetch(`${base2}/registro`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "10.9.5.1",
      },
      body: new URLSearchParams({ email, password: PASSWORD, confirm: PASSWORD }),
    });
    expect(res.status).toBe(200); // nunca 500
    const html = await res.text();
    expect(html).toContain("Cuenta creada");
    expect(html).toContain("Verificación pendiente");

    const registry = JSON.parse(fs.readFileSync(tenants2, "utf8")) as Record<string, string>;
    expect(registry[email]).toBe("http://127.0.0.1:9098/mcp");

    const login = await fetch(`${base2}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
  });
});
