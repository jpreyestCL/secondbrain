/**
 * Pantalla de consentimiento PROPIA del gateway (en español), en el mismo
 * estilo visual que /login.
 *
 * Por qué existe: el plugin MCP de Better Auth decide si pide consentimiento
 * mirando `query.prompt === "consent"` — es decir, lo decide el CLIENTE. Un
 * cliente malicioso simplemente no manda `prompt` y el `code` sale sin que el
 * dueño vea nada. Esta pantalla es defensa en profundidad sobre la allowlist de
 * redirect_uri: aunque un cliente llegue a estar registrado, nadie obtiene un
 * token sin que la persona lea QUÉ aplicación pide acceso y a QUÉ.
 */
import { escapeHtml } from "./html.js";
import { AUTH_STYLE, THEME_BOOT } from "./auth-chrome.js";
import { CSRF_FIELD } from "./csrf.js";

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
}

export function consentPageHtml(opts: ConsentPageOptions): string {
  const hidden = Object.entries(opts.params)
    .map(
      ([k, v]) =>
        `  <input type="hidden" name="p_${escapeHtml(k)}" value="${escapeHtml(v)}">`,
    )
    .join("\n");
  const scopeList = opts.scopes.length
    ? `<p class="scopes">Permisos solicitados: <code>${escapeHtml(opts.scopes.join(" "))}</code></p>`
    : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Second Brain — Autorizar acceso</title>
${THEME_BOOT}
<style>${AUTH_STYLE}</style>
</head>
<body>
<form method="post" action="/consentimiento">
  <h1>¿Autorizar el acceso a tu memoria?</h1>
  <p class="sub">Estás conectando una aplicación a tu second brain como
    <strong>${escapeHtml(opts.userEmail)}</strong>.</p>
  <dl>
    <dt>Aplicación</dt><dd>${escapeHtml(opts.clientName)}</dd>
    <dt>Te devolverá a</dt><dd><code>${escapeHtml(opts.redirectOrigin)}</code></dd>
  </dl>
  <p class="warn">Si autorizas, esta aplicación podrá <strong>leer y escribir toda tu
    memoria</strong>: episodios, entidades y hechos, incluidos los sensibles
    (salud, finanzas, contratos).</p>
  <ul>
    <li>Leer todo lo que hayas guardado, actual e histórico.</li>
    <li>Agregar, corregir y dar de baja hechos en tu grafo.</li>
  </ul>
  ${scopeList}
  <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(opts.csrf)}">
${hidden}
  <div class="row">
    <button type="submit" name="decision" value="cancelar" class="cancel">Cancelar</button>
    <button type="submit" name="decision" value="autorizar">Autorizar</button>
  </div>
  <p class="alt">Si no reconoces esta aplicación, cancela. Podrás revocarla luego en
    <a href="/cuenta">tu cuenta</a>.</p>
</form>
</body>
</html>`;
}
