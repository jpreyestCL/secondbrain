/**
 * Cromo compartido de /login, /registro y la pantalla de consentimiento.
 *
 * Las tres traían el mismo CSS copiado y ninguna leía el tema elegido en la
 * landing o en el panel: el recorrido de alta parpadeaba entre dos identidades.
 */
import { describe, it, expect } from "vitest";
import { loginPageHtml } from "../src/login-page.js";
import { registroPageHtml } from "../src/registro-page.js";
import { consentPageHtml } from "../src/consent-page.js";
import { AUTH_STYLE } from "../src/auth-chrome.js";

const PAGES: Array<[string, string]> = [
  ["login", loginPageHtml({ showRegisterLink: true, showGoogle: true })],
  ["registro", registroPageHtml({ mode: "open" })],
  [
    "consentimiento",
    consentPageHtml({
      clientName: "Claude",
      redirectOrigin: "https://claude.ai",
      userEmail: "a@b.dev",
      scopes: ["openid"],
      csrf: "c".repeat(64),
      params: {},
    }),
  ],
];

describe("cromo de las páginas de autenticación", () => {
  it("las tres aplican el tema guardado ANTES de pintar", () => {
    for (const [name, html] of PAGES) {
      expect(html, name).toContain('localStorage.getItem("sb-theme")');
      expect(html, name).toContain('document.documentElement.setAttribute("data-theme", t)');
      // El guion va en el <head>, delante del <style>: si corriera después se
      // vería un destello del tema contrario.
      expect(html.indexOf("sb-theme"), name).toBeLessThan(html.indexOf("<style>"));
    }
  });

  it("las tres comparten un único bloque de estilos, el mismo del módulo", () => {
    for (const [name, html] of PAGES) {
      expect(html.match(/<style>/g)?.length, name).toBe(1);
      expect(html, name).toContain(AUTH_STYLE);
    }
  });

  it("el estilo responde a data-theme, no solo a la preferencia del sistema", () => {
    expect(AUTH_STYLE).toContain('[data-theme="dark"]');
    expect(AUTH_STYLE).toContain('[data-theme="light"]');
    expect(AUTH_STYLE).toContain("@media (prefers-color-scheme: dark)");
    // Y el navegador pinta sus superficies acorde en los tres estados.
    expect(AUTH_STYLE).toContain("color-scheme: light dark;");
    expect(AUTH_STYLE).toContain("color-scheme: dark;");
    expect(AUTH_STYLE).toContain("color-scheme: light;");
  });

  it("usa la paleta del archivo, no el índigo que arrastraban las tres copias", () => {
    for (const [name, html] of PAGES) {
      expect(html, name).not.toContain("#4f46e5");
      expect(html, name).not.toContain("#f5f5f4");
      expect(html, name).not.toContain("#1c1917");
    }
    expect(AUTH_STYLE).toContain("--accent: #1d7364");
  });

  it("no carga nada de un tercero", () => {
    for (const [name, html] of PAGES) {
      expect(html, name).not.toContain("@import");
      expect(html, name).not.toMatch(/url\(\s*["']?https?:/);
      expect(html, name).not.toMatch(/<script[^>]+src=/);
    }
  });
});
