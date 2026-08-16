/**
 * Páginas del registro self-service, bilingües (ES/EN):
 *  - formulario /registro, en modo `open` (sin código) o `invite` (con código),
 *  - variante "registro deshabilitado" (modo `closed`),
 *  - variante "instancia llena" (válvula MAX_TENANTS),
 *  - página de éxito con la guía "conecta tu Claude",
 *  - página de error de aprovisionamiento.
 * Mismo estilo visual que /login (auth-chrome.ts), que es también quien pinta
 * el selector de idioma y fija el `lang` del documento.
 */
import type { RegistrationMode } from "./env.js";
import {
  paginaAuth,
  resuelveError,
  type ClaveErrorAuth,
} from "./auth-chrome.js";
import { traductor, type Idioma, type Textos } from "./i18n.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Opciones de idioma comunes a todas las páginas de tarjeta. */
export interface OpcionesIdioma {
  /** Idioma de la petición. Omitido = español y sin selector, como antes. */
  idioma?: Idioma;
  /** URL de la petición, para el selector de idioma. */
  url?: string;
}

/**
 * Tarjeta centrada con el mismo lenguaje visual que /login y /registro. La usan
 * también las páginas de contraseña olvidada y de verificación pendiente
 * (mail-pages.ts) para que no haya dos estilos de "página suelta".
 *
 * Es el punto natural del selector de idioma: todas las páginas de tarjeta
 * pasan por aquí, así que basta con reenviarle `idioma` y `url`.
 */
export function cardPage(title: string, body: string, idiomas: OpcionesIdioma = {}): string {
  return paginaAuth({ title, body, idioma: idiomas.idioma, url: idiomas.url });
}

type Clave =
  // Formulario de alta
  | "tituloPagina"
  | "titulo"
  | "subInvite"
  | "subOpen"
  | "codigo"
  | "correo"
  | "password"
  | "confirmar"
  | "registrarme"
  | "google"
  | "o"
  | "pistaGoogle"
  | "yaTienesCuenta"
  | "volver"
  | "errorGoogle"
  | "errorCodigo"
  | "errorRed"
  // Registro cerrado
  | "cerradoTituloPagina"
  | "cerradoTitulo"
  | "cerradoTexto"
  | "volverLogin"
  // Capacidad máxima
  | "llenoTituloPagina"
  | "llenoTitulo"
  | "llenoTexto1"
  | "llenoTexto2"
  | "llenoEnlaceRepo"
  // Google sin invitación
  | "sinInvitTituloPagina"
  | "sinInvitTitulo"
  | "sinInvitTexto1"
  | "sinInvitTexto2"
  | "sinInvitEnlace"
  // Éxito
  | "exitoTituloPagina"
  | "exitoTitulo"
  | "verifEnviado"
  | "verifPendiente"
  | "reenviar"
  | "exitoAprovisionado"
  | "paso1"
  | "paso2"
  | "paso3"
  | "paso4"
  | "exitoCierre"
  // Error de aprovisionamiento
  | "provisionTituloPagina"
  | "provisionTitulo"
  | "provisionTexto1"
  | "provisionTexto2"
  | "provisionReintentar";

