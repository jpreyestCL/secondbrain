/**
 * Landing (/): accesibilidad y escape de los valores interpolados.
 */
import { describe, it, expect } from "vitest";
import { landingPageHtml } from "../src/landing-page.js";
import { escapeHtml } from "../src/html.js";

const html = landingPageHtml("https://mybrain.rlz.cl");

/** Contraste WCAG entre dos colores hex. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const v = [0, 2, 4]
      .map((i) => parseInt(hex.replace("#", "").substr(i, 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
  };
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("landing", () => {
  it("el botón principal no usa texto blanco sobre el acento (2.25:1 en oscuro)", () => {
    expect(html).toContain("background: var(--vigente); color: var(--on-accent)");
    expect(html).not.toContain("background: var(--vigente); color: #fff");
    // Claro: blanco sobre #1d7364. Oscuro: tinta oscura sobre #4fbfa6.
    expect(contrast("#ffffff", "#1d7364")).toBeGreaterThanOrEqual(4.5);
    // Y el propio acento sirve como color de texto sobre el papel claro.
    expect(contrast("#1d7364", "#f1eee8")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#08201c", "#4fbfa6")).toBeGreaterThanOrEqual(4.5);
  });

  it(".answer .label usa un acento legible sobre el fondo suave", () => {
    expect(html).toMatch(/\.answer \.label \{[^}]*color: var\(--accent-text\)/s);
    expect(contrast("#155a4e", "#d8ebe6")).toBeGreaterThanOrEqual(4.5); // claro
    expect(contrast("#4fbfa6", "#12312c")).toBeGreaterThanOrEqual(4.5); // oscuro
  });

  it("la respuesta del deslizador se anuncia (aria-live) y el rango no duplica su nombre", () => {
    expect(html).toContain('<div class="answer" aria-live="polite">');
    expect(html).not.toContain('aria-label="Año de la consulta"');
    expect(html).toContain('<label class="eyebrow" for="sl">Línea de tiempo</label>');
  });

  it('el tramo "Todavía no había registro" es alcanzable con el mínimo del rango', () => {
    const min = Number(/id="sl"[^>]*min="(\d+)"/.exec(html)?.[1]);
    const firstRecord = Number(/from: (\d{4}), to: 2018/.exec(html)?.[1]);
    expect(html).toContain("Todavía no había registro");
    expect(min).toBeLessThan(firstRecord);
  });

  it("enlaza al panel de cuenta", () => {
    expect(html).toContain('href="/cuenta"');
  });

  it("no depende de recursos externos: ni fuentes, ni scripts, ni imágenes de otro origen", () => {
    // La página se sirve en un dominio con CSP y debe funcionar aislada: cualquier
    // http(s):// en un atributo de carga sería una petición a un tercero.
    for (const attr of html.match(/\b(?:src|href)="([^"]*)"/g) ?? []) {
      const url = /="([^"]*)"/.exec(attr)![1]!;
      if (!/^https?:/.test(url)) continue;
      // Los enlaces de navegación a GitHub/Graphiti/FalkorDB sí son externos y válidos.
      expect(attr.startsWith('href="')).toBe(true);
    }
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/url\(\s*["']?https?:/);
  });

  it("el contenido visible al cargar no queda escondido esperando al observador", () => {
    // En una pestaña de fondo IntersectionObserver no dispara: lo que ya está en
    // pantalla debe revelarse de inmediato o el héroe se ve en blanco.
    expect(html).toContain("box.top < window.innerHeight && box.bottom > 0");
    // Y sin JavaScript nada se oculta: la regla que esconde cuelga de .js.
    expect(html).toContain(".js .rv { opacity: 0;");
  });

  it("con movimiento reducido no anima ni recorre la línea de tiempo sola", () => {
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none !important/);
    // El recorrido automático del deslizador queda tras la guarda `!reduce`.
    expect(html).toContain('var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches');
    expect(html).toContain("if (!reduce) {");
  });

  it("la dirección MCP se puede copiar y el tema se recuerda", () => {
    expect(html).toContain('<code id="mcp">');
    expect(html).toContain('id="copy"');
    expect(html).toContain('localStorage.setItem("sb-theme", next)');
    expect(html).toContain('aria-label="Cambiar entre tema claro y oscuro"');
  });

  it("el recorrido automático silencia la región aria-live mientras dura", () => {
    // Barrer el deslizador solo reescribe ~26 veces la respuesta: si la región
    // sigue anunciando, un lector de pantalla queda atrapado en la cola.
    expect(html).toContain('answerLive.setAttribute("aria-live", on ? "polite" : "off")');
    expect(html).toContain("live(false);");
    // Y se reactiva tanto al terminar como al intervenir el usuario: `stop()`
    // es el único camino de salida y siempre devuelve la voz.
    expect(html).toMatch(/function stop\(\) \{[\s\S]*?live\(true\);\n  \}/);
    expect(html).toContain("if (leg < legs.length) { tour.raf = requestAnimationFrame(step); } else { stop(); }");
  });

  it("el botón de copiar no se muestra si el navegador no puede copiar", () => {
    // En http plano navigator.clipboard no existe: antes el botón quedaba mudo.
    expect(html).toContain('id="copy" hidden');
    expect(html).toContain("if (navigator.clipboard && navigator.clipboard.writeText) {");
    expect(html).toContain("copyBtn.hidden = false;");
    // Un rechazo del permiso tampoco se traga en silencio.
    expect(html).toContain('flash("Copia a mano", false)');
  });

  it("declara color-scheme para que el navegador pinte sus superficies acorde", () => {
    expect(html).toContain("color-scheme: light dark;");
    expect(html).toContain('[data-theme="dark"] { color-scheme: dark; }');
    expect(html).toContain("color-scheme: light;");
  });

  it("las anclas no aterrizan bajo el nav pegajoso", () => {
    expect(html).toMatch(/section\[id\][^{]*\{[^}]*scroll-margin-top/);
  });

  it("la barra superior envuelve en vez de recortarse en pantallas angostas", () => {
    // body tiene overflow-x hidden: lo que desborde se pierde sin poder alcanzarlo.
    expect(html).toMatch(/nav \.wrap \{[^}]*flex-wrap: wrap/);
    expect(html).toMatch(/nav \.wrap \{[^}]*min-height: 64px/);
    expect(html).not.toMatch(/nav \.wrap \{[^}]*[^-]height: 64px/);
  });

  it("sin JavaScript el deslizador conserva su aspecto nativo", () => {
    // El eje pintado (segmentos y aguja) solo existe con JS; sin él, el control
    // debe verse como un deslizador normal y no como una barra vacía.
    expect(html).toContain(".segs, .needle { display: none; }");
    expect(html).toContain(".js .segs, .js .needle { display: block; }");
    expect(html).toMatch(/\n  \.axis input\[type=range\] \{[^}]*accent-color: var\(--vigente\)/);
    // Y las reglas que lo vuelven invisible cuelgan todas de .js.
    for (const rule of html.match(/[^\n]*input\[type=range\][^\n]*background: transparent[^\n]*/g) ?? []) {
      expect(rule.trimStart().startsWith(".js ")).toBe(true);
    }
  });

  it("escapa el baseUrl interpolado", () => {
    const evil = landingPageHtml('https://x.test/"><script>alert(1)</script>');
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain(escapeHtml('https://x.test/"><script>alert(1)</script>/mcp'));
  });
});

