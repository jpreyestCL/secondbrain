/** Elección de idioma: query > cookie > Accept-Language > español. */
import { describe, it, expect } from "vitest";

import { idiomaDe, traductor, urlOtroIdioma, selectorIdioma } from "../src/i18n.js";

describe("idiomaDe", () => {
  it("la URL manda sobre todo lo demás", () => {
    expect(idiomaDe({ query: "en", cookie: "es", acceptLanguage: "es-CL" })).toBe("en");
  });

  it("sin query, manda la cookie", () => {
    expect(idiomaDe({ cookie: "en", acceptLanguage: "es-CL,es;q=0.9" })).toBe("en");
  });

  it("sin cookie, se mira el navegador", () => {
    expect(idiomaDe({ acceptLanguage: "en-US,en;q=0.9" })).toBe("en");
    expect(idiomaDe({ acceptLanguage: "es-CL,es;q=0.9,en;q=0.8" })).toBe("es");
  });

  it("un idioma que no ofrecemos cae al español", () => {
    expect(idiomaDe({ acceptLanguage: "fr-FR,de;q=0.9" })).toBe("es");
    expect(idiomaDe({ query: "pt" })).toBe("es");
    expect(idiomaDe({})).toBe("es");
  });
});

describe("traductor", () => {
  const textos = {
    titulo: { es: "Tu memoria", en: "Your memory" },
    soloEs: { es: "Sin traducir", en: "" },
  } as const;

  it("devuelve el texto del idioma pedido", () => {
    expect(traductor(textos, "en")("titulo")).toBe("Your memory");
    expect(traductor(textos, "es")("titulo")).toBe("Tu memoria");
  });

  it("una traducción vacía cae al español en vez de dejar un hueco", () => {
    // Una página a medio traducir es más útil que una con espacios en blanco.
    expect(traductor(textos, "en")("soloEs")).toBe("Sin traducir");
  });

  it("una clave inexistente se ve, no rompe la página", () => {
    expect(traductor(textos, "en")("noExiste" as "titulo")).toBe("noExiste");
  });
});

describe("cambio de idioma", () => {
  it("conserva el resto de la URL", () => {
    // Perder la búsqueda al cambiar de idioma hace que nadie use el selector.
    const url = urlOtroIdioma("/cuenta?q=cuenta+bancaria&entidad=u-1", "es");
    expect(url).toContain("q=cuenta+bancaria");
    expect(url).toContain("entidad=u-1");
    expect(url).toContain("lang=en");
    expect(url.startsWith("/cuenta?")).toBe(true);
  });

  it("reemplaza el lang anterior en vez de acumularlo", () => {
    const url = urlOtroIdioma("/guia?lang=en", "en");
    expect(url.match(/lang=/g)?.length).toBe(1);
    expect(url).toContain("lang=es");
  });

  it("el selector ofrece el OTRO idioma, no el actual", () => {
    expect(selectorIdioma("/guia", "es")).toContain(">English<");
    expect(selectorIdioma("/guia", "en")).toContain(">Español<");
    expect(selectorIdioma("/guia", "es")).toContain('hreflang="en"');
  });
});