const T: Textos<Clave> = {
  tituloPagina: { es: "Second Brain — Crear cuenta", en: "Second Brain — Sign up" },
  titulo: { es: "Crear cuenta", en: "Create your account" },
  subInvite: {
    es: "Necesitas un código de invitación del administrador.",
    en: "You need an invitation code from the administrator.",
  },
  subOpen: {
    es: "El registro está abierto: crea tu cuenta y tu espacio de memoria se prepara solo.",
    en: "Registration is open: create your account and your memory space is set up for you.",
  },
  codigo: { es: "Código de invitación", en: "Invitation code" },
  correo: { es: "Correo", en: "Email" },
  password: {
    es: "Contraseña (mínimo 10 caracteres)",
    en: "Password (at least 10 characters)",
  },
  confirmar: { es: "Confirmar contraseña", en: "Confirm password" },
  registrarme: { es: "Registrarme", en: "Sign up" },
  google: { es: "Continuar con Google", en: "Continue with Google" },
  o: { es: "o", en: "or" },
  pistaGoogle: {
    es: "Primero ingresa un código de invitación válido para habilitar Google.",
    en: "Enter a valid invitation code first to enable Google.",
  },
  yaTienesCuenta: {
    es: "¿Ya tienes cuenta? Inicia sesión",
    en: "Already have an account? Sign in",
  },
  volver: { es: "← Volver al inicio", en: "← Back to home" },
  errorGoogle: {
    es: "No se pudo iniciar sesión con Google.",
    en: "Could not sign in with Google.",
  },
  errorCodigo: {
    es: "Código de invitación incorrecto.",
    en: "That invitation code is not valid.",
  },
  errorRed: { es: "Error de red. Inténtalo de nuevo.", en: "Network error. Try again." },

  cerradoTituloPagina: {
    es: "Second Brain — Registro deshabilitado",
    en: "Second Brain — Registration disabled",
  },
  cerradoTitulo: { es: "Registro deshabilitado", en: "Registration disabled" },
  cerradoTexto: {
    es: "El registro de nuevas cuentas está deshabilitado en este momento. Si crees que deberías tener acceso, contacta al administrador.",
    en: "New accounts cannot be created right now. If you think you should have access, get in touch with the administrator.",
  },
  volverLogin: { es: "Volver a iniciar sesión", en: "Back to sign in" },

  llenoTituloPagina: {
    es: "Second Brain — Registro cerrado temporalmente",
    en: "Second Brain — Registration closed for now",
  },
  llenoTitulo: {
    es: "Registro cerrado temporalmente",
    en: "Registration closed for now",
  },
  llenoTexto1: {
    es: "Esta instancia alcanzó su <strong>capacidad máxima</strong> de espacios de memoria, así que por ahora no podemos crear cuentas nuevas. <strong>No se creó ninguna cuenta</strong> con los datos que enviaste.",
    en: "This instance has reached its <strong>maximum capacity</strong> of memory spaces, so we cannot create new accounts for now. <strong>No account was created</strong> with the details you sent.",
  },
  llenoTexto2: {
    es: "Cada espacio de memoria corre en su propio servidor con memoria reservada, y este equipo ya no tiene sitio libre. Vuelve a intentarlo más adelante o",
    en: "Each memory space runs on its own server with reserved memory, and this machine has no room left. Try again later, or",
  },
  llenoEnlaceRepo: {
    es: "levanta tu propia instancia",
    en: "run your own instance",
  },

  sinInvitTituloPagina: {
    es: "Second Brain — Necesitas una invitación",
    en: "Second Brain — You need an invitation",
  },
  sinInvitTitulo: {
    es: "Necesitas un código de invitación",
    en: "You need an invitation code",
  },
  sinInvitTexto1: {
    es: "Iniciaste sesión con Google, pero tu cuenta todavía no tiene un espacio de memoria asignado y el acceso a Second Brain es <strong>solo por invitación</strong>.",
    en: "You signed in with Google, but your account does not have a memory space yet, and Second Brain is <strong>invitation only</strong>.",
  },
  sinInvitTexto2: {
    es: "Por seguridad cerramos la sesión. Para entrar con Google, primero valida tu código de invitación en la página de registro y vuelve a intentarlo.",
    en: "We signed you out as a precaution. To use Google, validate your invitation code on the sign-up page first and try again.",
  },
  sinInvitEnlace: {
    es: "Ir a registro con código de invitación",
    en: "Go to sign-up with an invitation code",
  },

  exitoTituloPagina: {
    es: "Second Brain — Cuenta creada",
    en: "Second Brain — Account created",
  },
  exitoTitulo: { es: "Cuenta creada 🎉", en: "Account created 🎉" },
  verifEnviado: {
    es: "Te enviamos un correo a <strong>{email}</strong> para confirmar tu dirección. Ábrelo y pulsa el botón: es lo que habilita entrar también con Google. Si no lo ves, revisa el spam.",
    en: "We sent an email to <strong>{email}</strong> to confirm your address. Open it and press the button: that is what also enables signing in with Google. If you cannot see it, check your spam folder.",
  },
  verifPendiente: {
    es: "<strong>Verificación pendiente.</strong> Tu cuenta y tu memoria quedaron creadas, pero <strong>no pudimos enviarte el correo de confirmación</strong> a <strong>{email}</strong> (el envío de correo está fallando ahora mismo). Puedes entrar con tu correo y contraseña igualmente; la verificación solo hace falta para enlazar Google.",
    en: "<strong>Verification pending.</strong> Your account and your memory were created, but <strong>we could not send the confirmation email</strong> to <strong>{email}</strong> (email delivery is failing right now). You can still sign in with your email and password; verification is only needed to link Google.",
  },
  reenviar: { es: "Reenviar correo", en: "Resend email" },
  exitoAprovisionado: {
    es: "Tu memoria personal (<strong>{email}</strong>) ya está aprovisionada. Ahora conecta tu Claude:",
    en: "Your personal memory (<strong>{email}</strong>) is ready. Now connect your Claude:",
  },
  paso1: {
    es: "Copia la URL del conector: <code>{url}</code>",
    en: "Copy the connector URL: <code>{url}</code>",
  },
  paso2: {
    es: "Entra a <strong>claude.ai</strong> → <strong>Ajustes</strong> → <strong>Conectores</strong> → <strong>Agregar conector personalizado</strong>.",
    en: "Go to <strong>claude.ai</strong> → <strong>Settings</strong> → <strong>Connectors</strong> → <strong>Add custom connector</strong>.",
  },
  paso3: { es: "Pega la URL y confirma.", en: "Paste the URL and confirm." },
  paso4: {
    es: "Claude abrirá la página de inicio de sesión de este gateway: la primera vez usa el <strong>mismo correo y contraseña</strong> con los que te acabas de registrar, y autoriza el acceso.",
    en: "Claude will open this gateway's sign-in page: the first time, use the <strong>same email and password</strong> you just signed up with, and authorize the access.",
  },
  exitoCierre: {
    es: "El conector queda disponible también en Claude Desktop y en el móvil (misma cuenta de claude.ai).",
    en: "The connector is also available in Claude Desktop and on mobile (same claude.ai account).",
  },

  provisionTituloPagina: {
    es: "Second Brain — Error al aprovisionar",
    en: "Second Brain — Provisioning failed",
  },
  provisionTitulo: {
    es: "No pudimos preparar tu espacio",
    en: "We could not set up your space",
  },
  provisionTexto1: {
    es: "No fue posible aprovisionar el espacio de memoria de <strong>{email}</strong>, así que <strong>deshicimos el registro</strong>: no quedó ninguna cuenta a medio crear.",
    en: "We could not provision the memory space for <strong>{email}</strong>, so <strong>we undid the sign-up</strong>: no half-created account was left behind.",
  },
  provisionTexto2: {
    es: "Puedes <strong>volver a intentarlo con el mismo correo</strong> en unos minutos. Si sigue fallando, contacta al administrador.",
    en: "You can <strong>try again with the same email</strong> in a few minutes. If it keeps failing, get in touch with the administrator.",
  },
  provisionReintentar: { es: "Reintentar el registro", en: "Try signing up again" },
};

