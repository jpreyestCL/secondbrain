/**
 * Página que se muestra tras iniciar sesión cuando NO hay un flujo OAuth que
 * reanudar (típicamente al volver de Google en una pestaña aparte).
 *
 * Existía como un `<p>` suelto sin estilos: funcionaba, pero era lo primero que
 * veía alguien al conectar su conector y daba la impresión de que algo se había
 * roto. Usa el mismo lenguaje visual que /login y /registro.
 */
import { escapeHtml } from "./html.js";

export interface SesionIniciadaOptions {
  /** Correo de quien inició sesión, si se conoce. */
  email?: string | null;
  /** true cuando el correo aún no está verificado. */
  pendienteVerificacion?: boolean;
}

export function sesionIniciadaHtml(opts: SesionIniciadaOptions = {}): string {
  const quien = opts.email
    ? `<p class="muted">Sesión iniciada como <strong>${escapeHtml(opts.email)}</strong>.</p>`
    : "";
  const aviso = opts.pendienteVerificacion
    ? `<p class="aviso">Te enviamos un correo para confirmar tu dirección.
         Hasta que lo confirmes, no podrás entrar con Google.</p>`
    : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sesión iniciada — Second Brain</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    display: grid; place-items: center; min-height: 100vh; margin: 0;
    background: Canvas; color: CanvasText; line-height: 1.55;
  }
  .card {
    width: min(30rem, calc(100vw - 2rem));
    border: 1px solid color-mix(in oklab, CanvasText 15%, transparent);
    border-radius: 12px; padding: 2rem 1.75rem;
    background: color-mix(in oklab, Canvas 92%, CanvasText 8%);
  }
  h1 { margin: 0 0 .5rem; font-size: 1.35rem; }
  p { margin: 0 0 .85rem; }
  .muted { color: color-mix(in oklab, CanvasText 62%, transparent); font-size: .95rem; }
  .ok {
    display: inline-flex; align-items: center; gap: .5rem;
    font-weight: 600; color: #15803d; margin-bottom: .35rem;
  }
  .aviso {
    background: color-mix(in oklab, #f59e0b 16%, Canvas);
    border: 1px solid color-mix(in oklab, #f59e0b 45%, transparent);
    border-radius: 8px; padding: .7rem .85rem; font-size: .93rem;
  }
  .acciones { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1.25rem; }
  a.btn {
    display: inline-block; padding: .6rem 1rem; border-radius: 8px;
    text-decoration: none; font-size: .95rem;
    background: #4f46e5; color: #fff; border: 1px solid #4f46e5;
  }
  a.btn.sec { background: transparent; color: inherit;
    border-color: color-mix(in oklab, CanvasText 25%, transparent); }
  a.btn:hover { opacity: .92; }
</style>
</head>
<body>
  <main class="card">
    <p class="ok">✓ Sesión iniciada</p>
    <h1>Ya puedes cerrar esta pestaña</h1>
    ${quien}
    <p>Vuelve a Claude: tu conector quedó autorizado y tu memoria está disponible
      en cualquier conversación.</p>
    ${aviso}
    <div class="acciones">
      <a class="btn" href="/guia#conectar">Cómo usarlo</a>
      <a class="btn sec" href="/cuenta">Tu cuenta</a>
    </div>
  </main>
</body>
</html>`;
}
