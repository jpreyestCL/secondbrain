/**
 * Shell común del dashboard: el `<head>`, el bloque CSS, el script y la barra
 * de navegación superior que comparten /cuenta y /guia.
 *
 * Antes cada página traía su propia copia del mismo CSS (mismos tokens, mismos
 * espaciados, mismo acento) y su propio rastro de enlaces "← Tu cuenta / Inicio"
 * al pie de la primera sección. Aquí queda una sola fuente de verdad: las
 * páginas producen solo su contenido interno y este módulo lo envuelve.
 *
 * El lenguaje visual es el mismo de la landing (papel, tinta, serif de estilo
 * antiguo, monoespaciada para los datos, verde "vigente" y sepia "histórico"),
 * para que entrar a tu cuenta no se sienta como cambiar de producto.
 *
 * /guia es PÚBLICA: cuando no hay sesión la barra muestra «Iniciar sesión» en
 * vez del correo y del botón de salir, pero el resto del shell es idéntico.
 */
import { selectorIdioma, type Idioma } from "./i18n.js";
import { CONSTELACION_CSS } from "./constelacion.js";
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
  /** Idioma actual y URL de la petición, para el selector. Omitido = sin selector. */
  idioma?: Idioma;
  /** URL de la petición, para poder volver aquí en el otro idioma. */
  url?: string;
}

/** Grano analógico: el mismo SVG embebido de la landing, sin peticiones externas. */
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E" +
  "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E" +
  "%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E";

/**
 * CSS único del dashboard: lo comparten /cuenta y /guia sin excepción (el test
 * `dashboard-layout` comprueba que ambas páginas emitan exactamente el mismo
 * bloque, una sola vez cada una).
 */
