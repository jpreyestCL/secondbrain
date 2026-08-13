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
import { constelacionSvg } from "./constelacion.js";
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
  /**
   * ¿El correo está verificado? Importa más de lo que parece: mientras esté
   * pendiente, Better Auth NO enlaza la cuenta de Google con esta (ver
   * `requireLocalEmailVerified` en oauth2/link-account), así que "Continuar con
   * Google" falla con `account_not_linked`.
   */
  emailVerified: boolean;
  /** Upstream MCP del tenant, o null si aún no tiene uno asignado. */
  upstream: string | null;
  /**
   * Slug del tenant: el nombre de su grafo y el valor que necesita
   * `brain --tenant <slug>`. null si el mapeo es antiguo y no lo guardó.
   */
  tenant?: string | null;
  /** URL pública del conector (la que se pega en claude.ai). */
  mcpUrl?: string;
  /** Resumen de lo guardado; null si el servidor aún no expone get_stats. */
  resumen?: {
    documentos: number;
    fragmentos: number;
    personasYEmpresas: number;
    datosActuales: number;
    datosQueCambiaron: number;
    porDominio: Record<string, number>;
    ultimos: Array<{ documento: string; dominio: string; guardado: string }>;
  } | null;
  /** Resultados de una búsqueda hecha desde el panel. */
  busqueda?: {
    consulta: string;
    datos: Array<{ texto: string; desde: string | null; hasta: string | null }>;
    entidades?: Array<{ nombre: string; uuid: string; resumen: string }>;
  } | null;
  /** Constelación de una entidad, cuando se está mirando una. */
  constelacion?: {
    entidad: string;
    uuid: string;
    relaciones: Array<{ con: string; uuid: string; dato: string; desde: string; hasta: string }>;
  } | null;
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

  const r = opts.resumen;
  const fmtFecha = (v: string) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric" });
  };

  // Deliberadamente en el vocabulario del usuario: "documentos" y "datos", no
  // "episodios", "entidades" ni "hechos vigentes". Nadie sabe que es un
  // episodio, y contar fragmentos en vez de archivos confunde mas que informa.
  const seccionResumen = !r
    ? ""
    : r.documentos === 0
      ? `
  <section>
    <p class="eyebrow">Tu memoria</p>
    <h2>Todavía no has guardado nada</h2>
    <p class="muted">Adjunta un documento en Claude y pídele que lo guarde, o usa
      <code>brain add &lt;carpeta&gt;</code> desde la terminal.</p>
  </section>`
      : `
  <section>
    <p class="eyebrow">Tu memoria</p>
    <h2>Qué tienes guardado</h2>
    <div class="figures">
      <div class="fig"><b>${r.documentos}</b><span>documentos guardados</span></div>
      <div class="fig"><b>${r.datosActuales}</b><span>datos que sé de ti</span></div>
      <div class="fig"><b>${r.personasYEmpresas}</b><span>personas, empresas y lugares</span></div>${
        r.datosQueCambiaron > 0
          ? `
      <div class="fig"><b>${r.datosQueCambiaron}</b><span>datos que cambiaron</span></div>`
          : ""
      }
    </div>${
      Object.keys(r.porDominio).length
        ? `
    <p class="muted">Por tema: ${Object.entries(r.porDominio)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<strong>${escapeHtml(k)}</strong> ${v}`)
      .join(" · ")}</p>`
        : ""
    }${
      r.ultimos.length
        ? `
    <h3>Lo último que guardaste</h3>
    <div class="scroll"><table>
      <thead><tr><th>Documento</th><th>Tema</th><th>Guardado</th></tr></thead>
      <tbody>
${r.ultimos
  .map(
    (u) =>
      `        <tr><td>${escapeHtml(u.documento)}</td><td>${escapeHtml(
        u.dominio || "—",
      )}</td><td>${escapeHtml(fmtFecha(u.guardado))}</td></tr>`,
  )
  .join("\n")}
      </tbody>
    </table></div>`
        : ""
    }
  </section>

  <section>
    <p class="eyebrow">Consultar</p>
    <h2>Buscar en tu memoria</h2>
    <p class="muted">Lo mismo que le preguntarías a Claude, sin salir de aquí.</p>
    <form method="get" action="/cuenta" class="buscador" data-buscador>
      <input type="search" name="q" placeholder="¿cuál es mi cuenta bancaria?"
             value="${escapeHtml(opts.busqueda?.consulta ?? "")}" aria-label="Buscar">
      <button type="submit">Buscar</button>
    </form>
    <p class="buscando" data-buscando hidden role="status">
      <span class="giro" aria-hidden="true"></span>
      Buscando en tu memoria… puede tardar unos segundos.
    </p>${
      opts.busqueda
        ? opts.busqueda.datos.length
          ? `
    <ul class="hallazgos">${opts.busqueda.datos
      .map(
        (d) =>
          `<li>${escapeHtml(d.texto)}${
            d.hasta
              ? ` <span class="pend">— ya no vigente desde ${escapeHtml(fmtFecha(d.hasta))}</span>`
              : d.desde
                ? ` <span class="muted">— desde ${escapeHtml(fmtFecha(d.desde))}</span>`
                : ""
          }</li>`,
      )
      .join("")}</ul>`
          : `
    <p class="muted">No encontré nada para «${escapeHtml(opts.busqueda.consulta)}».</p>`
        : ""
    }${
      opts.busqueda?.entidades?.length
        ? `
    <h3>Personas, empresas y lugares</h3>
    <p class="muted">Pincha uno para ver con qué se relaciona.</p>
    <ul class="hallazgos">${opts.busqueda.entidades
      .map(
        (e) =>
          `<li><a href="/cuenta?entidad=${encodeURIComponent(e.uuid)}">${escapeHtml(
            e.nombre,
          )}</a>${e.resumen ? ` <span class="muted">— ${escapeHtml(e.resumen.slice(0, 120))}</span>` : ""}</li>`,
      )
      .join("")}</ul>`
        : ""
    }
  </section>`;

  // Se muestra el conector PUBLICO, no el upstream interno: la direccion
  // 127.0.0.1:<puerto> del servidor no le sirve a nadie y expone topologia.
  const upstream = opts.upstream
    ? `<span class="live">${escapeHtml(opts.mcpUrl ?? "")}</span>`
    : "sin servidor asignado todavía";

  const espacio = opts.tenant
    ? `<code>${escapeHtml(opts.tenant)}</code> — úsalo en ` +
      `<code>brain --tenant ${escapeHtml(opts.tenant)}</code>`
    : "sin identificar";

  const verificacion = opts.emailVerified
    ? `<span class="ok">verificado</span>`
    : `<span class="pend">pendiente</span>`;

  const reenviar = opts.emailVerified
    ? ""
    : `
    <p class="warn">Tu correo todavía no está verificado. Hasta que lo confirmes no
      podrás iniciar sesión con Google usando esta misma cuenta.</p>
    <form method="post" action="/cuenta/reenviar-verificacion">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(opts.csrf)}">
      <button type="submit">Reenviar verificación</button>
    </form>`;

  const cons = opts.constelacion;
  const vivas = cons ? cons.relaciones.filter((r) => !r.hasta).length : 0;
  const cambiadas = cons ? cons.relaciones.length - vivas : 0;
  const seccionConstelacion = !cons
    ? ""
    : `
  <section>
    <p class="eyebrow">Relaciones</p>
    <h2>${escapeHtml(cons.entidad)}</h2>
    <p class="muted">${
      cons.relaciones.length === 0
        ? "Todavía no hay nada conectado con esto."
        : `${vivas} relación${vivas === 1 ? "" : "es"} vigente${vivas === 1 ? "" : "s"}${
            cambiadas ? ` · ${cambiadas} que ya cambió` : ""
          }. Pincha cualquier nombre para seguir el hilo.`
    }</p>${
      cons.relaciones.length
        ? `
    ${constelacionSvg(cons, "/cuenta")}
    <ul class="hallazgos">${cons.relaciones
      .map(
        (r) =>
          `<li>${escapeHtml(r.dato || r.con)}${
            r.hasta
              ? ` <span class="pend">— ya no vigente desde ${escapeHtml(fmtFecha(r.hasta))}</span>`
              : r.desde
                ? ` <span class="muted">— desde ${escapeHtml(fmtFecha(r.desde))}</span>`
                : ""
          }</li>`,
      )
      .join("")}</ul>`
        : ""
    }
    <p><a href="/cuenta">← volver al resumen</a></p>
  </section>`;

  // La busqueda va al servidor MCP y tarda segundos. Sin señal, el usuario
  // pulsa Buscar y no pasa NADA: no sabe si funcionó, y vuelve a pulsar.
  const guionBuscador = `
