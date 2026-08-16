/**
 * Idioma de las páginas públicas.
 *
 * El sitio nació en español y esa sigue siendo la lengua por defecto: es la del
 * dueño y la de la mayoría de sus documentos. El inglés existe porque el repo es
 * público y la instancia también.
 *
 * Cómo se elige, en orden:
 *   1. `?lang=en` en la URL — gana siempre, y deja cookie para que el resto de
 *      la navegación siga en ese idioma sin arrastrar el parámetro.
 *   2. La cookie `sb-lang`.
 *   3. `Accept-Language` del navegador.
 *   4. Español.
 *
 * Sin JavaScript: el selector son dos enlaces normales. Una página que solo
 * cambia de idioma con JS deja fuera a los buscadores y a quien lo tenga
 * desactivado, y aquí no hay nada que lo justifique.
 */

export type Idioma = "es" | "en";

export const IDIOMAS: Idioma[] = ["es", "en"];
export const IDIOMA_POR_DEFECTO: Idioma = "es";
export const COOKIE_IDIOMA = "sb-lang";

export function esIdioma(v: unknown): v is Idioma {
  return v === "es" || v === "en";
}

/**
 * Resuelve el idioma de una petición.
 *
 * `Accept-Language` se lee de forma deliberadamente simple: basta con detectar
 * si el usuario prefiere inglés por encima del español. Implementar la
 * negociación completa con `q=` no aporta nada con dos idiomas.
 */
export function idiomaDe(opts: {
  query?: string | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Idioma {
  if (esIdioma(opts.query)) return opts.query;
  if (esIdioma(opts.cookie)) return opts.cookie;

  const cabecera = (opts.acceptLanguage ?? "").toLowerCase();
  if (cabecera) {
    const primero = cabecera
      .split(",")
      .map((p) => p.trim().split(";")[0])
      .find((p) => p.startsWith("es") || p.startsWith("en"));
    if (primero?.startsWith("en")) return "en";
    if (primero?.startsWith("es")) return "es";
  }
  return IDIOMA_POR_DEFECTO;
}

/** Diccionario de una página: cada clave lleva su texto en los dos idiomas. */
export type Textos<K extends string> = Record<K, Record<Idioma, string>>;

/** Devuelve una función `t(clave)` ya fijada al idioma. */
export function traductor<K extends string>(textos: Textos<K>, idioma: Idioma) {
  return (clave: K): string => {
    const entrada = textos[clave];
    if (!entrada) return clave; // clave inexistente: se ve, no se rompe
    // Si falta la traducción se cae al español antes que dejar un hueco: una
    // página a medio traducir es más útil que una en blanco. Se comprueba que
    // no esté VACÍA, no solo que exista: una cadena vacía es el estado normal
    // de una clave todavía sin traducir, y `??` no la atrapa.
    return entrada[idioma] || entrada[IDIOMA_POR_DEFECTO] || clave;
  };
}

/**
 * Enlace al mismo sitio en el otro idioma, conservando el resto de la URL.
 *
 * Se conserva la query (búsqueda, entidad) para que cambiar de idioma no te
 * saque de donde estabas — perder la búsqueda al cambiar el idioma es la clase
 * de detalle que hace que nadie use el selector.
 */
export function urlOtroIdioma(url: string, actual: Idioma): string {
  const otro: Idioma = actual === "es" ? "en" : "es";
  try {
    const u = new URL(url, "http://interno");
    u.searchParams.set("lang", otro);
    return u.pathname + "?" + u.searchParams.toString();
  } catch {
    return `?lang=${otro}`;
  }
}

/** Marcado del selector. Dos enlaces, sin JavaScript. */
export function selectorIdioma(url: string, actual: Idioma): string {
  const otro: Idioma = actual === "es" ? "en" : "es";
  const etiqueta = otro === "en" ? "English" : "Español";
  const titulo = otro === "en" ? "Read this page in English" : "Ver esta página en español";
  return (
    `<a class="idioma" href="${urlOtroIdioma(url, actual)}" hreflang="${otro}" ` +
    `title="${titulo}" rel="alternate">${etiqueta}</a>`
  );
}
