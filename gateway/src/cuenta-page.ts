/**
 * Panel de cuenta (/cuenta), en español y con el mismo lenguaje visual que
 * /login y /consentimiento.
 *
 * Muestra lo mínimo que alguien necesita para auditar y cortar accesos sin
 * pedirle nada al administrador: su correo, a qué servidor de memoria está
 * enrutado, sus sesiones abiertas y las aplicaciones OAuth que autorizó, con
 * un botón para revocar cada cosa y un enlace para descargar toda su memoria.
 */
import { escapeHtml } from "./html.js";
import { CSRF_FIELD } from "./csrf.js";

export interface CuentaSessionView {
  id: string;
  createdAt: string;
  lastUsed: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface CuentaClientView {
  clientId: string;
  name: string;
  redirectOrigins: string[];
  authorizedAt: string | null;
  activeTokens: number;
}

export interface CuentaPageOptions {
  email: string;
  /** Upstream MCP del tenant, o null si aún no tiene uno asignado. */
  upstream: string | null;
  sessions: CuentaSessionView[];
  clients: CuentaClientView[];
  csrf: string;
  /** Mensaje de resultado de una acción previa (ya en español). */
  notice?: string | null;
}

function fmtDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function cuentaPageHtml(opts: CuentaPageOptions): string {
  const notice = opts.notice
    ? `\n  <p class="notice">${escapeHtml(opts.notice)}</p>`
    : "";

  const sessionRows = opts.sessions
    .map(
      (s) => `      <tr>
        <td>${fmtDate(s.lastUsed)}${s.current ? ' <span class="tag">esta sesión</span>' : ""}</td>
        <td>${fmtDate(s.createdAt)}</td>
        <td>${escapeHtml(s.ipAddress ?? "—")}</td>
        <td class="ua">${escapeHtml(s.userAgent ?? "—")}</td>
      </tr>`,
    )
    .join("\n");

  const otherSessions = opts.sessions.filter((s) => !s.current).length;
  const closeOthers =
    otherSessions > 0
      ? `    <form method="post" action="/cuenta/cerrar-sesiones">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(opts.csrf)}">
      <button type="submit">Cerrar todas las demás sesiones (${otherSessions})</button>
    </form>`
      : `    <p class="muted">No hay otras sesiones abiertas.</p>`;

  const clientCards = opts.clients.length
    ? opts.clients
        .map(
          (c) => `    <div class="item">
      <div>
        <strong>${escapeHtml(c.name)}</strong>
        <p class="muted">Devuelve a ${escapeHtml(c.redirectOrigins.join(", ") || "—")}</p>
        <p class="muted">Autorizada el ${escapeHtml(c.authorizedAt ? fmtDate(c.authorizedAt) : "—")}
          · ${c.activeTokens} token(s) activo(s)</p>
      </div>
      <form method="post" action="/cuenta/revocar-cliente">
        <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(opts.csrf)}">
        <input type="hidden" name="client_id" value="${escapeHtml(c.clientId)}">
        <button type="submit" class="danger">Revocar</button>
      </form>
    </div>`,
        )
        .join("\n")
    : `    <p class="muted">Todavía no has autorizado ninguna aplicación.</p>`;

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Second Brain — Tu cuenta</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; background: #f5f5f4; padding: 2rem 1rem; }
  @media (prefers-color-scheme: dark) { body { background: #1c1917; color: #e7e5e4; } }
  main { width: min(94vw, 48rem); margin-inline: auto; display: grid; gap: 1.2rem; }
  section { background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; padding: 1.5rem; display: grid; gap: .8rem; }
  h1 { font-size: 1.3rem; margin: 0; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0; }
  .muted { font-size: .85rem; opacity: .7; }
  .notice { border-left: 3px solid #4f46e5; padding: .5rem .7rem; background: color-mix(in srgb, #4f46e5 12%, transparent); border-radius: 4px; font-size: .9rem; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: .3rem .8rem; font-size: .92rem; }
  dt { font-weight: 600; } dd { margin: 0; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); vertical-align: top; }
  td.ua { max-width: 16rem; overflow-wrap: anywhere; opacity: .7; }
  .tag { font-size: .7rem; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 999px; padding: 0 .4rem; }
  .item { display: flex; gap: 1rem; align-items: center; justify-content: space-between; border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 8px; padding: .7rem .9rem; }
  button { font: inherit; font-weight: 600; padding: .5rem .9rem; border: 0; border-radius: 8px; background: #4f46e5; color: white; cursor: pointer; }
  button.danger { background: #b91c1c; }
  a.btn { display: inline-block; font-weight: 600; padding: .5rem .9rem; border-radius: 8px; background: #4f46e5; color: #fff; text-decoration: none; }
  .scroll { overflow-x: auto; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  a { color: #4f46e5; }
</style>
</head>
<body>
<main>
  <section>
    <h1>Tu cuenta</h1>${notice}
    <dl>
      <dt>Correo</dt><dd>${escapeHtml(opts.email)}</dd>
      <dt>Tu memoria</dt><dd><code>${escapeHtml(opts.upstream ?? "sin servidor asignado todavía")}</code></dd>
    </dl>
    <p class="muted"><a href="/">← Volver al inicio</a></p>
  </section>

  <section>
    <h2>Exportar todo</h2>
    <p class="muted">Descarga un archivo JSON con tu memoria completa: episodios
      (texto original), entidades y hechos con su vigencia (<code>valid_at</code> /
      <code>invalid_at</code>). Puede tardar unos segundos.</p>
    <p><a class="btn" href="/export">Descargar mi memoria (JSON)</a></p>
  </section>

  <section>
    <h2>Sesiones activas (${opts.sessions.length})</h2>
    <div class="scroll"><table>
      <thead><tr><th>Último uso</th><th>Inicio</th><th>IP</th><th>Navegador</th></tr></thead>
      <tbody>
${sessionRows}
      </tbody>
    </table></div>
${closeOthers}
  </section>

  <section>
    <h2>Aplicaciones autorizadas (${opts.clients.length})</h2>
    <p class="muted">Revocar corta el acceso: se borran sus tokens y se te volverá a
      pedir permiso la próxima vez que la app intente conectarse.</p>
${clientCards}
  </section>
</main>
</body>
</html>`;
}
