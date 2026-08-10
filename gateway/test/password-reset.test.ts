/**
 * Recuperación de contraseña de punta a punta. Antes de esto, quien olvidaba su
 * contraseña NO tenía ninguna salida: ni formulario, ni correo, ni ruta.
 *
 * Se comprueba el camino feliz completo (pedir -> correo -> token -> contraseña
 * nueva -> entrar con ella, y la vieja ya no sirve), que la respuesta sea
 * NEUTRA para no enumerar cuentas, que los enlaces rotos se expliquen y que el
 * formulario esté limitado por IP.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { ServerType } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import type { Auth } from "../src/auth.js";
import {
  listen,
  closeServer,
  fakeMailer,
  fakeProvisioner,
  urlInMail,
  onTestServer,
  type FakeMailer,
} from "./helpers.js";

const EMAIL = "olvidadiza@ejemplo.cl";
const VIEJA = "contrasena-vieja-1";
const NUEVA = "contrasena-nueva-2";

let server: ServerType;
let baseUrl: string;
let auth: Auth;
let mailer: FakeMailer;
let tenantsFile: string;

function form(url: string, fields: Record<string, string>, ip: string): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": ip,
    },
    body: new URLSearchParams(fields),
  });
}

async function signIn(password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });
}

/**
 * Sigue el enlace del correo: /api/auth/reset-password/:token redirige al
 * formulario con ?token=… . Devuelve el token que llega a la página.
 */
async function tokenDesdeEnlace(url: string): Promise<string> {
  const res = await fetch(onTestServer(url, baseUrl), { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = res.headers.get("location") ?? "";
  const target = location.startsWith("http") ? new URL(location) : new URL(location, baseUrl);
  expect(target.pathname).toBe("/restablecer-password");
  return target.searchParams.get("token") ?? "";
}

beforeAll(async () => {
  tenantsFile = path.join(os.tmpdir(), `gw-reset-${process.pid}.json`);
  fs.writeFileSync(tenantsFile, "{}");
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-1111",
    baseUrl: "https://mybrain.rlz.cl",
    tenantsFile,
    registrationMode: "open",
    registrationCode: "",
    mailRateLimit: 4,
    passwordResetExpiresIn: 3600,
  });
  mailer = fakeMailer();
  const created = createAuth(config, { mailer });
  auth = created.auth;
  await migrate(auth);
  const app = buildApp(
    auth,
    config,
    created.db,
    createTenantRegistry(tenantsFile),
    fakeProvisioner(),
  );
  const listener = await listen(app);
  server = listener.server;
  baseUrl = listener.baseUrl;

  await auth.api.signUpEmail({
    body: { email: EMAIL, password: VIEJA, name: "olvidadiza" },
  });
});

afterAll(async () => {
  await closeServer(server);
  fs.rmSync(tenantsFile, { force: true });
});

beforeEach(() => {
  mailer.fail = false;
  mailer.clear();
});

