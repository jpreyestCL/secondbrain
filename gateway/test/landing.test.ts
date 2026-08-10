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
    // Claro: blanco sobre #1f7a6b. Oscuro: tinta oscura sobre #4fbfa6.
    expect(contrast("#ffffff", "#1f7a6b")).toBeGreaterThanOrEqual(4.5);
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

  it("escapa el baseUrl interpolado", () => {
    const evil = landingPageHtml('https://x.test/"><script>alert(1)</script>');
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain(escapeHtml('https://x.test/"><script>alert(1)</script>/mcp'));
  });
});
