/**
 * Shell compartido del dashboard: /cuenta y /guia se renderizan dentro del
 * MISMO layout (una sola copia del CSS), con la sección activa marcada y la
 * barra cambiando según haya sesión o no.
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
import { cuentaPageHtml } from "../src/cuenta-page.js";
import { guiaPageHtml } from "../src/guia-page.js";
import { listen, closeServer, hiddenFields } from "./helpers.js";

const PASSWORD = "supersecret-123";
const EMAIL = "shell@test.dev";
const UPSTREAM = "http://127.0.0.1:9099/mcp";

let server: ServerType;
let baseUrl: string;
let tenantsFile: string;

async function signIn(): Promise<string> {
  const login = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  return login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

beforeAll(async () => {
  tenantsFile = path.join(os.tmpdir(), `gw-shell-${process.pid}.json`);
  fs.writeFileSync(tenantsFile, JSON.stringify({ [EMAIL]: UPSTREAM }));
  const config = loadConfig({
    dbPath: ":memory:",
    authSecret: "test-secret-test-secret-test-secret-0000",
    baseUrl: "http://127.0.0.1:8787",
    tenantsFile,
  });
  const created = createAuth(config);
  await migrate(created.auth);
  await created.auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "s" } });
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

const CUENTA = cuentaPageHtml({
  email: EMAIL,
  upstream: UPSTREAM,
  sessions: [],
  clients: [],
  csrf: "c".repeat(64),
});

describe("shell del dashboard", () => {
  it("las dos páginas comparten el mismo bloque de estilos (una sola fuente)", () => {
    const guia = guiaPageHtml();
    const styleOf = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(styleOf(CUENTA).length).toBeGreaterThan(500);
    expect(styleOf(guia)).toBe(styleOf(CUENTA));
    // Y cada página trae UN solo <style>: nada de CSS duplicado por página.
    expect(CUENTA.match(/<style>/g)?.length).toBe(1);
    expect(guia.match(/<style>/g)?.length).toBe(1);
  });

  it("la barra trae las tres secciones y marca la activa en cada página", () => {
    for (const html of [CUENTA, guiaPageHtml()]) {
      for (const [href, label] of [
        ["/cuenta", "Cuenta"],
        ["/guia", "Guía"],
        ["/export", "Exportar"],
      ]) {
        expect(html).toContain(`href="${href}"`);
        expect(html).toContain(`>${label}</a>`);
      }
    }
    expect(CUENTA).toContain('<a href="/cuenta" aria-current="page">Cuenta</a>');
    expect(CUENTA).not.toContain('<a href="/guia" aria-current="page">');
    const guia = guiaPageHtml();
    expect(guia).toContain('<a href="/guia" aria-current="page">Guía</a>');
    expect(guia).not.toContain('<a href="/cuenta" aria-current="page">');
  });

  it("con sesión la barra muestra el correo y el POST de cerrar sesión", () => {
    expect(CUENTA).toContain(EMAIL);
    expect(CUENTA).toContain('action="/cuenta/cerrar-sesion"');
    expect(CUENTA).toContain("Cerrar sesión");
    expect(CUENTA).not.toContain("Iniciar sesión");
  });

  it("sin sesión la barra muestra «Iniciar sesión» y ninguna acción de cuenta", () => {
    const anon = guiaPageHtml();
    expect(anon).toContain('href="/login"');
    expect(anon).toContain("Iniciar sesión");
    expect(anon).not.toContain("Cerrar sesión");
    expect(anon).not.toContain('action="/cuenta/cerrar-sesion"');
  });

  it("la barra no desborda en móvil (envuelve y tiene su media query)", () => {
    expect(CUENTA).toContain(".topbar-inner { width: min(94vw, 62rem)");
    expect(CUENTA).toMatch(/\.topbar-inner \{[^}]*flex-wrap: wrap/);
    expect(CUENTA).toMatch(/\.nav \{[^}]*flex-wrap: wrap/);
    expect(CUENTA).toContain("@media (max-width: 34rem)");
  });

  it("las dos páginas comparten el script del shell (una sola fuente)", () => {
    const guia = guiaPageHtml();
    // El shell emite dos <script>: el que fija el tema antes de pintar (en el
    // <head>) y el de comportamiento (al final del <body>).
    for (const html of [CUENTA, guia]) {
      expect(html).toContain('localStorage.setItem("sb-theme", next)');
      expect(html).toContain('aria-label="Cambiar entre tema claro y oscuro"');
    }
    expect(guia.match(/<script>/g)?.length).toBe(2);
    // /cuenta añade UNO propio: es la única con buscador, y la búsqueda tarda
    // segundos contra el servidor, así que necesita avisar que está trabajando.
    expect(CUENTA.match(/<script>/g)?.length).toBe(3);
    expect(CUENTA).toContain("data-buscando");
  });

  it("no carga nada de un tercero: sin fuentes, scripts ni imágenes remotas", () => {
    for (const html of [CUENTA, guiaPageHtml()]) {
      expect(html).not.toContain("@import");
      expect(html).not.toMatch(/url\(\s*["']?https?:/);
      expect(html).not.toMatch(/<script[^>]+src=/);
    }
  });

  it("el contenido visible al cargar no espera al observador y respeta reduced-motion", () => {
    expect(CUENTA).toContain("box.top < window.innerHeight && box.bottom > 0");
    expect(CUENTA).toContain(".js section { opacity: 0;");
    expect(CUENTA).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.js section \{ opacity: 1/);
  });

  it("el índice de la guía cuelga de <main>, no de una sección (si no, no se pega)", () => {
    const guia = guiaPageHtml();
    // Un elemento pegajoso se ancla a su bloque contenedor: dentro de
    // section.head solo tenía 1.6rem de recorrido antes de despegarse.
    expect(guia).toMatch(/<\/section>\s*<nav class="toc"/);
    expect(guia).not.toMatch(/<nav class="toc"[\s\S]*?<\/nav>\s*<\/section>/);
    expect(guia).toContain(".toc { position: sticky;");
  });

  it("declara color-scheme para que las barras de scroll sigan al tema", () => {
    // /cuenta siempre trae barra horizontal en móvil (.scroll table min-width).
    expect(CUENTA).toContain("color-scheme: light dark;");
    expect(CUENTA).toContain('[data-theme="dark"] { color-scheme: dark; }');
    expect(CUENTA).toContain("color-scheme: light;");
  });

  it("el botón de copiar solo se esconde donde hay hover que lo revele", () => {
    // En táctil quedaría invisible pero pulsable, encima del bloque scrollable.
    expect(CUENTA).toContain("@media (hover: hover) {");
    expect(CUENTA).toMatch(/@media \(hover: hover\) \{\s*\.block \.copy \{ opacity: 0; \}/);
    expect(CUENTA).not.toMatch(/\n  \.block \.copy \{[^}]*opacity: 0/);
    // Y no se solapa con la primera línea del código.
    expect(CUENTA).toContain(".block pre { padding-right:");
  });

  it("/guia es pública y se sirve dentro del shell sin sesión", async () => {
    const res = await fetch(`${baseUrl}/guia`, { redirect: "manual" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Iniciar sesión");
    expect(html).toContain('<a href="/guia" aria-current="page">');
    expect(html).not.toContain("Cerrar sesión");
  });

  it("/guia con sesión muestra el correo y permite cerrar sesión", async () => {
    const cookie = await signIn();
    const html = await (await fetch(`${baseUrl}/guia`, { headers: { cookie } })).text();
    expect(html).toContain(EMAIL);
    expect(html).toContain('action="/cuenta/cerrar-sesion"');
    expect(html).not.toContain("Iniciar sesión");
  });

  it("cerrar sesión (POST con CSRF) invalida la cookie y redirige a /", async () => {
    const cookie = await signIn();
    const guia = await (await fetch(`${baseUrl}/guia`, { headers: { cookie } })).text();
    const csrf = hiddenFields(guia)["csrf"]!;

    const res = await fetch(`${baseUrl}/cuenta/cerrar-sesion`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: baseUrl, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    // La sesión ya no sirve: /cuenta vuelve a mandar al login.
    const after = await fetch(`${baseUrl}/cuenta`, { headers: { cookie }, redirect: "manual" });
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe("/login");
  });

  it("cerrar sesión rechaza cross-origin y tokens CSRF inválidos", async () => {
    const cookie = await signIn();
    const guia = await (await fetch(`${baseUrl}/guia`, { headers: { cookie } })).text();
    const csrf = hiddenFields(guia)["csrf"]!;

    const cross = await fetch(`${baseUrl}/cuenta/cerrar-sesion`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        origin: "https://evil.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf }),
    });
    expect(cross.status).toBe(403);

    const bad = await fetch(`${baseUrl}/cuenta/cerrar-sesion`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: baseUrl, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: "0".repeat(64) }),
    });
    expect(bad.status).toBe(403);

    // Y la sesión sigue viva tras los intentos fallidos.
    const still = await fetch(`${baseUrl}/cuenta`, { headers: { cookie }, redirect: "manual" });
    expect(still.status).toBe(200);
  });
});