const STYLE = `
  :root {
    /* El navegador pinta sus propias superficies (barras de desplazamiento, el
       lienzo antes de aplicar el CSS) según esto: sin declararlo, forzar el tema
       oscuro deja barras claras sobre una página negra. Y las tablas de /cuenta
       siempre traen barra horizontal en pantallas angostas. */
    color-scheme: light dark;
    --paper: #f1eee8; --surface: #fbf9f5; --surface-2: #eae5dc; --line: #d7d1c6; --line-soft: #e4dfd5;
    --text: #16201f; --muted: #5d6763;
    --accent: #1d7364; --accent-soft: #d8ebe6; --accent-text: #155a4e; --on-accent: #ffffff;
    --danger: #9c3b30; --danger-soft: #f2ddd9;
    --histo: #a8836b; --histo-soft: #ece2da;
    --grain: .30;
    --shadow: 0 1px 2px rgba(16,21,31,.05), 0 18px 44px -26px rgba(16,21,31,.45);
    --display: "Iowan Old Style", "Hoefler Text", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --ease: cubic-bezier(.16, 1, .3, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0a0f0f; --surface: #111817; --surface-2: #18211f; --line: #26312e; --line-soft: #1e2725;
      --text: #e7ece9; --muted: #93a29c;
      --accent: #4fbfa6; --accent-soft: #12312c; --accent-text: #4fbfa6; --on-accent: #08201c;
      --danger: #e08476; --danger-soft: #2e1a17;
      --histo: #c2a189; --histo-soft: #2a2119;
      --grain: .22;
      --shadow: 0 1px 2px rgba(0,0,0,.5), 0 24px 50px -28px rgba(0,0,0,.9);
    }
  }
  :root[data-theme="dark"] {
    --paper: #0a0f0f; --surface: #111817; --surface-2: #18211f; --line: #26312e; --line-soft: #1e2725;
    --text: #e7ece9; --muted: #93a29c;
    --accent: #4fbfa6; --accent-soft: #12312c; --accent-text: #4fbfa6; --on-accent: #08201c;
    --danger: #e08476; --danger-soft: #2e1a17;
    --histo: #c2a189; --histo-soft: #2a2119;
    --grain: .22;
    --shadow: 0 1px 2px rgba(0,0,0,.5), 0 24px 50px -28px rgba(0,0,0,.9);
  }
  :root[data-theme="dark"] { color-scheme: dark; }
  :root[data-theme="light"] {
    color-scheme: light;
    --paper: #f1eee8; --surface: #fbf9f5; --surface-2: #eae5dc; --line: #d7d1c6; --line-soft: #e4dfd5;
    --text: #16201f; --muted: #5d6763;
    --accent: #1d7364; --accent-soft: #d8ebe6; --accent-text: #155a4e; --on-accent: #ffffff;
    --danger: #9c3b30; --danger-soft: #f2ddd9;
    --histo: #a8836b; --histo-soft: #ece2da;
    --grain: .30;
    --shadow: 0 1px 2px rgba(16,21,31,.05), 0 18px 44px -26px rgba(16,21,31,.45);
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--paper); color: var(--text);
    font-family: var(--display); font-size: 16.5px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  body::after {
    content: ""; position: fixed; inset: 0; z-index: 90; pointer-events: none;
    background-image: url("${GRAIN}"); opacity: var(--grain); mix-blend-mode: soft-light;
  }
  ::selection { background: var(--accent); color: var(--on-accent); }
  a { color: var(--accent); }
  a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px; }

  /* --- Progreso de lectura --- */
  .progress { position: fixed; inset: 0 auto auto 0; height: 2px; width: 0; background: var(--accent); z-index: 60; transition: width .1s linear; }

  /* --- Barra superior --- */
  .topbar { background: color-mix(in srgb, var(--paper) 88%, transparent); backdrop-filter: blur(10px) saturate(1.2); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 50; }
  .topbar-inner { width: min(94vw, 62rem); margin-inline: auto; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1.1rem; padding: .75rem 0; }
  .brand { font-size: 1.08rem; letter-spacing: -.01em; text-decoration: none; color: inherit; white-space: nowrap; display: inline-flex; align-items: baseline; gap: .45rem; }
  .brand::after { content: "archivo"; font-family: var(--mono); font-size: .58rem; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); }
  .nav { display: flex; flex-wrap: wrap; gap: .2rem .1rem; margin-right: auto; font-family: var(--sans); }
  .nav a { position: relative; font-size: .86rem; text-decoration: none; color: var(--muted); padding: .3rem .7rem; white-space: nowrap; transition: color .2s ease; }
  .nav a::after { content: ""; position: absolute; left: .7rem; right: .7rem; bottom: .05rem; height: 1px; background: var(--accent); transform: scaleX(0); transform-origin: left; transition: transform .35s var(--ease); }
  .nav a:hover { color: var(--text); }
  .nav a:hover::after { transform: scaleX(1); }
  .nav a[aria-current="page"] { color: var(--accent); }
  .nav a[aria-current="page"]::after { transform: scaleX(1); }
  .session { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .7rem; font-size: .8rem; }
  .session .who { font-family: var(--mono); font-size: .72rem; color: var(--muted); overflow-wrap: anywhere; }
  .session form { margin: 0; }
  .linkbtn { font-family: var(--sans); font-size: .76rem; letter-spacing: .04em; background: transparent; color: var(--muted); border: 1px solid var(--line); border-radius: 2px; padding: .3rem .7rem; cursor: pointer; text-decoration: none; display: inline-block; white-space: nowrap; transition: color .2s, border-color .2s; }
  .linkbtn:hover { color: var(--accent); border-color: var(--accent); }
  .theme { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border: 1px solid var(--line); border-radius: 50%; background: transparent; color: var(--muted); cursor: pointer; transition: color .2s, border-color .2s, transform .25s var(--ease); }
  .theme:hover { color: var(--accent); border-color: var(--accent); transform: rotate(-18deg); }
  .theme svg { width: 14px; height: 14px; }
  .theme .moon { display: none; }
  @media (prefers-color-scheme: dark) { .theme .moon { display: block; } .theme .sun { display: none; } }
  :root[data-theme="dark"] .theme .moon { display: block; }
  :root[data-theme="dark"] .theme .sun { display: none; }
  :root[data-theme="light"] .theme .sun { display: block; }
  :root[data-theme="light"] .theme .moon { display: none; }

  /* --- Contenido --- */
  main { width: min(94vw, 62rem); margin-inline: auto; display: grid; gap: 1.1rem; padding: 1.8rem 0 4rem; }
  section { position: relative; background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 1.7rem 1.8rem; display: grid; gap: .85rem; }
  @media (max-width: 34rem) { section { padding: 1.3rem 1.1rem; } }
  .js section { opacity: 0; transform: translateY(14px); }
  .js section.in { opacity: 1; transform: none; transition: opacity .6s var(--ease), transform .6s var(--ease); }

  /* Portada de la página: sin marco, tipografía grande, regla fina abajo. */
  section.head { background: transparent; border: 0; border-radius: 0; padding: .6rem 0 1.6rem; gap: .7rem; border-bottom: 1px solid var(--line); }
  h1 { font-size: clamp(2rem, 5vw, 2.9rem); line-height: 1.04; letter-spacing: -.022em; font-weight: 400; margin: 0; text-wrap: balance; }
  h2 { font-size: 1.35rem; line-height: 1.2; letter-spacing: -.015em; font-weight: 400; margin: 0; }
  h3 { font-size: 1rem; font-weight: 600; margin: .5rem 0 0; letter-spacing: -.005em; }
  p { margin: 0; }
  .eyebrow { font-family: var(--mono); font-size: .68rem; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: .6rem; }
  .eyebrow::after { content: ""; height: 1px; flex: 1; max-width: 4rem; background: var(--line); }
  .lede { font-size: 1.02rem; color: var(--muted); max-width: 62ch; }
  .muted { font-size: .92rem; color: var(--muted); max-width: 72ch; }
  ul, ol { margin: 0; padding-left: 1.1rem; display: grid; gap: .45rem; font-size: .95rem; color: var(--muted); }
  li strong, li b { color: var(--text); font-weight: 600; }
  li::marker { color: var(--accent); }

  /* Avisos: marco completo + etiqueta, sin franja lateral. */
  .notice, .warn { position: relative; border-radius: 3px; padding: .85rem 1rem .9rem; font-size: .93rem; }
  .notice { background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent); color: var(--text); }
  .warn { background: var(--danger-soft); border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); color: var(--text); }
  .warn::before { content: "cuidado"; font-family: var(--mono); font-size: .6rem; letter-spacing: .18em; text-transform: uppercase; color: var(--danger); display: block; margin-bottom: .35rem; }

  /* Datos de la cuenta: filas de ficha, no lista de definición apretada. */
  .plate { display: grid; gap: 0; border-top: 1px solid var(--line-soft); }
  .plate > div { display: grid; gap: .15rem .9rem; padding: .75rem 0; border-bottom: 1px solid var(--line-soft); }
  @media (min-width: 40rem) { .plate > div { grid-template-columns: 11rem 1fr; align-items: baseline; } }
  .plate dt, .plate .k { font-family: var(--mono); font-size: .66rem; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  .plate dd, .plate .v { margin: 0; font-family: var(--mono); font-size: .88rem; overflow-wrap: anywhere; }
  /* Estado de verificación del correo: color y forma, nunca solo un emoji. */
  .ok, .pend { display: inline-flex; align-items: center; gap: .4rem; }
  .ok::before, .pend::before { content: ""; width: 6px; height: 6px; border-radius: 50%; }
  .ok { color: var(--accent-text); }
  .ok::before { background: var(--accent); }
  .pend { color: color-mix(in srgb, var(--histo) 70%, var(--text)); }
  .pend::before { background: var(--histo); }
  .live { display: inline-flex; align-items: center; gap: .45rem; }
  .live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); animation: pulse 2.6s ease-out infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }

  /* Cifras del encabezado (sesiones, apps). */
  .figures { display: flex; flex-wrap: wrap; gap: 1.6rem 2.4rem; padding-top: .3rem; }
  .fig { display: grid; gap: .1rem; }
  .fig b { font-family: var(--display); font-weight: 400; font-size: 1.9rem; line-height: 1; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .fig span { font-family: var(--mono); font-size: .62rem; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }

  /* Tablas */
  /* Los hijos de una sección pueden encogerse: sin esto una tabla ancha
     ensancha la sección entera y desborda la página en móvil. */
  section > *, .item > *, .plate > * { min-width: 0; }
  .scroll { overflow-x: auto; max-width: 100%; }
  table { border-collapse: collapse; width: 100%; font-size: .86rem; }
  /* En móvil la tabla se desplaza en horizontal en vez de estrujar las columnas
     hasta que cada celda parta en quince líneas. */
  .scroll table { min-width: 30rem; }
  thead th { font-family: var(--mono); font-size: .62rem; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); font-weight: 400; }
  th, td { text-align: left; padding: .55rem .6rem; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  th:first-child, td:first-child { padding-left: 0; }
  tbody tr { transition: background .2s ease; }
  tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  td.when { font-family: var(--mono); font-size: .78rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.ua { min-width: 11rem; max-width: 18rem; overflow-wrap: anywhere; color: var(--muted); }
  td.ua small { display: block; font-family: var(--mono); font-size: .68rem; opacity: .75; }
  td.params { color: var(--muted); overflow-wrap: anywhere; }
  tbody td:first-child code { white-space: nowrap; }
  .tag { font-family: var(--mono); font-size: .6rem; letter-spacing: .12em; text-transform: uppercase; color: var(--accent-text); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); border-radius: 999px; padding: .05rem .45rem; white-space: nowrap; }

  /* Filas de aplicaciones autorizadas */
  .item { display: flex; flex-wrap: wrap; gap: .8rem 1rem; align-items: center; justify-content: space-between; border: 1px solid var(--line-soft); border-radius: 3px; padding: .9rem 1rem; transition: border-color .25s ease; }
  .item:hover { border-color: var(--line); }
  .item strong { font-size: 1.02rem; font-weight: 400; }
  .item .muted { font-size: .82rem; font-family: var(--mono); }

  /* Botones */
  button, a.btn { font-family: var(--sans); font-size: .88rem; font-weight: 500; padding: .58rem 1.05rem; border: 1px solid var(--accent); border-radius: 2px; background: var(--accent); color: var(--on-accent); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: .5rem; transition: transform .25s var(--ease), box-shadow .25s var(--ease), background .2s, color .2s, border-color .2s; }
  button:hover, a.btn:hover { transform: translateY(-2px); box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--accent) 85%, transparent); }
  button.danger { background: transparent; color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); box-shadow: none; }
  button.danger:hover { background: var(--danger); color: var(--paper); border-color: var(--danger); box-shadow: none; }

  /* Código */
  pre { margin: 0; overflow-x: auto; background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 3px; padding: .95rem 1rem; font-size: .8rem; line-height: 1.65; }
  pre code { font-size: inherit; }
  code { font-family: var(--mono); font-size: .86em; overflow-wrap: anywhere; }
  .block { position: relative; }
  .block .copy { position: absolute; top: .5rem; right: .5rem; font-family: var(--sans); font-size: .64rem; letter-spacing: .14em; text-transform: uppercase; padding: .25rem .55rem; background: var(--surface); color: var(--muted); border: 1px solid var(--line); transform: none; box-shadow: none; }
  /* Solo se esconde donde existe el hover que lo revela. En una pantalla táctil
     quedaría invisible pero pulsable, justo encima del bloque que se desplaza. */
  @media (hover: hover) {
    .block .copy { opacity: 0; }
    .block:hover .copy, .block .copy:focus-visible { opacity: 1; }
  }
  /* Sitio reservado para el botón: no puede taparse con la primera línea. */
  .block pre { padding-right: 5.5rem; }
  .block .copy:hover { color: var(--accent); border-color: var(--accent); transform: none; box-shadow: none; }
  .block .copy.done { color: var(--on-accent); background: var(--accent); border-color: var(--accent); opacity: 1; }
  .quote { position: relative; font-family: var(--mono); font-size: .82rem; line-height: 1.55; background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 2px; padding: .65rem .8rem .65rem 1.5rem; transition: border-color .25s ease, transform .25s var(--ease); }
  .quote::before { content: "›"; position: absolute; left: .7rem; color: var(--accent); }
  .quote:hover { border-color: color-mix(in srgb, var(--accent) 45%, transparent); transform: translateX(3px); }

  /* Índice pegajoso de la guía */
  /* Hijo directo de <main>, no de una sección: un elemento pegajoso se ancla a
     su bloque contenedor y dentro de la portada se despegaba a los 26px. */
  .toc { position: sticky; top: 3.2rem; z-index: 40; display: flex; flex-wrap: wrap; gap: .35rem .4rem; margin: 0; padding: .55rem .7rem; border: 1px solid var(--line); border-radius: 3px; background: color-mix(in srgb, var(--paper) 92%, transparent); backdrop-filter: blur(10px) saturate(1.2); font-family: var(--mono); font-size: .7rem; }
  .toc a { text-decoration: none; color: var(--muted); border: 1px solid transparent; border-radius: 999px; padding: .22rem .65rem; white-space: nowrap; transition: color .2s, border-color .2s, background .2s; }
  .toc a:hover { color: var(--text); border-color: var(--line); }
  .toc a.on { color: var(--accent-text); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .secnum { font-family: var(--mono); font-size: .68rem; letter-spacing: .16em; color: var(--accent); }
  :target { scroll-margin-top: 6.5rem; }

  @media (max-width: 34rem) {
    .topbar-inner { gap: .4rem .6rem; }
    .brand { width: 100%; }
    .nav a { padding: .3rem .5rem; }
    .session { width: 100%; justify-content: flex-start; }
    .toc { top: 5.4rem; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { transition: none !important; animation: none !important; }
    .js section { opacity: 1; transform: none; }
  }
`;

