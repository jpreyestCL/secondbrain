/**
 * Páginas (en español) de los flujos que dependen del correo:
 *  - `/verificado`            : aterrizaje tras pulsar el enlace de verificación.
 *  - `/olvide-password`       : pedir el enlace de recuperación.
 *  - `/restablecer-password`  : elegir una contraseña nueva con el token.
 *  - confirmación de reenvío de la verificación.
 *
 * `/verificado` usa el shell del dashboard (es una página "de dentro": enlaza a
 * /cuenta y /guia). Las demás son tarjetas sueltas con el mismo lenguaje visual
 * que /login y /registro, porque se ven sin sesión.
 */
import { escapeHtml } from "./html.js";
import { cardPage } from "./registro-page.js";
import { dashboardShell, type DashboardSessionView } from "./dashboard-layout.js";

/** Motivos por los que un enlace de verificación no sirve. */
const VERIFY_ERRORS: Record<string, string> = {
  TOKEN_EXPIRED: "El enlace caducó.",
  INVALID_TOKEN: "El enlace no es válido.",
  USER_NOT_FOUND: "La cuenta de ese enlace ya no existe.",
  INVALID_USER: "El enlace no corresponde a la sesión actual.",
};

export interface VerificadoPageOptions {
  /** Sesión del navegador, si la hay (la barra del shell la usa). */
  session: DashboardSessionView | null;
  /** Código de error que devolvió Better Auth, o null si todo fue bien. */
  error?: string | null;
}

/** Aterrizaje del enlace de verificación: cuenta lista, o enlace inservible. */
export function verificadoPageHtml(opts: VerificadoPageOptions): string {
  if (opts.error) {
    const raw = opts.error.toUpperCase();
    const motivo = VERIFY_ERRORS[raw] ?? "El enlace no se pudo usar.";
    const body = `  <section>
    <h1>No pudimos verificar tu correo</h1>
    <p class="warn">${escapeHtml(motivo)}</p>
    <p>Los enlaces de verificación caducan y solo sirven una vez. Pide uno
      nuevo desde <a href="/cuenta">tu cuenta</a> (si ya iniciaste sesión) o
      con el botón de abajo.</p>
    <form method="post" action="/reenviar-verificacion">
      <label class="muted" for="email">Tu correo</label>
      <input id="email" name="email" type="email" required
        style="font:inherit;padding:.5rem .7rem;border-radius:8px;border:1px solid color-mix(in srgb, CanvasText 25%, transparent);background:transparent;color:inherit;max-width:22rem">
      <p><button type="submit">Enviarme un enlace nuevo</button></p>
    </form>
    <p class="muted">¿Perdiste la contraseña? <a href="/olvide-password">Recupérala aquí</a>.</p>
  </section>`;
    return dashboardShell({
      title: "Verificación fallida",
      active: "cuenta",
      session: opts.session,
      body,
    });
  }

  const body = `  <section>
    <h1>Correo verificado ✅</h1>
    <p class="notice">Tu cuenta está lista. Ya puedes conectar Claude a tu memoria
      y, si quieres, entrar también con Google usando este mismo correo.</p>
    <p>¿Y ahora qué?</p>
    <ul>
      <li><a href="/cuenta">Tu cuenta</a>: la URL de tu memoria, tus sesiones y
        las aplicaciones que autorizaste.</li>
      <li><a href="/guia">La guía</a>: cómo conectar Claude y cómo guardar y
        consultar cosas.</li>
    </ul>
    <p class="muted">Si no iniciaste sesión en este navegador,
      <a href="/login">inicia sesión</a> para continuar.</p>
  </section>`;
  return dashboardShell({
    title: "Correo verificado",
    active: "cuenta",
    session: opts.session,
    body,
  });
}

/** Confirmación NEUTRA del reenvío de verificación (no revela si existe). */
export function reenvioVerificacionHtml(): string {
  return cardPage(
    "Second Brain — Correo de verificación reenviado",
    `<main>
  <h1>Listo</h1>
  <p class="notice">Si esa dirección tiene una cuenta sin verificar, le acabamos
  de enviar un enlace de confirmación. Revisa también el spam.</p>
  <p class="muted" style="font-size:.8rem;opacity:.7">El enlace caduca; si no llega
  en unos minutos, vuelve a pedirlo.</p>
  <p><a href="/login">Ir a iniciar sesión</a></p>
  <p><a href="/">← Volver al inicio</a></p>
</main>`,
  );
}

