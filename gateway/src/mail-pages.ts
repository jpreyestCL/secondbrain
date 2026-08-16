/**
 * Páginas bilingües (ES/EN) de los flujos que dependen del correo:
 *  - `/verificado`            : aterrizaje tras pulsar el enlace de verificación.
 *  - `/olvide-password`       : pedir el enlace de recuperación.
 *  - `/restablecer-password`  : elegir una contraseña nueva con el token.
 *  - confirmación de reenvío de la verificación.
 *
 * `/verificado` usa el shell del dashboard (es una página "de dentro": enlaza a
 * /cuenta y /guia). Las demás son tarjetas sueltas con el mismo lenguaje visual
 * que /login y /registro, porque se ven sin sesión.
 *
 * OJO: esto NO es `mail-templates.ts`. Aquí el idioma es el de la petición HTTP;
 * el de un correo depende de su destinatario y se decide en otro sitio.
 */
import { escapeHtml } from "./html.js";
import { cardPage, type OpcionesIdioma } from "./registro-page.js";
import { resuelveError, type ClaveErrorAuth } from "./auth-chrome.js";
import { traductor, type Textos } from "./i18n.js";
import { dashboardShell, type DashboardSessionView } from "./dashboard-layout.js";

/** Motivos por los que un enlace de verificación no sirve. */
const VERIFY_ERRORS: Textos<
  "TOKEN_EXPIRED" | "INVALID_TOKEN" | "USER_NOT_FOUND" | "INVALID_USER" | "DESCONOCIDO"
> = {
  TOKEN_EXPIRED: { es: "El enlace caducó.", en: "The link has expired." },
  INVALID_TOKEN: { es: "El enlace no es válido.", en: "The link is not valid." },
  USER_NOT_FOUND: {
    es: "La cuenta de ese enlace ya no existe.",
    en: "The account for that link no longer exists.",
  },
  INVALID_USER: {
    es: "El enlace no corresponde a la sesión actual.",
    en: "The link does not match the current session.",
  },
  DESCONOCIDO: { es: "El enlace no se pudo usar.", en: "The link could not be used." },
};

type Clave =
  // /verificado, caso de error
  | "falloTituloPagina"
  | "falloTitulo"
  | "falloTexto"
  | "falloTuCorreo"
  | "falloBoton"
  | "falloPassword"
  | "falloPasswordEnlace"
  // /verificado, caso feliz
  | "okTituloPagina"
  | "okTitulo"
  | "okAviso"
  | "okYAhora"
  | "okCuenta"
  | "okGuia"
  | "okSinSesion"
  | "okSinSesionEnlace"
  | "okSinSesionCierre"
  // reenvío de la verificación
  | "reenvioTituloPagina"
  | "reenvioTitulo"
  | "reenvioAviso"
  | "reenvioPie"
  // enlaces comunes
  | "irLogin"
  | "volverInicio"
  | "volverLogin"
  // /olvide-password
  | "olvideTituloPagina"
  | "olvideTitulo"
  | "olvideSub"
  | "correo"
  | "olvideBoton"
  | "enviadoTituloPagina"
  | "enviadoTitulo"
  | "enviadoAviso"
  | "enviadoPie"
  // /restablecer-password
  | "nuevaTituloPagina"
  | "nuevaTitulo"
  | "nuevaSub"
  | "nuevaPassword"
  | "repitePassword"
  | "nuevaBoton"
  | "invalidoTituloPagina"
  | "invalidoTitulo"
  | "invalidoAviso"
  | "invalidoPedirOtro"
  | "cambiadaTituloPagina"
  | "cambiadaTitulo"
  | "cambiadaAviso"
  | "cambiadaLogin";