/** Script común: tema, progreso de lectura, entrada de secciones, índice y copiar. */
const SCRIPT = `
(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var themeBtn = document.getElementById("theme");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var root = document.documentElement;
      var dark = root.getAttribute("data-theme")
        ? root.getAttribute("data-theme") === "dark"
        : window.matchMedia("(prefers-color-scheme: dark)").matches;
      var next = dark ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("sb-theme", next); } catch (e) {}
    });
  }

  var bar = document.getElementById("progress");
  var onScroll = function () {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (h > 40 ? Math.min(window.scrollY / h, 1) * 100 : 0) + "%";
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();

  var sections = document.querySelectorAll("main > section");
  if (!("IntersectionObserver" in window) || reduce) {
    for (var i = 0; i < sections.length; i++) sections[i].classList.add("in");
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });
    for (var j = 0; j < sections.length; j++) {
      // En una pestaña de fondo el observador no dispara: lo que ya está en
      // pantalla se muestra de inmediato para no dejar la página en blanco.
      var box = sections[j].getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) sections[j].classList.add("in");
      else io.observe(sections[j]);
    }
  }

  var tocLinks = document.querySelectorAll(".toc a");
  if (tocLinks.length && "IntersectionObserver" in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        for (var k = 0; k < tocLinks.length; k++) {
          tocLinks[k].classList.toggle("on", tocLinks[k].getAttribute("href") === "#" + e.target.id);
        }
      });
    }, { rootMargin: "-25% 0px -60% 0px" });
    var targets = document.querySelectorAll("main section[id]");
    for (var t = 0; t < targets.length; t++) spy.observe(targets[t]);
  }

  var blocks = document.querySelectorAll(".block");
  for (var b = 0; b < blocks.length; b++) {
    (function (block) {
      var pre = block.querySelector("pre");
      if (!pre || !navigator.clipboard) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy";
      btn.textContent = "Copiar";
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(pre.textContent).then(function () {
          btn.textContent = "Copiado";
          btn.classList.add("done");
          setTimeout(function () { btn.textContent = "Copiar"; btn.classList.remove("done"); }, 1800);
        }, function () {});
      });
      block.appendChild(btn);
    })(blocks[b]);
  }
})();
`;

