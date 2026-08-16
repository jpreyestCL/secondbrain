/**
 * El cableado del idioma en `server.ts`.
 *
 * Las plantillas ya aceptaban `idioma`, pero eso no sirve de nada si las rutas
 * no se lo pasan: la página se renderiza en español con un selector que
 * promete inglés. Estas pruebas van por HTTP contra la app real, que es el
 * único sitio donde se ve si el cable está puesto.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ServerType } from "@hono/node-server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/env.js";
import { createAuth, migrate } from "../src/auth.js";
import { buildApp } from "../src/server.js";
import { createTenantRegistry } from "../src/tenants.js";
import { listen, closeServer } from "./helpers.js";

let server: ServerType;
let baseUrl: string;
let tenantsFile: string;

beforeAll(async () => {
  tenantsFile = path.join(os.tmpdir(), `gw-i18n-${process.pid}.json`);
  fs.writeFileSync(tenantsFile, JSON.stringify({}));
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile,
    registrationMode: "open",
  });
  const created = createAuth(config);
  await migrate(created.auth);
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

/** Palabras que solo aparecen si la página se quedó en español. */
const DELATORAS = ["Iniciar sesión", "Crear cuenta", "Contraseña", "Correo electrónico"];

describe("cableado del idioma en las rutas", () => {
  const publicas = ["/", "/login", "/registro", "/guia", "/olvide-password"];

  it("todas las páginas públicas responden en inglés con ?lang=en", async () => {
    for (const ruta of publicas) {
      const res = await fetch(`${baseUrl}${ruta}?lang=en`);
      expect(res.status, `${ruta} respondió ${res.status}`).toBe(200);
      const html = await res.text();
      expect(html, `${ruta} no declara lang="en"`).toContain('<html lang="en"');
      for (const palabra of DELATORAS) {
        expect(html, `${ruta} se quedó en español: "${palabra}"`).not.toContain(palabra);
      }
    }
  });

  it("sin ?lang siguen en español", async () => {
    for (const ruta of publicas) {
      const html = await (await fetch(`${baseUrl}${ruta}`)).text();
      expect(html, `${ruta} no declara lang="es"`).toContain('<html lang="es"');
    }
  });

  it("el selector aparece en todas y apunta al otro idioma", async () => {
    for (const ruta of publicas) {
      const html = await (await fetch(`${baseUrl}${ruta}`)).text();
      expect(html, `${ruta} no pinta el selector`).toContain('class="idioma"');
      expect(html, `${ruta} no enlaza al inglés`).toContain("lang=en");
    }
  });

  it("la cookie mantiene el idioma al navegar sin ?lang", async () => {
    // Sin esto, cambiar de idioma dura una sola página y el selector parece roto.
    const primera = await fetch(`${baseUrl}/registro?lang=en`);
    const cookie = primera.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie).toContain("sb-lang=en");

    const segunda = await fetch(`${baseUrl}/login`, { headers: { cookie } });
    expect(await segunda.text()).toContain('<html lang="en"');
  });

  it("los mensajes de error del registro se traducen", async () => {
    // Vivían como literales en español dentro de server.ts: la página estaba
    // traducida pero el error salía en español encima.
    const res = await fetch(`${baseUrl}/registro?lang=en`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "no-es-un-correo", password: "x", confirm: "y" }),
    });
    const html = await res.text();
    expect(res.status).toBe(400);
    expect(html).not.toContain("Correo inválido");
    expect(html.toLowerCase()).toContain("invalid email");
  });

  it("cambiar de idioma conserva la query", async () => {
    const html = await (await fetch(`${baseUrl}/guia?seccion=masiva`)).text();
    expect(html).toMatch(/href="\/guia\?[^"]*seccion=masiva/);
  });
});