const T: Textos<Clave> = {
  falloTituloPagina: { es: "Verificación fallida", en: "Verification failed" },
  falloTitulo: {
    es: "No pudimos verificar tu correo",
    en: "We could not verify your email",
  },
  falloTexto: {
    es: "Los enlaces de verificación caducan y solo sirven una vez. Pide uno nuevo desde <a href=\"/cuenta\">tu cuenta</a> (si ya iniciaste sesión) o con el botón de abajo.",
    en: "Verification links expire and work only once. Ask for a new one from <a href=\"/cuenta\">your account</a> (if you are already signed in) or with the button below.",
  },
  falloTuCorreo: { es: "Tu correo", en: "Your email" },
  falloBoton: { es: "Enviarme un enlace nuevo", en: "Send me a new link" },
  falloPassword: { es: "¿Perdiste la contraseña?", en: "Lost your password?" },
  falloPasswordEnlace: { es: "Recupérala aquí", en: "Recover it here" },

  okTituloPagina: { es: "Correo verificado", en: "Email verified" },
  okTitulo: { es: "Correo verificado ✅", en: "Email verified ✅" },
  okAviso: {
    es: "Tu cuenta está lista. Ya puedes conectar Claude a tu memoria y, si quieres, entrar también con Google usando este mismo correo.",
    en: "Your account is ready. You can connect Claude to your memory now and, if you want, also sign in with Google using this same email.",
  },
  okYAhora: { es: "¿Y ahora qué?", en: "What now?" },
  okCuenta: {
    es: "<a href=\"/cuenta\">Tu cuenta</a>: la URL de tu memoria, tus sesiones y las aplicaciones que autorizaste.",
    en: "<a href=\"/cuenta\">Your account</a>: your memory URL, your sessions and the apps you have authorized.",
  },
  okGuia: {
    es: "<a href=\"/guia\">La guía</a>: cómo conectar Claude y cómo guardar y consultar cosas.",
    en: "<a href=\"/guia\">The guide</a>: how to connect Claude, and how to save and look things up.",
  },
  okSinSesion: {
    es: "Si no iniciaste sesión en este navegador,",
    en: "If you are not signed in in this browser,",
  },
  okSinSesionEnlace: { es: "inicia sesión", en: "sign in" },
  okSinSesionCierre: { es: "para continuar.", en: "to continue." },

  reenvioTituloPagina: {
    es: "Second Brain — Correo de verificación reenviado",
    en: "Second Brain — Verification email resent",
  },
  reenvioTitulo: { es: "Listo", en: "Done" },
  reenvioAviso: {
    es: "Si esa dirección tiene una cuenta sin verificar, le acabamos de enviar un enlace de confirmación. Revisa también el spam.",
    en: "If that address has an unverified account, we have just sent it a confirmation link. Check your spam folder too.",
  },
  reenvioPie: {
    es: "El enlace caduca; si no llega en unos minutos, vuelve a pedirlo.",
    en: "The link expires; if it does not arrive within a few minutes, ask for it again.",
  },

  irLogin: { es: "Ir a iniciar sesión", en: "Go to sign in" },
  volverInicio: { es: "← Volver al inicio", en: "← Back to home" },
  volverLogin: { es: "← Volver a iniciar sesión", en: "← Back to sign in" },

  olvideTituloPagina: {
    es: "Second Brain — Recuperar contraseña",
    en: "Second Brain — Recover your password",
  },
  olvideTitulo: { es: "Recuperar contraseña", en: "Recover your password" },
  olvideSub: {
    es: "Te enviamos un enlace para elegir una contraseña nueva.",
    en: "We will send you a link to choose a new password.",
  },
  correo: { es: "Correo", en: "Email" },
  olvideBoton: { es: "Enviarme el enlace", en: "Send me the link" },
  enviadoTituloPagina: {
    es: "Second Brain — Revisa tu correo",
    en: "Second Brain — Check your email",
  },
  enviadoTitulo: { es: "Revisa tu correo", en: "Check your email" },
  enviadoAviso: {
    es: "Si esa dirección tiene una cuenta, le enviamos un enlace para elegir una contraseña nueva. Revisa también el spam.",
    en: "If that address has an account, we have sent it a link to choose a new password. Check your spam folder too.",
  },
  enviadoPie: {
    es: "El enlace caduca en una hora y solo se puede usar una vez.",
    en: "The link expires in an hour and works only once.",
  },

  nuevaTituloPagina: {
    es: "Second Brain — Nueva contraseña",
    en: "Second Brain — New password",
  },
  nuevaTitulo: {
    es: "Elige una contraseña nueva",
    en: "Choose a new password",
  },
  nuevaSub: {
    es: "Mínimo 10 caracteres. Al guardarla se cierran tus otras sesiones.",
    en: "At least 10 characters. Saving it signs out your other sessions.",
  },
  nuevaPassword: { es: "Contraseña nueva", en: "New password" },
  repitePassword: { es: "Repite la contraseña", en: "Repeat the password" },
  nuevaBoton: { es: "Guardar contraseña", en: "Save password" },
  invalidoTituloPagina: {
    es: "Second Brain — Enlace no válido",
    en: "Second Brain — Link not valid",
  },
  invalidoTitulo: { es: "Ese enlace ya no sirve", en: "That link no longer works" },
  invalidoAviso: {
    es: "El enlace de recuperación caducó o ya se usó. Por seguridad cada enlace vale una sola vez y durante una hora.",
    en: "The recovery link has expired or has already been used. For safety each link works once and lasts an hour.",
  },
  invalidoPedirOtro: { es: "Pedir un enlace nuevo", en: "Ask for a new link" },
  cambiadaTituloPagina: {
    es: "Second Brain — Contraseña actualizada",
    en: "Second Brain — Password updated",
  },
  cambiadaTitulo: { es: "Contraseña actualizada", en: "Password updated" },
  cambiadaAviso: {
    es: "Ya puedes iniciar sesión con tu contraseña nueva. Las sesiones que hubiera abiertas se cerraron.",
    en: "You can now sign in with your new password. Any sessions that were open have been closed.",
  },
  cambiadaLogin: { es: "Iniciar sesión", en: "Sign in" },
};