<script>
  (function () {
    var form = document.querySelector("[data-buscador]");
    var aviso = document.querySelector("[data-buscando]");
    if (!form || !aviso) return;
    form.addEventListener("submit", function () {
      var boton = form.querySelector("button");
      if (boton) { boton.disabled = true; boton.textContent = "Buscando…"; }
      aviso.hidden = false;
    });
    // Lo mismo al abrir una constelación: es otra consulta al servidor.
    document.querySelectorAll('a[href*="?entidad="]').forEach(function (a) {
      a.addEventListener("click", function () {
        a.style.opacity = "0.5";
        aviso.hidden = false;
      });
    });
  })();
</script>`;

  const body = `  <section class="head">
    <p class="eyebrow">Panel personal</p>
    <h1>Tu cuenta</h1>${notice}
    <div class="plate">
      <div><span class="k">Correo</span><span class="v">${escapeHtml(opts.email)}</span></div>
      <div><span class="k">Verificación</span><span class="v">${verificacion}</span></div>
      <div><span class="k">Tu espacio</span><span class="v">${espacio}</span></div>
      <div><span class="k">Conector</span><span class="v">${upstream}</span></div>
    </div>
    <div class="figures">
      <div class="fig"><b>${opts.sessions.length}</b><span>sesiones abiertas</span></div>
      <div class="fig"><b>${opts.clients.length}</b><span>apps autorizadas</span></div>
    </div>${reenviar}
    <p class="muted">¿Primera vez por aquí? Empieza por la <a href="/guia">guía de uso</a>.</p>
  </section>

${seccionConstelacion}${seccionResumen}

  <section>
    <p class="eyebrow">Portabilidad</p>
    <h2>Exportar todo</h2>
    <p class="muted">Descarga un archivo con toda tu memoria: el texto original de cada
      documento, las personas y empresas que aparecen, y cada dato con la fecha desde la
      que vale y hasta cuándo valió. Nada se queda dentro. Puede tardar unos segundos.</p>
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
    body: body + guionBuscador,
  });
}
