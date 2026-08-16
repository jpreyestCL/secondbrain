/**
 * Pantalla de consentimiento PROPIA del gateway, bilingüe (ES/EN), en el mismo
 * estilo visual que /login.
 *
 * Por qué existe: el plugin MCP de Better Auth decide si pide consentimiento
 * mirando `query.prompt === "consent"` — es decir, lo decide el CLIENTE. Un
 * cliente malicioso simplemente no manda `prompt` y el `code` sale sin que el
 * dueño vea nada. Esta pantalla es defensa en profundidad sobre la allowlist de
 * redirect_uri: aunque un cliente llegue a estar registrado, nadie obtiene un
 * token sin que la persona lea QUÉ aplicación pide acceso y a QUÉ.
 *
 * Por eso mismo el texto se traduce entero: alguien que lee "authorize" sin
 * entender qué autoriza no está consintiendo nada.
 */
import { escapeHtml } from "./html.js";
import { paginaAuth } from "./auth-chrome.js";
import { CSRF_FIELD } from "./csrf.js";
import { traductor, type Idioma, type Textos } from "./i18n.js";

type Clave =
  | "tituloPagina"
  | "titulo"
  | "sub"
  | "aplicacion"
  | "teDevolvera"
  | "aviso"
  | "puntoLeer"
  | "puntoEscribir"
  | "permisos"
  | "cancelar"
  | "autorizar"
  | "pie"
  | "pieEnlace";

const T: Textos<Clave> = {
  tituloPagina: {
    es: "Second Brain — Autorizar acceso",
    en: "Second Brain — Authorize access",
  },
  titulo: {
    es: "¿Autorizar el acceso a tu memoria?",
    en: "Authorize access to your memory?",
  },
  sub: {
    es: "Estás conectando una aplicación a tu second brain como <strong>{email}</strong>.",
    en: "You are connecting an app to your second brain as <strong>{email}</strong>.",
  },
  aplicacion: { es: "Aplicación", en: "App" },
  teDevolvera: { es: "Te devolverá a", en: "It will send you back to" },
  aviso: {
    es: "Si autorizas, esta aplicación podrá <strong>leer y escribir toda tu memoria</strong>: episodios, entidades y hechos, incluidos los sensibles (salud, finanzas, contratos).",
    en: "If you authorize it, this app will be able to <strong>read and write your entire memory</strong>: episodes, entities and facts, including the sensitive ones (health, finances, contracts).",
  },
  puntoLeer: {
    es: "Leer todo lo que hayas guardado, actual e histórico.",
    en: "Read everything you have saved, both current and historical.",
  },
  puntoEscribir: {
    es: "Agregar, corregir y dar de baja hechos en tu grafo.",
    en: "Add, correct and expire facts in your graph.",
  },
  permisos: { es: "Permisos solicitados:", en: "Requested permissions:" },
  cancelar: { es: "Cancelar", en: "Cancel" },
  autorizar: { es: "Autorizar", en: "Authorize" },
  pie: {
    es: "Si no reconoces esta aplicación, cancela. Podrás revocarla luego en",
    en: "If you do not recognize this app, cancel. You can revoke it later from",
  },
  pieEnlace: { es: "tu cuenta", en: "your account" },
};

export interface ConsentPageOptions {
  /** Nombre declarado por el cliente OAuth (no confiable: se escapa). */
  clientName: string;
  /** Origen del redirect_uri, lo único verificable a ojo por el usuario. */
  redirectOrigin: string;
  /** Correo de la sesión que va a autorizar. */
  userEmail: string;
  /** Scopes solicitados (informativo). */
  scopes: string[];
  /** Token CSRF ligado a la sesión. */
  csrf: string;
  /** Parámetros originales de /authorize, reenviados tal cual. */
  params: Record<string, string>;
  /** Idioma de la petición. Omitido = español, como antes. */
  idioma?: Idioma;
  /** URL de la petición, para el selector de idioma. */
  url?: string;
}

export function consentPageHtml(opts: ConsentPageOptions): string {
  const t = traductor(T, opts.idioma ?? "es");
  const hidden = Object.entries(opts.params)
    .map(
      ([k, v]) =>
        `  <input type="hidden" name="p_${escapeHtml(k)}" value="${escapeHtml(v)}">`,
    )
    .join("\n");
  const scopeList = opts.scopes.length
    ? `<p class="scopes">${t("permisos")} <code>${escapeHtml(opts.scopes.join(" "))}</code></p>`
    : "";
  return paginaAuth({
    title: t("tituloPagina"),
    idioma: opts.idioma,
    url: opts.url,
    body: `<form method="post" action="/consentimiento">
  <h1>${t("titulo")}</h1>
  <p class="sub">${t("sub").replace("{email}", () => escapeHtml(opts.userEmail))}</p>
  <dl>
    <dt>${t("aplicacion")}</dt><dd>${escapeHtml(opts.clientName)}</dd>
    <dt>${t("teDevolvera")}</dt><dd><code>${escapeHtml(opts.redirectOrigin)}</code></dd>
  </dl>
  <p class="warn">${t("aviso")}</p>
  <ul>
    <li>${t("puntoLeer")}</li>
    <li>${t("puntoEscribir")}</li>
  </ul>
  ${scopeList}
  <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(opts.csrf)}">
${hidden}
  <div class="row">
    <button type="submit" name="decision" value="cancelar" class="cancel">${t("cancelar")}</button>
    <button type="submit" name="decision" value="autorizar">${t("autorizar")}</button>
  </div>
  <p class="alt">${t("pie")}
    <a href="/cuenta">${t("pieEnlace")}</a>.</p>
</form>`,
  });
}