export interface RegistroPageOptions extends OpcionesIdioma {
  /** Modo de registro efectivo (REGISTRATION_MODE). */
  mode: RegistrationMode;
  /** Mensaje de error de validación literal (se escapa aquí). */
  error?: string;
  /** Error de validación por clave: se traduce al idioma de la petición. */
  errorClave?: ClaveErrorAuth;
  /** Valor de email para repoblar el formulario. */
  email?: string;
  /** Muestra "Continuar con Google" (solo cuando Google está configurado). */
  showGoogle?: boolean;
}

export function registroPageHtml(opts: RegistroPageOptions): string {
  const idioma = opts.idioma ?? "es";
  const t = traductor(T, idioma);
  // Los mensajes del guion viajan entre comillas simples de JavaScript.
  const js = (texto: string) => texto.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  if (opts.mode === "closed") {
    return cardPage(
      t("cerradoTituloPagina"),
      `<main>
  <h1>${t("cerradoTitulo")}</h1>
  <p>${t("cerradoTexto")}</p>
  <p><a href="/login">${t("volverLogin")}</a></p>
</main>`,
      opts,
    );
  }
  const error = escapeHtml(resuelveError(opts, idioma));
  const email = opts.email ? escapeHtml(opts.email) : "";
  const invite = opts.mode === "invite";

  // Modo `invite`: el campo de código es obligatorio y además gobierna Google.
  // Modo `open`: no hay campo de código en absoluto.
  const codeField = invite
    ? `
  <label for="code">${t("codigo")}</label>
  <input id="code" name="code" type="text" autocomplete="one-time-code" required>`
    : "";

  const sub = invite ? t("subInvite") : t("subOpen");

  const googleBlock = opts.showGoogle
    ? `
  <div class="divider"><span>${t("o")}</span></div>
  <button type="button" id="google" class="google"${invite ? " disabled" : ""}>${t("google")}</button>${
    invite
      ? `
  <p class="hint" id="ghint">${t("pistaGoogle")}</p>`
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
      gerr.textContent = '${js(t("errorGoogle"))}'; sync();`;

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
      if (!r.ok) { gerr.textContent = '${js(t("errorCodigo"))}'; sync(); return; }`
        : ""
    }${startGoogle}
    } catch (e) { gerr.textContent = '${js(t("errorRed"))}'; sync(); }
  });
})();
</script>`
    : "";

  return cardPage(
    t("tituloPagina"),
    `<form method="post" action="/registro">
  <h1>${t("titulo")}</h1>
  <p class="sub">${sub}</p>
  <label for="email">${t("correo")}</label>
  <input id="email" name="email" type="email" autocomplete="username" required value="${email}">
  <label for="password">${t("password")}</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="confirm">${t("confirmar")}</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>${codeField}
  <p class="error">${error}</p>
  <button type="submit">${t("registrarme")}</button>${googleBlock}
  <p><a href="/login">${t("yaTienesCuenta")}</a></p>
  <p><a href="/">${t("volver")}</a></p>
</form>${googleScript}`,
    opts,
  );
}