describe("landing bilingüe", () => {
  const en = landingPageHtml("https://mybrain.rlz.cl", "open", { idioma: "en", url: "/" });
  const es = landingPageHtml("https://mybrain.rlz.cl", "open", { idioma: "es", url: "/" });

  it("sin idioma la página sigue en español y sin selector", () => {
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("Cómo funciona");
    expect(html).not.toContain('class="idioma"');
  });

  it('con idioma "en" el documento se declara en inglés', () => {
    expect(en).toContain('<html lang="en">');
    expect(es).toContain('<html lang="es">');
  });

  it("el inglés no deja texto español a la vista", () => {
    for (const frase of [
      "Cómo funciona",
      "Qué le preguntas",
      "Tu memoria no se sobrescribe",
      "Le hablas a Claude",
      "Guarda cosas sensibles",
      "Tres pasos, una sola vez",
      "Ya tengo cuenta",
      "Todavía no había registro",
      "tu grafo",
    ]) {
      expect(en).not.toContain(frase);
    }
    for (const frase of [
      "How it works",
      "What you ask it",
      "Your memory isn't overwritten",
      "You talk to Claude",
      "It stores sensitive things",
      "Three steps, once",
      "I already have an account",
      "No record yet",
      "your graph",
    ]) {
      expect(en).toContain(frase);
    }
  });

  it("el selector de idioma va en la barra, sin JavaScript", () => {
    expect(en).toContain('<a class="idioma" href="/?lang=es"');
    expect(es).toContain('<a class="idioma" href="/?lang=en"');
    expect(en).toContain(">Español</a>");
    expect(es).toContain(">English</a>");
    // Es un enlace normal: nada de onclick ni de cambio por script.
    expect(en).not.toContain('onclick="');
  });

  it("las tres tarjetas de registro se traducen", () => {
    for (const modo of ["open", "invite", "closed"] as const) {
      const pagina = landingPageHtml("https://x.test", modo, { idioma: "en" });
      expect(pagina).not.toContain("Ya tengo cuenta");
      expect(pagina).toContain("I already have an account");
    }
    expect(landingPageHtml("https://x.test", "closed", { idioma: "en" })).toContain(
      "Signups closed for now",
    );
    expect(landingPageHtml("https://x.test", "invite", { idioma: "en" })).toContain(
      "Access is by invitation",
    );
  });

  it("los textos que usa el script van como literales JS válidos", () => {
    expect(en).toContain('stamp.textContent = active.to === null ? "current" : "archived"');
    expect(en).toContain('aval.textContent = "No record yet"');
    expect(en).toContain('flash("Copy it by hand", false)');
    expect(en).toContain('copyBtn.textContent = "Copy";');
  });

  it("no se traducen los identificadores técnicos ni la dirección MCP", () => {
    expect(en).toContain("add_memory");
    expect(en).toContain("search_memory_facts");
    expect(en).toContain("https://mybrain.rlz.cl/mcp");
    expect(en).toContain("MCP · OAuth 2.1 + PKCE");
    expect(en).toContain("Banco Santander · 789-012-345");
  });
});