const THEME_BUTTON = `<button class="theme" id="theme" type="button" aria-label="Cambiar entre tema claro y oscuro">
      <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"/></svg>
      <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.3 8.3 0 1 0 20 14.5Z"/></svg>
    </button>`;

function navHtml(active: DashboardSection): string {
  return NAV.map((item) => {
    const current = item.id === active ? ' aria-current="page"' : "";
    return `<a href="${item.href}"${current}>${item.label}</a>`;
  }).join("\n      ");
}

function sessionHtml(session: DashboardSessionView | null): string {
  if (!session) {
    return `<div class="session"><a class="linkbtn" href="/login">Iniciar sesión</a>${THEME_BUTTON}</div>`;
  }
  return `<div class="session">
      <span class="who">${escapeHtml(session.email)}</span>
      <form method="post" action="/cuenta/cerrar-sesion">
        <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(session.csrf)}">
        <button type="submit" class="linkbtn">Cerrar sesión</button>
      </form>
      ${THEME_BUTTON}
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
<script>
  (function () {
    var r = document.documentElement;
    r.className += " js";
    try {
      var t = localStorage.getItem("sb-theme");
      if (t === "light" || t === "dark") r.setAttribute("data-theme", t);
    } catch (e) {}
  })();
</script>
<style>${STYLE}
    .buscador { display: flex; gap: .5rem; margin: .75rem 0 1rem; max-width: 34rem; }
    .buscador input { flex: 1; padding: .55rem .7rem; font: inherit;
      border: 1px solid var(--linea, #d9d4c7); border-radius: 2px; background: transparent;
      color: inherit; }
    .buscador button { padding: .55rem 1rem; font: inherit; cursor: pointer;
      border: 1px solid currentColor; background: transparent; color: inherit; border-radius: 2px; }
    .hallazgos { list-style: none; padding: 0; margin: 0; }
    .hallazgos li { padding: .6rem 0; border-bottom: 1px solid var(--linea, #e6e1d5);
      line-height: 1.5; }
  ${CONSTELACION_CSS}
    .buscando { display: flex; align-items: center; gap: .55rem; margin: .2rem 0 1rem;
    font-family: var(--mono); font-size: .72rem; letter-spacing: .08em;
    text-transform: uppercase; color: var(--muted); }
  .buscando[hidden] { display: none; }
  .giro { width: .8rem; height: .8rem; border-radius: 50%;
    border: 1.5px solid var(--line); border-top-color: var(--accent);
    animation: giro 1s linear infinite; }
  @keyframes giro { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .giro { animation: none; } }
  .idioma { font-family: var(--mono); font-size: .68rem; letter-spacing: .12em;
    text-transform: uppercase; text-decoration: none; color: var(--muted);
    border: 1px solid var(--line); border-radius: 2px; padding: .25rem .6rem;
    margin-right: .6rem; white-space: nowrap; transition: color .2s, border-color .2s; }
  .idioma:hover { color: var(--accent-text); border-color: var(--accent); }
</style>
</head>
<body>
<div class="progress" id="progress" aria-hidden="true"></div>
<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/">Second Brain</a>
    <nav class="nav" aria-label="Secciones">
      ${navHtml(opts.active)}
    </nav>
    ${opts.idioma ? selectorIdioma(opts.url ?? "/", opts.idioma) : ""}
    ${sessionHtml(opts.session)}
  </div>
</header>
<main>
${opts.body}
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