describe("/olvide-password", () => {
  it("muestra el formulario en español y se enlaza desde /login", async () => {
    const page = await fetch(`${baseUrl}/olvide-password`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Recuperar contraseña");
    expect(html).toContain('action="/olvide-password"');

    const login = await fetch(`${baseUrl}/login`);
    expect(await login.text()).toContain('href="/olvide-password"');
  });

  it("responde en neutro a una dirección desconocida y no manda correo", async () => {
    const res = await form("/olvide-password", { email: "nadie@ejemplo.cl" }, "10.5.0.1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Si esa dirección tiene una cuenta");
    expect(mailer.sent).toHaveLength(0);
  });

  it("rechaza un correo mal formado sin gastar un envío", async () => {
    const res = await form("/olvide-password", { email: "no-es-un-correo" }, "10.5.0.2");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Correo inválido.");
    expect(mailer.sent).toHaveLength(0);
  });

  it("está limitado por IP", async () => {
    const ip = "10.5.9.9";
    for (let i = 0; i < 4; i += 1) {
      expect((await form("/olvide-password", { email: "nadie@ejemplo.cl" }, ip)).status).toBe(
        200,
      );
    }
    expect((await form("/olvide-password", { email: "nadie@ejemplo.cl" }, ip)).status).toBe(429);
  });
});

describe("enlaces de recuperación rotos", () => {
  it("sin token, la página lo dice en vez de mostrar un formulario inútil", async () => {
    const res = await fetch(`${baseUrl}/restablecer-password`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Ese enlace ya no sirve");
  });

  it("con ?error=INVALID_TOKEN (lo que manda Better Auth) también", async () => {
    const res = await fetch(`${baseUrl}/restablecer-password?error=INVALID_TOKEN`);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Ese enlace ya no sirve");
  });

  it("un token inventado no cambia ninguna contraseña", async () => {
    const res = await form(
      "/restablecer-password",
      { token: "token-inventado", password: NUEVA, confirm: NUEVA },
      "10.5.1.1",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Ese enlace ya no sirve");
    expect((await signIn(VIEJA)).status).toBe(200);
  });
});

describe("camino feliz completo", () => {
  it("pedir -> correo -> token -> contraseña nueva -> entrar con ella", async () => {
    // 1. La persona pide el enlace.
    const pedido = await form("/olvide-password", { email: EMAIL }, "10.5.2.1");
    expect(pedido.status).toBe(200);
    expect(await pedido.text()).toContain("Revisa tu correo");

    // 2. Llega un correo en español, con HTML y texto, y con el motivo.
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.last()!;
    expect(mail.to).toBe(EMAIL);
    expect(mail.subject).toContain("Restablece tu contraseña");
    expect(mail.text).toContain("Recibes este correo porque alguien pidió restablecer");
    expect(mail.text).toContain("ignora este mensaje");
    expect(mail.html).toContain("Restablece tu contraseña");

    // 3. El enlace lleva al formulario con el token.
    const url = urlInMail(mail.text);
    expect(url).toContain("/api/auth/reset-password/");
    const token = await tokenDesdeEnlace(url);
    expect(token.length).toBeGreaterThan(10);

    const formulario = await fetch(`${baseUrl}/restablecer-password?token=${token}`);
    expect(formulario.status).toBe(200);
    const formHtml = await formulario.text();
    expect(formHtml).toContain("Elige una contraseña nueva");
    expect(formHtml).toContain(`value="${token}"`);

    // 4. Contraseñas que no coinciden o demasiado cortas no pasan.
    const corta = await form(
      "/restablecer-password",
      { token, password: "corta", confirm: "corta" },
      "10.5.2.2",
    );
    expect(corta.status).toBe(400);
    expect(await corta.text()).toContain("al menos 10 caracteres");

    const distinta = await form(
      "/restablecer-password",
      { token, password: NUEVA, confirm: `${NUEVA}x` },
      "10.5.2.3",
    );
    expect(distinta.status).toBe(400);
    expect(await distinta.text()).toContain("no coinciden");

    // 5. Se guarda la nueva.
    const guardado = await form(
      "/restablecer-password",
      { token, password: NUEVA, confirm: NUEVA },
      "10.5.2.4",
    );
    expect(guardado.status).toBe(200);
    expect(await guardado.text()).toContain("Contraseña actualizada");

    // 6. La nueva funciona y la vieja ya no.
    expect((await signIn(NUEVA)).status).toBe(200);
    expect((await signIn(VIEJA)).status).toBe(401);

    // 7. El token es de un solo uso.
    const reuso = await form(
      "/restablecer-password",
      { token, password: `${NUEVA}-otra`, confirm: `${NUEVA}-otra` },
      "10.5.2.5",
    );
    expect(reuso.status).toBe(400);
    expect(await reuso.text()).toContain("Ese enlace ya no sirve");
    expect((await signIn(NUEVA)).status).toBe(200);
  });

  it("si el envío falla, la respuesta sigue siendo neutra (sin 500)", async () => {
    mailer.fail = true;
    const res = await form("/olvide-password", { email: EMAIL }, "10.5.3.1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Revisa tu correo");
  });
});
