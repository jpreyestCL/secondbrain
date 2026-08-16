/**
 * Página de inicio de sesión, bilingüe (ES/EN). Tras autenticarse, vuelve a
 * lanzar la petición de autorización OAuth original (los parámetros llegan en
 * la query string).
 */
import { paginaAuth } from "./auth-chrome.js";
import { traductor, type Idioma, type Textos } from "./i18n.js";

type Clave =
  | "titulo"
  | "tituloPagina"
  | "sub"
  | "google"
  | "o"
  | "correo"
  | "password"
  | "entrar"
  | "olvide"
  | "registroEnlace"
  | "registroAbierto"
  | "registroInvitacion"
  | "volver"
  | "credencialesInvalidas"
  | "errorGoogle"
  | "errorRed";

const T: Textos<Clave> = {
  titulo: { es: "Second Brain Gateway", en: "Second Brain Gateway" },
  tituloPagina: {
    es: "Second Brain — Iniciar sesión",
    en: "Second Brain — Sign in",
  },
  sub: {
    es: "Inicia sesión para autorizar el acceso de Claude a tu memoria.",
    en: "Sign in to let Claude reach your memory.",
  },
  google: { es: "Continuar con Google", en: "Continue with Google" },
  o: { es: "o", en: "or" },
  correo: { es: "Correo", en: "Email" },
  password: { es: "Contraseña", en: "Password" },
  entrar: { es: "Entrar", en: "Sign in" },
  olvide: { es: "¿Olvidaste tu contraseña?", en: "Forgot your password?" },
  registroEnlace: {
    es: "¿No tienes cuenta? Regístrate",
    en: "No account yet? Sign up",
  },
  registroAbierto: {
    es: "— el registro está abierto, no necesitas código de invitación.",
    en: "— registration is open, no invitation code needed.",
  },
  registroInvitacion: {
    es: "— necesitas un código de invitación del administrador.",
    en: "— you need an invitation code from the administrator.",
  },
  volver: { es: "← Volver al inicio", en: "← Back to home" },
  credencialesInvalidas: { es: "Credenciales inválidas.", en: "Invalid credentials." },
  errorGoogle: {
    es: "No se pudo iniciar sesión con Google.",
    en: "Could not sign in with Google.",
  },
  errorRed: { es: "Error de red. Inténtalo de nuevo.", en: "Network error. Try again." },
};

export interface LoginPageOptions {
  /** Muestra el enlace a /registro (en modo `open` o `invite`). */
  showRegisterLink?: boolean;
  /**
   * Registro ABIERTO: el enlace invita a crear cuenta sin mencionar códigos de
   * invitación (que en este modo no existen).
   */
  openRegistration?: boolean;
  /** Muestra el botón "Continuar con Google" (solo cuando Google está configurado). */
  showGoogle?: boolean;
  /** Idioma de la petición. Omitido = español, como antes. */
  idioma?: Idioma;
  /** URL de la petición, para el selector de idioma. */
  url?: string;
}

export function loginPageHtml(opts: LoginPageOptions = {}): string {
  const idioma = opts.idioma ?? "es";
  const t = traductor(T, idioma);
  // Los mensajes del guion viajan dentro de comillas simples de JavaScript: se
  // escapan las que traiga el texto, no se toca nada más.
  const js = (clave: Clave) => t(clave).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  const registerLink = opts.showRegisterLink
    ? `\n  <p class="alt"><a href="/registro">${t("registroEnlace")}</a> ${
        opts.openRegistration ? t("registroAbierto") : t("registroInvitacion")
      }</p>`
    : "";
  const googleBlock = opts.showGoogle
    ? `\n  <button type="button" id="google" class="google">${t("google")}</button>
  <div class="divider"><span>${t("o")}</span></div>`
    : "";
  const googleScript = opts.showGoogle
    ? `
  const gbtn = document.getElementById('google');
  gbtn.addEventListener('click', async () => {
    errEl.textContent = '';
    gbtn.disabled = true;
    try {
      const search = window.location.search;
      const resume = (search && search.length > 1) ? '?resume=' + encodeURIComponent(search) : '';
      const res = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider: 'google', callbackURL: '/post-google' + resume, errorCallbackURL: '/login' }),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.url) { window.location.href = data.url; return; }
      errEl.textContent = '${js("errorGoogle")}';
      gbtn.disabled = false;
    } catch (err) {
      errEl.textContent = '${js("errorRed")}';
      gbtn.disabled = false;
    }
  });`
    : "";
  return paginaAuth({
    title: t("tituloPagina"),
    idioma: opts.idioma,
    url: opts.url,
    body: `<form id="f">
  <h1>${t("titulo")}</h1>
  <p class="sub">${t("sub")}</p>${googleBlock}
  <label for="email">${t("correo")}</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">${t("password")}</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <p id="error"></p>
  <button type="submit">${t("entrar")}</button>
  <p class="alt"><a href="/olvide-password">${t("olvide")}</a></p>${registerLink}
  <p class="alt"><a href="/">${t("volver")}</a></p>
</form>
<script>
  const form = document.getElementById('f');
  const errEl = document.getElementById('error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errEl.textContent = data.message || '${js("credencialesInvalidas")}';
        btn.disabled = false;
        return;
      }
      const params = window.location.search;
      if (params && params.length > 1) {
        // Reanuda el flujo OAuth original con los mismos parámetros.
        window.location.href = '/api/auth/mcp/authorize' + params;
      } else {
        // Sin flujo OAuth que reanudar: entrar directo al panel.
        window.location.href = '/cuenta';
      }
    } catch (err) {
      errEl.textContent = '${js("errorRed")}';
      btn.disabled = false;
    }
  });${googleScript}
</script>`,
  });
}
