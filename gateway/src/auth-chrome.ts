/**
 * Cromo compartido de las páginas de autenticación: /login, /registro y la
 * pantalla de consentimiento OAuth.
 *
 * Las tres traían el MISMO bloque CSS copiado (fondo piedra, acento índigo
 * `#4f46e5`, sans del sistema) y ninguna leía el tema que el usuario elige con
 * el interruptor de la landing o del panel. El resultado era un recorrido que
 * parpadeaba entre dos identidades: eliges claro en `/`, entras a `/login` y la
 * página aparece oscura, firmas y `/cuenta` vuelve a claro.
 *
 * Aquí quedan una sola vez los mismos tokens que usan la landing y el
 * dashboard (papel, tinta, verde «vigente») y el guion que aplica el tema
 * guardado ANTES del primer pintado. Las tres páginas son formularios cortos
 * centrados, así que comparten también el estilo de la tarjeta.
 */

/**
 * Aplica el tema almacenado antes de pintar. Va en el `<head>`, sin `defer`:
 * si se ejecutara después el usuario vería un destello del tema contrario.
 */
export const THEME_BOOT = `<script>
  (function () {
    try {
      var t = localStorage.getItem("sb-theme");
      if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    } catch (e) {}
  })();
</script>`;

/** Tokens y estilo de la tarjeta, comunes a las tres páginas. */
export const AUTH_STYLE = `
  :root {
    /* Que el navegador pinte sus superficies (barras, lienzo previo) acorde. */
    color-scheme: light dark;
    --paper: #f1eee8; --surface: #fbf9f5; --line: #d7d1c6; --line-soft: #e4dfd5;
    --text: #16201f; --muted: #5d6763;
    --accent: #1d7364; --accent-soft: #d8ebe6; --accent-text: #155a4e; --on-accent: #ffffff;
    --danger: #9c3b30;
    --aviso: #8a5a1f; --aviso-soft: #f3e6d2;
    --display: "Iowan Old Style", "Hoefler Text", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0a0f0f; --surface: #111817; --line: #26312e; --line-soft: #1e2725;
      --text: #e7ece9; --muted: #93a29c;
      --accent: #4fbfa6; --accent-soft: #12312c; --accent-text: #4fbfa6; --on-accent: #08201c;
      --danger: #e08476;
      --aviso: #d8a765; --aviso-soft: #2b2114;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --paper: #0a0f0f; --surface: #111817; --line: #26312e; --line-soft: #1e2725;
    --text: #e7ece9; --muted: #93a29c;
    --accent: #4fbfa6; --accent-soft: #12312c; --accent-text: #4fbfa6; --on-accent: #08201c;
    --danger: #e08476;
    --aviso: #d8a765; --aviso-soft: #2b2114;
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --paper: #f1eee8; --surface: #fbf9f5; --line: #d7d1c6; --line-soft: #e4dfd5;
    --text: #16201f; --muted: #5d6763;
    --accent: #1d7364; --accent-soft: #d8ebe6; --accent-text: #155a4e; --on-accent: #ffffff;
    --danger: #9c3b30;
    --aviso: #8a5a1f; --aviso-soft: #f3e6d2;
  }

  * { box-sizing: border-box; }
  body {
    font-family: var(--display); margin: 0; min-height: 100vh;
    display: grid; place-items: center; padding: 1.5rem 1rem;
    background: var(--paper); color: var(--text); -webkit-font-smoothing: antialiased;
  }
  main, form {
    background: var(--surface); border: 1px solid var(--line); border-radius: 3px;
    padding: 2rem 1.9rem; width: min(92vw, 24rem); display: grid; gap: .8rem;
  }
  h1 { font-family: var(--display); font-weight: 400; font-size: 1.5rem; line-height: 1.15; letter-spacing: -.018em; margin: 0; }
  p { margin: 0; font-size: .93rem; }
  p.sub { margin: 0 0 .4rem; font-size: .92rem; color: var(--muted); }
  label { font-family: var(--mono); font-size: .64rem; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  input {
    font-family: var(--mono); font-size: .92rem; padding: .6rem .7rem; border-radius: 2px;
    border: 1px solid var(--line); background: var(--paper); color: inherit; width: 100%;
  }
  input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button {
    font-family: var(--sans); font-size: .92rem; font-weight: 500; padding: .62rem 1rem;
    border: 1px solid var(--accent); border-radius: 2px; background: var(--accent);
    color: var(--on-accent); cursor: pointer;
    transition: transform .25s cubic-bezier(.16,1,.3,1), box-shadow .25s cubic-bezier(.16,1,.3,1);
  }
  button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 10px 24px -14px color-mix(in srgb, var(--accent) 85%, transparent); }
  button:disabled { opacity: .55; cursor: wait; transform: none; box-shadow: none; }
  button.google, button.cancel {
    background: transparent; color: var(--text); border-color: var(--line); box-shadow: none;
  }
  button.google:hover, button.cancel:hover { border-color: var(--accent); color: var(--accent); box-shadow: none; transform: none; }
  /* Sin uppercase: la «o» del separador en monoespaciada y en mayúscula se lee
     como un cero. */
  .divider { display: flex; align-items: center; gap: .6rem; color: var(--muted); font-family: var(--display); font-style: italic; font-size: .85rem; }
  .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }
  .row { display: flex; gap: .6rem; }
  .row button { flex: 1; }
  #error, .error { color: var(--danger); font-size: .86rem; min-height: 1.2em; margin: 0; }
  .hint { font-size: .82rem; color: var(--muted); margin: 0; }
  p.alt { margin: 0; font-size: .86rem; color: var(--muted); }
  a { color: var(--accent); }
  dl { margin: 0; display: grid; gap: .3rem .8rem; font-size: .9rem; }
  @media (min-width: 26rem) { dl { grid-template-columns: auto 1fr; } }
  dt { font-family: var(--mono); font-size: .64rem; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  dd { margin: 0; word-break: break-word; }
  ul, ol { margin: .2rem 0 0; padding-left: 1.1rem; font-size: .9rem; display: grid; gap: .35rem; color: var(--muted); }
  li::marker { color: var(--accent); }
  .warn {
    font-size: .86rem; border: 1px solid color-mix(in srgb, var(--aviso) 45%, transparent);
    background: var(--aviso-soft); padding: .7rem .8rem; border-radius: 3px;
  }
  .scopes { margin: 0; font-family: var(--mono); font-size: .72rem; color: var(--muted); }
  code { font-family: var(--mono); font-size: .85em; word-break: break-all; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;