/**
 * Válvula de seguridad MAX_TENANTS: la instancia llegó a su tope de tenants.
 * NO se creó ninguna cuenta. El motivo es físico: cada MCP de tenant corre con
 * MemoryMax=500M y el servidor tiene ~1 GB de RAM libre (compartido con las
 * apps de producción del dueño), así que aceptar más registros lo dejaría sin
 * memoria.
 */
export function registroCapacidadHtml(idiomas: OpcionesIdioma = {}): string {
  const t = traductor(T, idiomas.idioma ?? "es");
  return cardPage(
    t("llenoTituloPagina"),
    `<main>
  <h1>${t("llenoTitulo")}</h1>
  <p>${t("llenoTexto1")}</p>
  <p>${t("llenoTexto2")}
  <a href="https://github.com/jpreyestCL/secondbrain">${t("llenoEnlaceRepo")}</a>.</p>
  <p><a href="/login">${t("volverLogin")}</a></p>
  <p><a href="/">${t("volver")}</a></p>
</main>`,
    idiomas,
  );
}

/**
 * Página mostrada cuando alguien inicia sesión con Google pero su correo no
 * tiene tenant asignado y no presentó un código de invitación válido. La sesión
 * ya fue cerrada por el servidor; aquí solo se explica y se enlaza a /registro.
 */
export function googleSinInvitacionHtml(idiomas: OpcionesIdioma = {}): string {
  const t = traductor(T, idiomas.idioma ?? "es");
  return cardPage(
    t("sinInvitTituloPagina"),
    `<main>
  <h1>${t("sinInvitTitulo")}</h1>
  <p>${t("sinInvitTexto1")}</p>
  <p>${t("sinInvitTexto2")}</p>
  <p><a href="/registro">${t("sinInvitEnlace")}</a></p>
  <p><a href="/">${t("volver")}</a></p>
</main>`,
    idiomas,
  );
}

/**
 * Estado del correo de verificación al terminar el registro:
 *  - `enviado`   : el correo salió (o se registró en el log en modo debug).
 *  - `pendiente` : no se pudo enviar (sin RESEND_API_KEY, dominio sin verificar,
 *                  caída de Resend...). La cuenta y el tenant SÍ se crearon.
 */
export type VerificationState = "enviado" | "pendiente";

/** Bloque "verifica tu correo" que se inserta en la página de éxito. */
function verificacionBlock(
  email: string,
  state: VerificationState,
  t: (clave: Clave) => string,
): string {
  const correo = escapeHtml(email);
  if (state === "enviado") {
    return `  <p class="notice">${t("verifEnviado").replace("{email}", () => correo)}</p>`;
  }
  return `  <p class="notice">${t("verifPendiente").replace("{email}", () => correo)}</p>
  <form class="inline" method="post" action="/reenviar-verificacion">
    <input type="hidden" name="email" value="${correo}">
    <button type="submit">${t("reenviar")}</button>
  </form>`;
}

/** Página de éxito con la guía paso a paso para conectar Claude. */
export function registroExitoHtml(
  baseUrl: string,
  email: string,
  verification: VerificationState = "enviado",
  idiomas: OpcionesIdioma = {},
): string {
  const t = traductor(T, idiomas.idioma ?? "es");
  const mcpUrl = `${baseUrl.replace(/\/+$/, "")}/mcp`;
  return cardPage(
    t("exitoTituloPagina"),
    `<main>
  <h1>${t("exitoTitulo")}</h1>
${verificacionBlock(email, verification, t)}
  <p>${t("exitoAprovisionado").replace("{email}", () => escapeHtml(email))}</p>
  <ol>
    <li>${t("paso1").replace("{url}", () => escapeHtml(mcpUrl))}</li>
    <li>${t("paso2")}</li>
    <li>${t("paso3")}</li>
    <li>${t("paso4")}</li>
  </ol>
  <p>${t("exitoCierre")}</p>
</main>`,
    idiomas,
  );
}

/**
 * El aprovisionamiento del tenant falló. La cuenta reci&eacute;n creada YA fue
 * borrada por el servidor: así el correo no queda "quemado" (se puede reintentar
 * con el mismo) ni queda una cuenta que entra pero no sirve para nada.
 */
export function registroErrorProvisionHtml(
  email: string,
  idiomas: OpcionesIdioma = {},
): string {
  const t = traductor(T, idiomas.idioma ?? "es");
  return cardPage(
    t("provisionTituloPagina"),
    `<main>
  <h1>${t("provisionTitulo")}</h1>
  <p>${t("provisionTexto1").replace("{email}", () => escapeHtml(email))}</p>
  <p>${t("provisionTexto2")}</p>
  <p><a href="/registro">${t("provisionReintentar")}</a></p>
  <p><a href="/">${t("volver")}</a></p>
</main>`,
    idiomas,
  );
}