export interface VerificadoPageOptions extends OpcionesIdioma {
  /** Sesión del navegador, si la hay (la barra del shell la usa). */
  session: DashboardSessionView | null;
  /** Código de error que devolvió Better Auth, o null si todo fue bien. */
  error?: string | null;
}

/** Aterrizaje del enlace de verificación: cuenta lista, o enlace inservible. */
export function verificadoPageHtml(opts: VerificadoPageOptions): string {
  const idioma = opts.idioma ?? "es";
  const t = traductor(T, idioma);

  if (opts.error) {
    const raw = opts.error.toUpperCase();
    const clave = raw in VERIFY_ERRORS ? (raw as keyof typeof VERIFY_ERRORS) : "DESCONOCIDO";
    const motivo = traductor(VERIFY_ERRORS, idioma)(clave);
    const body = `  <section>
    <h1>${t("falloTitulo")}</h1>
    <p class="warn">${escapeHtml(motivo)}</p>
    <p>${t("falloTexto")}</p>
    <form method="post" action="/reenviar-verificacion">
      <label class="muted" for="email">${t("falloTuCorreo")}</label>
      <input id="email" name="email" type="email" required
        style="font:inherit;padding:.5rem .7rem;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);background:transparent;color:inherit;max-width:22rem">
      <p><button type="submit">${t("falloBoton")}</button></p>
    </form>
    <p class="muted">${t("falloPassword")} <a href="/olvide-password">${t("falloPasswordEnlace")}</a>.</p>
  </section>`;
    return dashboardShell({
      title: t("falloTituloPagina"),
      active: "cuenta",
      session: opts.session,
      body,
      idioma: opts.idioma,
      url: opts.url,
    });
  }

  const body = `  <section>
    <h1>${t("okTitulo")}</h1>
    <p class="notice">${t("okAviso")}</p>
    <p>${t("okYAhora")}</p>
    <ul>
      <li>${t("okCuenta")}</li>
      <li>${t("okGuia")}</li>
    </ul>
    <p class="muted">${t("okSinSesion")}
      <a href="/login">${t("okSinSesionEnlace")}</a> ${t("okSinSesionCierre")}</p>
  </section>`;
  return dashboardShell({
    title: t("okTituloPagina"),
    active: "cuenta",
    session: opts.session,
    body,
    idioma: opts.idioma,
    url: opts.url,
  });
}

/** Confirmación NEUTRA del reenvío de verificación (no revela si existe). */
export function reenvioVerificacionHtml(idiomas: OpcionesIdioma = {}): string {
  const t = traductor(T, idiomas.idioma ?? "es");
  return cardPage(
    t("reenvioTituloPagina"),
    `<main>
  <h1>${t("reenvioTitulo")}</h1>
  <p class="notice">${t("reenvioAviso")}</p>
  <p class="muted" style="font-size:.8rem;opacity:.7">${t("reenvioPie")}</p>
  <p><a href="/login">${t("irLogin")}</a></p>
  <p><a href="/">${t("volverInicio")}</a></p>
</main>`,
    idiomas,
  );
}

