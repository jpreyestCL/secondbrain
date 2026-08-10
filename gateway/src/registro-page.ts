/**
 * Páginas (en español) del registro self-service:
 *  - formulario /registro, en modo `open` (sin código) o `invite` (con código),
 *  - variante "registro deshabilitado" (modo `closed`),
 *  - variante "instancia llena" (válvula MAX_TENANTS),
 *  - página de éxito con la guía "conecta tu Claude",
 *  - página de error de aprovisionamiento.
 * Mismo estilo visual que /login.
 */
import type { RegistrationMode } from "./env.js";
import { AUTH_STYLE, THEME_BOOT } from "./auth-chrome.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${THEME_BOOT}
<style>${AUTH_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export interface RegistroPageOptions {
  /** Modo de registro efectivo (REGISTRATION_MODE). */
  mode: RegistrationMode;
  /** Mensaje de error de validación (ya en español; se escapa aquí). */
  error?: string;
  /** Valor de email para repoblar el formulario. */
  email?: string;
  /** Muestra "Continuar con Google" (solo cuando Google está configurado). */
  showGoogle?: boolean;
}

export function registroPageHtml(opts: RegistroPageOptions): string {
  if (opts.mode === "closed") {
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
  const invite = opts.mode === "invite";

  // Modo `invite`: el campo de código es obligatorio y además gobierna Google.
  // Modo `open`: no hay campo de código en absoluto.
  const codeField = invite
    ? `
  <label for="code">Código de invitación</label>
  <input id="code" name="code" type="text" autocomplete="one-time-code" required>`
    : "";

  const sub = invite
    ? "Necesitas un código de invitación del administrador."
    : "El registro está abierto: crea tu cuenta y tu espacio de memoria se prepara solo.";

  const googleBlock = opts.showGoogle
    ? `
  <div class="divider"><span>o</span></div>
  <button type="button" id="google" class="google"${invite ? " disabled" : ""}>Continuar con Google</button>${
    invite
      ? `
  <p class="hint" id="ghint">Primero ingresa un código de invitación válido para habilitar Google.</p>`
      : ""
  }
  <p class="error" id="gerror"></p>`
    : "";

  // El arranque del flujo social es idéntico en ambos modos; lo que cambia es
  // si antes hay que canjear el código por la cookie `registro_ok`.
  const startGoogle = `
      var res = await fetch('/api/auth/sign-in/social', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ provider: 'google', callbackURL: '/post-google', errorCallbackURL: '/login' }),
      });
      var data = await res.json().catch(function(){ return {}; });
      if (data && data.url) { window.location.href = data.url; return; }
      gerr.textContent = 'No se pudo iniciar sesión con Google.'; sync();`;

  const googleScript = opts.showGoogle
    ? `
<script>
(function(){
  var gbtn = document.getElementById('google');
  var gerr = document.getElementById('gerror');
${
  invite
    ? `  var code = document.getElementById('code');
  function sync(){ gbtn.disabled = code.value.trim().length === 0; }
  code.addEventListener('input', sync); sync();`
    : `  function sync(){ gbtn.disabled = false; }`
}
  gbtn.addEventListener('click', async function(){
    gerr.textContent = '';
    gbtn.disabled = true;
    try {${
      invite
        ? `
      var r = await fetch('/registro/validar-codigo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ code: code.value.trim() }),
      });
      if (!r.ok) { gerr.textContent = 'Código de invitación incorrecto.'; sync(); return; }`
        : ""
    }${startGoogle}
    } catch (e) { gerr.textContent = 'Error de red. Inténtalo de nuevo.'; sync(); }
  });
})();
</script>`
    : "";

  return page(
    "Second Brain — Crear cuenta",
    `<form method="post" action="/registro">
  <h1>Crear cuenta</h1>
  <p class="sub">${sub}</p>
  <label for="email">Correo</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${email}">
  <label for="password">Contraseña (mínimo 10 caracteres)</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="confirm">Confirmar contraseña</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>${codeField}
  <p class="error">${error}</p>
  <button type="submit">Registrarme</button>${googleBlock}
  <p><a href="/login">¿Ya tienes cuenta? Inicia sesión</a></p>
  <p><a href="/">← Volver al inicio</a></p>
</form>${googleScript}`,
  );
}

/**
 * Válvula de seguridad MAX_TENANTS: la instancia llegó a su tope de tenants.
 * NO se creó ninguna cuenta. El motivo es físico: cada MCP de tenant corre con
 * MemoryMax=500M y el servidor tiene ~1 GB de RAM libre (compartido con las
 * apps de producción del dueño), así que aceptar más registros lo dejaría sin
 * memoria.
 */
export function registroCapacidadHtml(): string {
  return page(
    "Second Brain — Registro cerrado temporalmente",
    `<main>
  <h1>Registro cerrado temporalmente</h1>
  <p>Esta instancia alcanzó su <strong>capacidad máxima</strong> de espacios de memoria,
  así que por ahora no podemos crear cuentas nuevas. <strong>No se creó ninguna cuenta</strong>
  con los datos que enviaste.</p>
  <p>Cada espacio de memoria corre en su propio servidor con memoria reservada, y este
  equipo ya no tiene sitio libre. Vuelve a intentarlo más adelante o
  <a href="https://github.com/jpreyestCL/secondbrain">levanta tu propia instancia</a>.</p>
  <p><a href="/login">Volver a iniciar sesión</a></p>
  <p><a href="/">← Volver al inicio</a></p>
</main>`,
  );
}

/**
 * Página mostrada cuando alguien inicia sesión con Google pero su correo no
 * tiene tenant asignado y no presentó un código de invitación válido. La sesión
 * ya fue cerrada por el servidor; aquí solo se explica y se enlaza a /registro.
 */
export function googleSinInvitacionHtml(): string {
  return page(
    "Second Brain — Necesitas una invitación",
    `<main>
  <h1>Necesitas un código de invitación</h1>
  <p>Iniciaste sesión con Google, pero tu cuenta todavía no tiene un espacio de
  memoria asignado y el acceso a Second Brain es <strong>solo por invitación</strong>.</p>
  <p>Por seguridad cerramos la sesión. Para entrar con Google, primero valida tu
  código de invitación en la página de registro y vuelve a intentarlo.</p>
  <p><a href="/registro">Ir a registro con código de invitación</a></p>
  <p><a href="/">← Volver al inicio</a></p>
</main>`,
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

/**
 * El aprovisionamiento del tenant falló. La cuenta reci&eacute;n creada YA fue
 * borrada por el servidor: así el correo no queda "quemado" (se puede reintentar
 * con el mismo) ni queda una cuenta que entra pero no sirve para nada.
 */
export function registroErrorProvisionHtml(email: string): string {
  return page(
    "Second Brain — Error al aprovisionar",
    `<main>
  <h1>No pudimos preparar tu espacio</h1>
  <p>No fue posible aprovisionar el espacio de memoria de
  <strong>${escapeHtml(email)}</strong>, así que <strong>deshicimos el registro</strong>:
  no quedó ninguna cuenta a medio crear.</p>
  <p>Puedes <strong>volver a intentarlo con el mismo correo</strong> en unos minutos.
  Si sigue fallando, contacta al administrador.</p>
  <p><a href="/registro">Reintentar el registro</a></p>
  <p><a href="/">← Volver al inicio</a></p>
</main>`,
  );
}
