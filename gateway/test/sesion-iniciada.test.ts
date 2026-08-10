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
    tenantsFile: path.join(os.tmpdir(), `gw-sesion-${process.pid}.json`),
  });
  const { auth, db } = createAuth(config);
  await migrate(auth);
  const app = buildApp(auth, config, db, createTenantRegistry(config.tenantsFile));
  ({ server, baseUrl } = await listen(app));
});

afterAll(async () => {
  await closeServer(server);
});

describe("página de sesión iniciada", () => {
  it("sin sesión redirige al login", async () => {
    const res = await fetch(`${baseUrl}/sesion-iniciada`, { redirect: "manual" });
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("no es texto suelto: trae estilos y acciones", async () => {
    // Regresión: antes /post-google devolvía un <p> sin estilo, que era lo
    // primero que veía alguien al conectar su conector.
    const { sesionIniciadaHtml } = await import("../src/sesion-iniciada-page.js");
    const html = sesionIniciadaHtml({ email: "quien@example.com" });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<style>");
    expect(html).toContain("Ya puedes cerrar esta pestaña");
    expect(html).toContain("quien@example.com");
    expect(html).toContain('href="/guia#conectar"');
    expect(html).toContain('href="/cuenta"');
    expect(html).not.toContain('style="font-family:system-ui"');
  });

  it("avisa cuando el correo está pendiente de verificar", async () => {
    const { sesionIniciadaHtml } = await import("../src/sesion-iniciada-page.js");
    const html = sesionIniciadaHtml({ email: "x@example.com", pendienteVerificacion: true });
    expect(html).toMatch(/confirmar tu dirección/i);
  });

  it("escapa el correo (defensa ante HTML en el valor)", async () => {
    const { sesionIniciadaHtml } = await import("../src/sesion-iniciada-page.js");
    const html = sesionIniciadaHtml({ email: '<img src=x onerror=alert(1)>@e.com' });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
