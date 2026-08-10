/**
 * Panel de cuenta (/cuenta). Solo produce el CONTENIDO; el `<head>`, el CSS y
 * la barra de navegación vienen del shell compartido (dashboard-layout.ts), el
 * mismo que envuelve /guia.
 *
 * Muestra lo mínimo que alguien necesita para auditar y cortar accesos sin
 * pedirle nada al administrador: su correo, a qué servidor de memoria está
 * enrutado, sus sesiones abiertas y las aplicaciones OAuth que autorizó, con
 * un botón para revocar cada cosa y un enlace para descargar toda su memoria.
 */
import { escapeHtml } from "./html.js";
import { CSRF_FIELD } from "./csrf.js";
import { dashboardShell } from "./dashboard-layout.js";

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

/**
 * Nombre legible del navegador y el sistema a partir del User-Agent, para que
 * la tabla de sesiones se pueda leer de un vistazo. La cadena completa sigue
 * mostrándose debajo: es la que sirve para reconocer un acceso raro.
 */
function deviceLabel(ua: string | null): string {
  if (!ua) return "Desconocido";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /curl|python|node|Go-http/i.test(ua) ? "Cliente de consola"
    : "Navegador";
  const os =
    /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} · ${os}` : browser;
}

export function cuentaPageHtml(opts: CuentaPageOptions): string {
  const notice = opts.notice
    ? `\n    <p class="notice">${escapeHtml(opts.notice)}</p>`
    : "";

  const sessionRows = opts.sessions
    .map(
      (s) => `      <tr>
        <td class="when">${fmtDate(s.lastUsed)}${s.current ? ' <span class="tag">esta sesión</span>' : ""}</td>
        <td class="when">${fmtDate(s.createdAt)}</td>
        <td class="when">${escapeHtml(s.ipAddress ?? "—")}</td>
        <td class="ua">${escapeHtml(deviceLabel(s.userAgent))}<small>${escapeHtml(s.userAgent ?? "—")}</small></td>
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

  const upstream = opts.upstream
    ? `<span class="live">${escapeHtml(opts.upstream)}</span>`
    : "sin servidor asignado todavía";

  const body = `  <section class="head">
    <p class="eyebrow">Panel personal</p>
    <h1>Tu cuenta</h1>${notice}
    <div class="plate">
      <div><span class="k">Correo</span><span class="v">${escapeHtml(opts.email)}</span></div>
      <div><span class="k">Tu memoria</span><span class="v">${upstream}</span></div>
    </div>
    <div class="figures">
      <div class="fig"><b>${opts.sessions.length}</b><span>sesiones abiertas</span></div>
      <div class="fig"><b>${opts.clients.length}</b><span>apps autorizadas</span></div>
    </div>
    <p class="muted">¿Primera vez por aquí? Empieza por la <a href="/guia">guía de uso</a>.</p>
  </section>

  <section>
    <p class="eyebrow">Portabilidad</p>
    <h2>Exportar todo</h2>
    <p class="muted">Descarga un archivo JSON con tu memoria completa: episodios
      (texto original), entidades y hechos con su vigencia (<code>valid_at</code> /
      <code>invalid_at</code>). Puede tardar unos segundos.</p>
    <p><a class="btn" href="/export">Descargar mi memoria (JSON)</a></p>
  </section>

  <section>
    <p class="eyebrow">Accesos</p>
    <h2>Sesiones activas (${opts.sessions.length})</h2>
    <p class="muted">Cada navegador donde iniciaste sesión. Si ves uno que no reconoces,
      ciérralos todos y cambia tu contraseña.</p>
    <div class="scroll"><table class="sesiones">
      <thead><tr><th>Último uso</th><th>Inicio</th><th>IP</th><th>Navegador</th></tr></thead>
      <tbody>
${sessionRows}
      </tbody>
    </table></div>
${closeOthers}
  </section>

  <section>
    <p class="eyebrow">Conectores</p>
    <h2>Aplicaciones autorizadas (${opts.clients.length})</h2>
    <p class="muted">Revocar corta el acceso: se borran sus tokens y se te volverá a
      pedir permiso la próxima vez que la app intente conectarse.</p>
${clientCards}
  </section>`;

  return dashboardShell({
    title: "Tu cuenta",
    active: "cuenta",
    session: { email: opts.email, csrf: opts.csrf },
    body,
  });
}