export interface OlvidePasswordOptions extends OpcionesIdioma {
  /** Error de validación literal a mostrar (ya en español). */
  error?: string;
  /** Error por clave: se traduce al idioma de la petición. */
  errorClave?: ClaveErrorAuth;
  /** Valor para repoblar el campo. */
  email?: string;
}

/** Formulario "olvidé mi contraseña". */
export function olvidePasswordHtml(opts: OlvidePasswordOptions = {}): string {
  const idioma = opts.idioma ?? "es";
  const t = traductor(T, idioma);
  return cardPage(
    t("olvideTituloPagina"),
    `<form method="post" action="/olvide-password">
  <h1>${t("olvideTitulo")}</h1>
  <p class="sub">${t("olvideSub")}</p>
  <label for="email">${t("correo")}</label>
  <input id="email" name="email" type="email" autocomplete="username" required
    value="${escapeHtml(opts.email ?? "")}">
  <p class="error">${escapeHtml(resuelveError(opts, idioma))}</p>
  <button type="submit">${t("olvideBoton")}</button>
  <p><a href="/login">${t("volverLogin")}</a></p>
</form>`,
    opts,
  );
}

/** Confirmación NEUTRA: nunca dice si el correo existe (evita enumeración). */
export function olvidePasswordEnviadoHtml(idiomas: OpcionesIdioma = {}): string {
  const t = traductor(T, idiomas.idioma ?? "es");
  return cardPage(
    t("enviadoTituloPagina"),
    `<main>
  <h1>${t("enviadoTitulo")}</h1>
  <p class="notice">${t("enviadoAviso")}</p>
  <p class="muted" style="font-size:.8rem;opacity:.7">${t("enviadoPie")}</p>
  <p><a href="/login">${t("irLogin")}</a></p>
  <p><a href="/">${t("volverInicio")}</a></p>
</main>`,
    idiomas,
  );
}

export interface RestablecerPasswordOptions extends OpcionesIdioma {
  /** Token del enlace del correo. */
  token: string;
  /** Error literal a mostrar (ya en español). */
  error?: string;
  /** Error por clave: se traduce al idioma de la petición. */
  errorClave?: ClaveErrorAuth;
}

/** Formulario "elige una contraseña nueva". */
export function restablecerPasswordHtml(opts: RestablecerPasswordOptions): string {
  const idioma = opts.idioma ?? "es";
  const t = traductor(T, idioma);
  return cardPage(
    t("nuevaTituloPagina"),
    `<form method="post" action="/restablecer-password">
  <h1>${t("nuevaTitulo")}</h1>
  <p class="sub">${t("nuevaSub")}</p>
  <input type="hidden" name="token" value="${escapeHtml(opts.token)}">
  <label for="password">${t("nuevaPassword")}</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="confirm">${t("repitePassword")}</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
  <p class="error">${escapeHtml(resuelveError(opts, idioma))}</p>
  <button type="submit">${t("nuevaBoton")}</button>
  <p><a href="/login">${t("volverLogin")}</a></p>
</form>`,
    opts,
  );
}

/** El enlace de recuperación no sirve (caducado, ya usado o manipulado). */
export function restablecerTokenInvalidoHtml(idiomas: OpcionesIdioma = {}): string {
  const t = traductor(T, idiomas.idioma ?? "es");
  return cardPage(
    t("invalidoTituloPagina"),
    `<main>
  <h1>${t("invalidoTitulo")}</h1>
  <p class="notice bad">${t("invalidoAviso")}</p>
  <p><a href="/olvide-password">${t("invalidoPedirOtro")}</a></p>
  <p><a href="/login">${t("volverLogin")}</a></p>
</main>`,
    idiomas,
  );
}

/** Contraseña cambiada con éxito. */
export function restablecerOkHtml(idiomas: OpcionesIdioma = {}): string {
  const t = traductor(T, idiomas.idioma ?? "es");
  return cardPage(
    t("cambiadaTituloPagina"),
    `<main>
  <h1>${t("cambiadaTitulo")}</h1>
  <p class="notice ok">${t("cambiadaAviso")}</p>
  <p><a href="/login">${t("cambiadaLogin")}</a></p>
  <p><a href="/">${t("volverInicio")}</a></p>
</main>`,
    idiomas,
  );
}
