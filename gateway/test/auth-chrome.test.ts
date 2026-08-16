/**
 * Cromo compartido de /login, /registro y la pantalla de consentimiento.
 *
 * Las tres traían el mismo CSS copiado y ninguna leía el tema elegido en la
 * landing o en el panel: el recorrido de alta parpadeaba entre dos identidades.
 */
import { describe, it, expect } from "vitest";
import { loginPageHtml } from "../src/login-page.js";
import {
  registroPageHtml,
  registroCapacidadHtml,
  registroExitoHtml,
  registroErrorProvisionHtml,
  googleSinInvitacionHtml,
} from "../src/registro-page.js";
import {
  verificadoPageHtml,
  reenvioVerificacionHtml,
  olvidePasswordHtml,
  olvidePasswordEnviadoHtml,
  restablecerPasswordHtml,
  restablecerTokenInvalidoHtml,
  restablecerOkHtml,
} from "../src/mail-pages.js";
import { consentPageHtml } from "../src/consent-page.js";
import { AUTH_STYLE, textoErrorAuth } from "../src/auth-chrome.js";

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

/**
 * Estas páginas no pasan por `dashboardShell`, así que el selector de idioma
 * vive en el cromo. Sin `idioma` la salida debe seguir siendo la de siempre.
 */
describe("idioma de las páginas de autenticación", () => {
  const enIngles = (url = "/x"): Array<[string, string]> => [
    ["login", loginPageHtml({ showRegisterLink: true, showGoogle: true, idioma: "en", url })],
    ["registro", registroPageHtml({ mode: "invite", showGoogle: true, idioma: "en", url })],
    ["registro-cerrado", registroPageHtml({ mode: "closed", idioma: "en", url })],
    ["capacidad", registroCapacidadHtml({ idioma: "en", url })],
    ["sin-invitacion", googleSinInvitacionHtml({ idioma: "en", url })],
    ["exito", registroExitoHtml("https://b.dev", "a@b.dev", "enviado", { idioma: "en", url })],
    ["provision", registroErrorProvisionHtml("a@b.dev", { idioma: "en", url })],
    ["olvide", olvidePasswordHtml({ idioma: "en", url })],
    ["olvide-enviado", olvidePasswordEnviadoHtml({ idioma: "en", url })],
    ["restablecer", restablecerPasswordHtml({ token: "t", idioma: "en", url })],
    ["token-invalido", restablecerTokenInvalidoHtml({ idioma: "en", url })],
    ["restablecida", restablecerOkHtml({ idioma: "en", url })],
    ["reenvio", reenvioVerificacionHtml({ idioma: "en", url })],
    [
      "consentimiento",
      consentPageHtml({
        clientName: "Claude",
        redirectOrigin: "https://claude.ai",
        userEmail: "a@b.dev",
        scopes: ["openid"],
        csrf: "c".repeat(64),
        params: {},
        idioma: "en",
        url,
      }),
    ],
  ];

  it("sin idioma, la salida es la de siempre: español y sin selector", () => {
    for (const [name, html] of PAGES) {
      expect(html, name).toContain('<html lang="es">');
      expect(html, name).not.toContain('class="idiomas"');
    }
  });

  it("con idioma=en, el documento va en inglés y trae el selector al español", () => {
    for (const [name, html] of enIngles()) {
      expect(html, name).toContain('<html lang="en">');
      expect(html, name).toContain('class="idiomas"');
      expect(html, name).toContain("lang=es");
      expect(html, name).toContain(">Español</a>");
    }
  });

  it("el selector vuelve a la MISMA página, no a la portada", () => {
    const html = restablecerPasswordHtml({ token: "t", idioma: "en", url: "/restablecer-password?token=t" });
    expect(html).toContain('href="/restablecer-password?');
    expect(html).toContain("lang=es");
  });

  it("en inglés no queda texto español de cara al usuario", () => {
    const marcas = [
      "Iniciar sesión",
      "Crear cuenta",
      "Contraseña",
      "Correo</label>",
      "Volver al inicio",
      "Autorizar el acceso",
      "Revisa tu correo",
      "Enlace no válido",
    ];
    for (const [name, html] of enIngles()) {
      for (const marca of marcas) expect(html, `${name}: ${marca}`).not.toContain(marca);
    }
  });

  it("el consentimiento explica en inglés QUÉ se autoriza", () => {
    const html = consentPageHtml({
      clientName: "Claude",
      redirectOrigin: "https://claude.ai",
      userEmail: "a@b.dev",
      scopes: ["openid"],
      csrf: "c".repeat(64),
      params: {},
      idioma: "en",
    });
    expect(html).toContain("read and write your entire memory");
    expect(html).toContain("Authorize");
    expect(html).toContain("Cancel");
    // Y el correo de la sesión sigue interpolado (y escapado) en la frase.
    expect(html).toContain("<strong>a@b.dev</strong>");
  });

  it("la página de verificación reenvía el idioma al shell del dashboard", () => {
    const ok = verificadoPageHtml({ session: null, idioma: "en", url: "/verificado" });
    expect(ok).toContain("Email verified");
    expect(ok).toContain("lang=es");
    const mal = verificadoPageHtml({ session: null, error: "TOKEN_EXPIRED", idioma: "en" });
    expect(mal).toContain("The link has expired.");
    expect(mal).not.toContain("El enlace caducó.");
    // Sin idioma sigue en español, como hoy.
    expect(verificadoPageHtml({ session: null, error: "TOKEN_EXPIRED" })).toContain(
      "El enlace caducó.",
    );
  });

  it("los errores de formulario se traducen por clave", () => {
    expect(textoErrorAuth("correoInvalido", "es")).toBe("Correo inválido.");
    expect(textoErrorAuth("correoInvalido", "en")).toBe("Invalid email address.");
    // La clave gana al texto literal; sin clave, se pinta el literal tal cual.
    expect(
      registroPageHtml({ mode: "open", errorClave: "passwordsNoCoinciden", idioma: "en" }),
    ).toContain("The passwords do not match.");
    expect(olvidePasswordHtml({ error: "Correo inválido." })).toContain("Correo inválido.");
  });
});
