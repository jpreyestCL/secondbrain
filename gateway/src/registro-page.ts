/**
 * Páginas (en español) del registro self-service:
 *  - formulario /registro (con código de invitación),
 *  - variante "registro deshabilitado",
 *  - página de éxito con la guía "conecta tu Claude",
 *  - página de error de aprovisionamiento.
 * Mismo estilo visual que /login.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f5f5f4; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } }
  main, form { background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; padding: 2rem; width: min(90vw, 24rem); display: grid; gap: .75rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 .5rem; font-size: .85rem; opacity: .7; }
  label { font-size: .85rem; font-weight: 600; }
  input { font: inherit; padding: .55rem .7rem; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); background: transparent; color: inherit; }
  button { font: inherit; font-weight: 600; padding: .6rem; border: 0; border-radius: 8px; background: #4f46e5; color: white; cursor: pointer; }
  .error { color: #dc2626; font-size: .85rem; min-height: 1.2em; margin: 0; }
  ol { margin: 0; padding-left: 1.2rem; display: grid; gap: .5rem; font-size: .9rem; }
  code { background: color-mix(in srgb, CanvasText 8%, transparent); padding: .1rem .35rem; border-radius: 6px; font-size: .85em; word-break: break-all; }
  a { color: #4f46e5; }
  p { margin: 0; font-size: .9rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export interface RegistroPageOptions {
  /** REGISTRATION_CODE definido: el formulario se muestra. */
  enabled: boolean;
  /** Mensaje de error de validación (ya en español; se escapa aquí). */
  error?: string;
  /** Valor de email para repoblar el formulario. */
  email?: string;
}

export function registroPageHtml(opts: RegistroPageOptions): string {
  if (!opts.enabled) {
    return page(
      "Second Brain — Registro deshabilitado",
      `<main>
  <h1>Registro deshabilitado</h1>
  <p>El registro de nuevas cuentas está deshabilitado en este momento.
  Si crees que deberías tener acceso, contacta al administrador.</p>
  <p><a href="/login">Volver a iniciar sesión</a></p>
</main>`,
    );
  }
  const error = opts.error ? escapeHtml(opts.error) : "";
  const email = opts.email ? escapeHtml(opts.email) : "";
  return page(
    "Second Brain — Crear cuenta",
    `<form method="post" action="/registro">
  <h1>Crear cuenta</h1>
  <p class="sub">Necesitas un código de invitación del administrador.</p>
  <label for="email">Correo</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${email}">
  <label for="password">Contraseña (mínimo 10 caracteres)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="confirm">Confirmar contraseña</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
  <label for="code">Código de invitación</label>
  <input id="code" name="code" type="text" autocomplete="one-time-code" required>
  <p class="error">${error}</p>
  <button type="submit">Registrarme</button>
  <p><a href="/login">¿Ya tienes cuenta? Inicia sesión</a></p>
</form>`,
  );
}

/** Página de éxito con la guía paso a paso para conectar Claude. */
export function registroExitoHtml(baseUrl: string, email: string): string {
  const mcpUrl = `${baseUrl.replace(/\/+$/, "")}/mcp`;
  return page(
    "Second Brain — Cuenta creada",
    `<main>
  <h1>¡Cuenta creada! 🎉</h1>
  <p>Tu memoria personal (<strong>${escapeHtml(email)}</strong>) ya está aprovisionada.
  Ahora conecta tu Claude:</p>
  <ol>
    <li>Copia la URL del conector: <code>${escapeHtml(mcpUrl)}</code></li>
    <li>Entra a <strong>claude.ai</strong> → <strong>Ajustes</strong> →
        <strong>Conectores</strong> → <strong>Agregar conector personalizado</strong>.</li>
    <li>Pega la URL y confirma.</li>
    <li>Claude abrirá la página de inicio de sesión de este gateway: la primera
        vez usa el <strong>mismo correo y contraseña</strong> con los que te
        acabas de registrar, y autoriza el acceso.</li>
  </ol>
  <p>El conector queda disponible también en Claude Desktop y en el móvil
  (misma cuenta de claude.ai).</p>
</main>`,
  );
}

/** Cuenta creada pero el aprovisionamiento del tenant falló. */
export function registroErrorProvisionHtml(email: string): string {
  return page(
    "Second Brain — Error al aprovisionar",
    `<main>
  <h1>Cuenta creada, pero falta un paso</h1>
  <p>Tu cuenta (<strong>${escapeHtml(email)}</strong>) se creó correctamente,
  pero no pudimos aprovisionar tu espacio de memoria automáticamente.</p>
  <p><strong>Contacta al administrador</strong> para que termine la
  configuración. Hasta entonces, el conector responderá 403 (sin acceso a
  datos de nadie más).</p>
  <p><a href="/login">Ir a iniciar sesión</a></p>
</main>`,
  );
}