export interface OlvidePasswordOptions {
  /** Error de validación a mostrar (ya en español). */
  error?: string;
  /** Valor para repoblar el campo. */
  email?: string;
}

/** Formulario "olvidé mi contraseña". */
export function olvidePasswordHtml(opts: OlvidePasswordOptions = {}): string {
  return cardPage(
    "Second Brain — Recuperar contraseña",
    `<form method="post" action="/olvide-password">
  <h1>Recuperar contraseña</h1>
  <p class="sub">Te enviamos un enlace para elegir una contraseña nueva.</p>
  <label for="email">Correo</label>
  <input id="email" name="email" type="email" autocomplete="username" required
    value="${escapeHtml(opts.email ?? "")}">
  <p class="error">${escapeHtml(opts.error ?? "")}</p>
  <button type="submit">Enviarme el enlace</button>
  <p><a href="/login">← Volver a iniciar sesión</a></p>
</form>`,
  );
}

/** Confirmación NEUTRA: nunca dice si el correo existe (evita enumeración). */
export function olvidePasswordEnviadoHtml(): string {
  return cardPage(
    "Second Brain — Revisa tu correo",
    `<main>
  <h1>Revisa tu correo</h1>
  <p class="notice">Si esa dirección tiene una cuenta, le enviamos un enlace para
  elegir una contraseña nueva. Revisa también el spam.</p>
  <p class="muted" style="font-size:.8rem;opacity:.7">El enlace caduca en una hora
  y solo se puede usar una vez.</p>
  <p><a href="/login">Ir a iniciar sesión</a></p>
  <p><a href="/">← Volver al inicio</a></p>
</main>`,
  );
}

export interface RestablecerPasswordOptions {
  /** Token del enlace del correo. */
  token: string;
  /** Error a mostrar (ya en español). */
  error?: string;
}

/** Formulario "elige una contraseña nueva". */
export function restablecerPasswordHtml(opts: RestablecerPasswordOptions): string {
  return cardPage(
    "Second Brain — Nueva contraseña",
    `<form method="post" action="/restablecer-password">
  <h1>Elige una contraseña nueva</h1>
  <p class="sub">Mínimo 10 caracteres. Al guardarla se cierran tus otras sesiones.</p>
  <input type="hidden" name="token" value="${escapeHtml(opts.token)}">
  <label for="password">Contraseña nueva</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" required>
  <label for="confirm">Repite la contraseña</label>
  <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" required>
  <p class="error">${escapeHtml(opts.error ?? "")}</p>
  <button type="submit">Guardar contraseña</button>
  <p><a href="/login">← Volver a iniciar sesión</a></p>
</form>`,
  );
}

/** El enlace de recuperación no sirve (caducado, ya usado o manipulado). */
export function restablecerTokenInvalidoHtml(): string {
  return cardPage(
    "Second Brain — Enlace no válido",
    `<main>
  <h1>Ese enlace ya no sirve</h1>
  <p class="notice bad">El enlace de recuperación caducó o ya se usó. Por seguridad
  cada enlace vale una sola vez y durante una hora.</p>
  <p><a href="/olvide-password">Pedir un enlace nuevo</a></p>
  <p><a href="/login">← Volver a iniciar sesión</a></p>
</main>`,
  );
}

/** Contraseña cambiada con éxito. */
export function restablecerOkHtml(): string {
  return cardPage(
    "Second Brain — Contraseña actualizada",
    `<main>
  <h1>Contraseña actualizada</h1>
  <p class="notice ok">Ya puedes iniciar sesión con tu contraseña nueva. Las
  sesiones que hubiera abiertas se cerraron.</p>
  <p><a href="/login">Iniciar sesión</a></p>
  <p><a href="/">← Volver al inicio</a></p>
</main>`,
  );
}
