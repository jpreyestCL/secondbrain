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
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f5f5f4; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } }
  form { background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; padding: 2rem; width: min(92vw, 26rem); display: grid; gap: .75rem; }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  p.sub { margin: 0 0 .5rem; font-size: .85rem; opacity: .7; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: .35rem .8rem; font-size: .9rem; }
  dt { font-weight: 600; }
  dd { margin: 0; word-break: break-word; }
  ul { margin: .2rem 0 0; padding-left: 1.1rem; font-size: .9rem; }
  .warn { font-size: .85rem; border-left: 3px solid #b45309; padding: .5rem .7rem; background: color-mix(in srgb, #b45309 12%, transparent); border-radius: 4px; }
  .scopes { margin: 0; font-size: .78rem; opacity: .7; }
  .row { display: flex; gap: .6rem; }
  button { font: inherit; font-weight: 600; padding: .6rem; border: 0; border-radius: 8px; background: #4f46e5; color: white; cursor: pointer; flex: 1; }
  button.cancel { background: transparent; color: inherit; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); }
  p.alt { margin: 0; font-size: .85rem; } p.alt a { color: #4f46e5; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
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
