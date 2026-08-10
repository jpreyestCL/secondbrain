/**
 * Shell común del dashboard: el `<head>`, el bloque CSS y la barra de
 * navegación superior que comparten /cuenta y /guia.
 *
 * Antes cada página traía su propia copia del mismo CSS (mismos tokens, mismos
 * espaciados, mismo acento) y su propio rastro de enlaces "← Tu cuenta / Inicio"
 * al pie de la primera sección. Aquí queda una sola fuente de verdad: las
 * páginas producen solo su contenido interno y este módulo lo envuelve.
 *
 * /guia es PÚBLICA: cuando no hay sesión la barra muestra «Iniciar sesión» en
 * vez del correo y del botón de cerrar sesión, pero el resto del shell es
 * idéntico.
 */
import { escapeHtml } from "./html.js";
import { CSRF_FIELD } from "./csrf.js";

/** Secciones del dashboard, en el orden en que salen en la barra. */
export type DashboardSection = "cuenta" | "guia" | "export";

const NAV: Array<{ id: DashboardSection; href: string; label: string }> = [
  { id: "cuenta", href: "/cuenta", label: "Cuenta" },
  { id: "guia", href: "/guia", label: "Guía" },
  { id: "export", href: "/export", label: "Exportar" },
];

export interface DashboardSessionView {
  email: string;
  /** Token CSRF de la sesión actual (para el POST de cerrar sesión). */
  csrf: string;
}

export interface DashboardShellOptions {
  /** Título de la pestaña (se le antepone "Second Brain — "). */
  title: string;
  /** Sección activa en la barra de navegación. */
  active: DashboardSection;
  /** Sesión del navegador, o null si la página se ve sin iniciar sesión. */
  session: DashboardSessionView | null;
  /** HTML del contenido (una o más `<section>`), ya escapado por quien lo genera. */
  body: string;
}

/**
 * CSS único del dashboard. Es la unión literal de lo que /cuenta y /guia tenían
 * duplicado (mismos colores, radios y tamaños) más lo mínimo para la barra.
 */
const STYLE = `
  :root { color-scheme: light dark; --accent: #4f46e5; --danger: #b91c1c; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f5f5f4; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } }

  /* --- Barra superior --- */
  .topbar { background: Canvas; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); position: sticky; top: 0; z-index: 10; }
  .topbar-inner { width: min(94vw, 48rem); margin-inline: auto; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; padding: .7rem 0; }
  .brand { font-weight: 700; font-size: .95rem; text-decoration: none; color: inherit; white-space: nowrap; }
  .nav { display: flex; flex-wrap: wrap; gap: .2rem .4rem; margin-right: auto; }
  .nav a { font-size: .88rem; text-decoration: none; color: inherit; opacity: .7; padding: .3rem .6rem; border-radius: 999px; white-space: nowrap; }
  .nav a:hover { opacity: 1; background: color-mix(in srgb, CanvasText 8%, transparent); }
  .nav a[aria-current="page"] { opacity: 1; font-weight: 600; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .session { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; font-size: .82rem; }
  .session .who { opacity: .7; overflow-wrap: anywhere; }
  .session form { margin: 0; }
  .linkbtn { font: inherit; font-size: .82rem; font-weight: 600; background: transparent; color: var(--accent); border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); border-radius: 999px; padding: .25rem .7rem; cursor: pointer; text-decoration: none; display: inline-block; white-space: nowrap; }
  .linkbtn:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }

  /* --- Contenido --- */
  main { width: min(94vw, 48rem); margin-inline: auto; display: grid; gap: 1.2rem; padding: 1.5rem 0 2.5rem; }
  section { background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; padding: 1.5rem; display: grid; gap: .8rem; }
  h1 { font-size: 1.3rem; margin: 0; }
  h2 { font-size: 1rem; margin: 0; }
  h3 { font-size: .92rem; margin: .4rem 0 0; }
  p { margin: 0; }
  ul, ol { margin: 0; padding-left: 1.2rem; display: grid; gap: .35rem; font-size: .92rem; }
  .muted { font-size: .85rem; opacity: .7; }
  .notice { border-left: 3px solid var(--accent); padding: .5rem .7rem; background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 4px; font-size: .9rem; }
  .warn { border-left: 3px solid var(--danger); padding: .6rem .8rem; background: color-mix(in srgb, var(--danger) 12%, transparent); border-radius: 4px; font-size: .9rem; font-weight: 600; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: .3rem .8rem; font-size: .92rem; }
  dt { font-weight: 600; } dd { margin: 0; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); vertical-align: top; }
  td.ua { max-width: 16rem; overflow-wrap: anywhere; opacity: .7; }
  td.params { opacity: .75; overflow-wrap: anywhere; }
  .tag { font-size: .7rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 999px; padding: 0 .4rem; }
  .item { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: .7rem .9rem; }
  button { font: inherit; font-weight: 600; padding: .5rem .9rem; border: 0; border-radius: 8px; background: var(--accent); color: white; cursor: pointer; }
  button.danger { background: var(--danger); }
  a.btn { display: inline-block; font-weight: 600; padding: .5rem .9rem; border-radius: 8px; background: var(--accent); color: #fff; text-decoration: none; }
  .scroll { overflow-x: auto; }
  pre { margin: 0; overflow-x: auto; background: color-mix(in srgb, CanvasText 7%, transparent); border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: .8rem .9rem; font-size: .8rem; line-height: 1.5; }
  pre code { font-size: inherit; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; overflow-wrap: anywhere; }
  .quote { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: .55rem .7rem; }
  .toc { display: flex; flex-wrap: wrap; gap: .4rem .9rem; font-size: .88rem; }
  a { color: var(--accent); }
  :target { scroll-margin-top: 4rem; }

  /* En móvil la barra se apila en dos líneas en vez de desbordar. */
  @media (max-width: 34rem) {
    .topbar-inner { gap: .4rem .6rem; }
    .brand { width: 100%; }
    .nav a { padding: .3rem .5rem; }
    .session { width: 100%; justify-content: flex-start; }
  }
`;

function navHtml(active: DashboardSection): string {
  return NAV.map((item) => {
    const current = item.id === active ? ' aria-current="page"' : "";
    return `<a href="${item.href}"${current}>${item.label}</a>`;
  }).join("\n      ");
}

function sessionHtml(session: DashboardSessionView | null): string {
  if (!session) {
    return `<div class="session"><a class="linkbtn" href="/login">Iniciar sesión</a></div>`;
  }
  return `<div class="session">
      <span class="who">${escapeHtml(session.email)}</span>
      <form method="post" action="/cuenta/cerrar-sesion">
        <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(session.csrf)}">
        <button type="submit" class="linkbtn">Cerrar sesión</button>
      </form>
    </div>`;
}

/** Envuelve el contenido de una página del dashboard en el shell compartido. */
export function dashboardShell(opts: DashboardShellOptions): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Second Brain — ${escapeHtml(opts.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">Second Brain</a>
    <nav class="nav" aria-label="Secciones">
      ${navHtml(opts.active)}
    </nav>
    ${sessionHtml(opts.session)}
  </div>
</header>
<main>
${opts.body}
</main>
</body>
</html>`;
}
