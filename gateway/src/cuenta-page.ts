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
import { traductor, type Idioma, type Textos } from "./i18n.js";
import { escapeHtml } from "./html.js";
import { CSRF_FIELD } from "./csrf.js";
import { dashboardShell } from "./dashboard-layout.js";

/**
 * Textos del panel. El vocabulario es deliberadamente el del usuario en los dos
 * idiomas: "documentos"/"documents", "lo que has guardado"/"what you've saved".
 * Nada de "episodios", "entidades" ni "hechos vigentes" — nadie fuera del
 * proyecto sabe qué son, y en inglés pasa exactamente lo mismo.
 */
const T: Textos<
  | "titulo"
  | "eyebrowPanel"
  | "kCorreo"
  | "kVerificacion"
  | "kEspacio"
  | "kConector"
  | "verificado"
  | "pendiente"
  | "sinServidor"
  | "usaloEn"
  | "sinIdentificar"
  | "avisoNoVerificado"
  | "reenviarVerificacion"
  | "figSesiones"
  | "figApps"
  | "primeraVez"
  | "guiaDeUso"
  | "eyebrowMemoria"
  | "vacioTitulo"
  | "vacioAntes"
  | "vacioDespues"
  | "comandoAdd"
  | "resumenTitulo"
  | "figDocumentos"
  | "figDatos"
  | "figPersonas"
  | "figCambiaron"
  | "porTema"
  | "ultimoTitulo"
  | "thDocumento"
  | "thTema"
  | "thGuardado"
  | "eyebrowConsultar"
  | "buscarTitulo"
  | "buscarIntro"
  | "buscarPlaceholder"
  | "buscarBoton"
  | "buscando"
  | "buscandoBoton"
  | "sinResultados"
  | "yaNoVigente"
  | "desdeFecha"
  | "entidadesTitulo"
  | "entidadesIntro"
  | "eyebrowRelaciones"
  | "sinRelaciones"
  | "relacionSingular"
  | "relacionPlural"
  | "queCambiaron"
  | "seguirHilo"
  | "volverResumen"
  | "eyebrowPortabilidad"
  | "exportarTitulo"
  | "exportarIntro"
  | "exportarBoton"
  | "eyebrowAccesos"
  | "sesionesTitulo"
  | "sesionesIntro"
  | "thUltimoUso"
  | "thInicio"
  | "thIP"
  | "thNavegador"
  | "estaSesion"
  | "cerrarDemas"
  | "sinOtrasSesiones"
  | "eyebrowConectores"
  | "appsTitulo"
  | "appsIntro"
  | "devuelveA"
  | "autorizadaEl"
  | "tokensActivos"
  | "revocar"
  | "sinApps"
  | "dispDesconocido"
  | "dispConsola"
  | "dispNavegador"
> = {
  titulo: { es: "Tu cuenta", en: "Your account" },
  eyebrowPanel: { es: "Panel personal", en: "Personal panel" },
  kCorreo: { es: "Correo", en: "Email" },
  kVerificacion: { es: "Verificación", en: "Verification" },
  kEspacio: { es: "Tu espacio", en: "Your space" },
  kConector: { es: "Conector", en: "Connector" },
  verificado: { es: "verificado", en: "verified" },
  pendiente: { es: "pendiente", en: "pending" },
  sinServidor: { es: "sin servidor asignado todavía", en: "no server assigned yet" },
  usaloEn: { es: "úsalo en", en: "use it in" },
  sinIdentificar: { es: "sin identificar", en: "not identified" },
  avisoNoVerificado: {
    es: "Tu correo todavía no está verificado. Hasta que lo confirmes no podrás iniciar sesión con Google usando esta misma cuenta.",
    en: "Your email is not verified yet. Until you confirm it you won’t be able to sign in with Google using this same account.",
  },
  reenviarVerificacion: { es: "Reenviar verificación", en: "Resend verification" },
  figSesiones: { es: "sesiones abiertas", en: "open sessions" },
  figApps: { es: "apps autorizadas", en: "authorized apps" },
  primeraVez: { es: "¿Primera vez por aquí? Empieza por la", en: "First time here? Start with the" },
  guiaDeUso: { es: "guía de uso", en: "user guide" },
  eyebrowMemoria: { es: "Tu memoria", en: "Your memory" },
  vacioTitulo: { es: "Todavía no has guardado nada", en: "You haven’t saved anything yet" },
  vacioAntes: {
    es: "Adjunta un documento en Claude y pídele que lo guarde, o usa",
    en: "Attach a document in Claude and ask it to save it, or run",
  },
  comandoAdd: { es: "brain add <carpeta>", en: "brain add <folder>" },
  vacioDespues: { es: "desde la terminal.", en: "from the terminal." },
  resumenTitulo: { es: "Qué tienes guardado", en: "What you’ve saved" },
  figDocumentos: { es: "documentos guardados", en: "documents saved" },
  figDatos: { es: "datos que sé de ti", en: "things I know about you" },
  figPersonas: { es: "personas, empresas y lugares", en: "people, companies and places" },
  figCambiaron: { es: "datos que cambiaron", en: "things that changed" },
  porTema: { es: "Por tema:", en: "By topic:" },
  ultimoTitulo: { es: "Lo último que guardaste", en: "The last thing you saved" },
  thDocumento: { es: "Documento", en: "Document" },
  thTema: { es: "Tema", en: "Topic" },
  thGuardado: { es: "Guardado", en: "Saved" },
  eyebrowConsultar: { es: "Consultar", en: "Look up" },
  buscarTitulo: { es: "Buscar en tu memoria", en: "Search your memory" },
  buscarIntro: {
    es: "Lo mismo que le preguntarías a Claude, sin salir de aquí.",
    en: "The same thing you would ask Claude, without leaving this page.",
  },
  buscarPlaceholder: { es: "¿cuál es mi cuenta bancaria?", en: "what is my bank account?" },
  buscarBoton: { es: "Buscar", en: "Search" },
  buscando: {
    es: "Buscando en tu memoria… puede tardar unos segundos.",
    en: "Searching your memory… this can take a few seconds.",
  },
  buscandoBoton: { es: "Buscando…", en: "Searching…" },
  sinResultados: { es: "No encontré nada para", en: "I found nothing for" },
  yaNoVigente: { es: "— ya no vigente desde", en: "— no longer current since" },
  desdeFecha: { es: "— desde", en: "— since" },
  entidadesTitulo: { es: "Personas, empresas y lugares", en: "People, companies and places" },
  entidadesIntro: {
    es: "Pincha uno para ver con qué se relaciona.",
    en: "Click one to see what it is connected to.",
  },
  eyebrowRelaciones: { es: "Relaciones", en: "Connections" },
  sinRelaciones: {
    es: "Todavía no hay nada conectado con esto.",
    en: "Nothing is connected to this yet.",
  },
  relacionSingular: { es: "relación vigente", en: "current connection" },
  relacionPlural: { es: "relaciones vigentes", en: "current connections" },
  queCambiaron: { es: "que ya cambió", en: "that already changed" },
  seguirHilo: {
    es: "Pincha cualquier nombre para seguir el hilo.",
    en: "Click any name to follow the thread.",
  },
  volverResumen: { es: "← volver al resumen", en: "← back to the summary" },
  eyebrowPortabilidad: { es: "Portabilidad", en: "Portability" },
  exportarTitulo: { es: "Exportar todo", en: "Export everything" },
  exportarIntro: {
    es: "Descarga un archivo con toda tu memoria: el texto original de cada documento, las personas y empresas que aparecen, y cada dato con la fecha desde la que vale y hasta cuándo valió. Nada se queda dentro. Puede tardar unos segundos.",
    en: "Download a file with your whole memory: the original text of every document, the people and companies that appear in them, and every piece of data with the date it started being true and the date it stopped. Nothing stays behind. It can take a few seconds.",
  },
  exportarBoton: { es: "Descargar mi memoria (JSON)", en: "Download my memory (JSON)" },
  eyebrowAccesos: { es: "Accesos", en: "Access" },
  sesionesTitulo: { es: "Sesiones activas", en: "Active sessions" },
  sesionesIntro: {
    es: "Cada navegador donde iniciaste sesión. Si ves uno que no reconoces, ciérralos todos y cambia tu contraseña.",
    en: "Every browser where you signed in. If you see one you don’t recognize, close them all and change your password.",
  },
  thUltimoUso: { es: "Último uso", en: "Last used" },
  thInicio: { es: "Inicio", en: "Started" },
  thIP: { es: "IP", en: "IP" },
  thNavegador: { es: "Navegador", en: "Browser" },
  estaSesion: { es: "esta sesión", en: "this session" },
  cerrarDemas: { es: "Cerrar todas las demás sesiones", en: "Sign out of all other sessions" },
  sinOtrasSesiones: { es: "No hay otras sesiones abiertas.", en: "There are no other sessions open." },
  eyebrowConectores: { es: "Conectores", en: "Connectors" },
  appsTitulo: { es: "Aplicaciones autorizadas", en: "Authorized applications" },
  appsIntro: {
    es: "Revocar corta el acceso: se borran sus tokens y se te volverá a pedir permiso la próxima vez que la app intente conectarse.",
    en: "Revoking cuts off access: its tokens are deleted and you will be asked for permission again the next time the app tries to connect.",
  },
  devuelveA: { es: "Devuelve a", en: "Redirects back to" },
  autorizadaEl: { es: "Autorizada el", en: "Authorized on" },
  tokensActivos: { es: "token(s) activo(s)", en: "active token(s)" },
  revocar: { es: "Revocar", en: "Revoke" },
  sinApps: {
    es: "Todavía no has autorizado ninguna aplicación.",
    en: "You haven’t authorized any application yet.",
  },
  dispDesconocido: { es: "Desconocido", en: "Unknown" },
  dispConsola: { es: "Cliente de consola", en: "Command-line client" },
  dispNavegador: { es: "Navegador", en: "Browser" },
};

type Traductor = (clave: keyof typeof T) => string;

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
  /** Idioma actual y URL, para el selector de la barra. */
  idioma?: Idioma;
  url?: string;
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
function deviceLabel(ua: string | null, t: Traductor): string {
  if (!ua) return t("dispDesconocido");
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /curl|python|node|Go-http/i.test(ua) ? t("dispConsola")
    : t("dispNavegador");
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
  const idioma = opts.idioma ?? "es";
  const t = traductor(T, idioma);
  // Las comillas también son idioma: «…» en un texto inglés canta tanto como
  // una palabra sin traducir.
  const comillas = idioma === "en" ? ["&ldquo;", "&rdquo;"] : ["«", "»"];
  const notice = opts.notice
    ? `\n    <p class="notice">${escapeHtml(opts.notice)}</p>`
    : "";

  const sessionRows = opts.sessions
    .map(
      (s) => `      <tr>
        <td class="when">${fmtDate(s.lastUsed)}${
          s.current ? ` <span class="tag">${escapeHtml(t("estaSesion"))}</span>` : ""
        }</td>
        <td class="when">${fmtDate(s.createdAt)}</td>
        <td class="when">${escapeHtml(s.ipAddress ?? "—")}</td>
        <td class="ua">${escapeHtml(deviceLabel(s.userAgent, t))}<small>${escapeHtml(s.userAgent ?? "—")}</small></td>
      </tr>`,
    )
    .join("\n");

  const otherSessions = opts.sessions.filter((s) => !s.current).length;
  const closeOthers =
    otherSessions > 0
      ? `    <form method="post" action="/cuenta/cerrar-sesiones">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(opts.csrf)}">
      <button type="submit">${escapeHtml(t("cerrarDemas"))} (${otherSessions})</button>
    </form>`
      : `    <p class="muted">${escapeHtml(t("sinOtrasSesiones"))}</p>`;

  const clientCards = opts.clients.length
    ? opts.clients
        .map(
          (c) => `    <div class="item">
      <div>
        <strong>${escapeHtml(c.name)}</strong>
        <p class="muted">${escapeHtml(t("devuelveA"))} ${escapeHtml(c.redirectOrigins.join(", ") || "—")}</p>
        <p class="muted">${escapeHtml(t("autorizadaEl"))} ${escapeHtml(c.authorizedAt ? fmtDate(c.authorizedAt) : "—")}
          · ${c.activeTokens} ${escapeHtml(t("tokensActivos"))}</p>
      </div>
      <form method="post" action="/cuenta/revocar-cliente">
        <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(opts.csrf)}">
        <input type="hidden" name="client_id" value="${escapeHtml(c.clientId)}">
        <button type="submit" class="danger">${escapeHtml(t("revocar"))}</button>
      </form>
    </div>`,
        )
        .join("\n")
    : `    <p class="muted">${escapeHtml(t("sinApps"))}</p>`;

  const r = opts.resumen;
  const fmtFecha = (v: string) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString(idioma === "en" ? "en-GB" : "es-CL", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });
  };

  // Deliberadamente en el vocabulario del usuario: "documentos" y "datos", no
  // "episodios", "entidades" ni "hechos vigentes". Nadie sabe que es un
  // episodio, y contar fragmentos en vez de archivos confunde mas que informa.
  const seccionResumen = !r
    ? ""
    : r.documentos === 0
      ? `
  <section>
    <p class="eyebrow">${escapeHtml(t("eyebrowMemoria"))}</p>
    <h2>${escapeHtml(t("vacioTitulo"))}</h2>
    <p class="muted">${escapeHtml(t("vacioAntes"))}
      <code>${escapeHtml(t("comandoAdd"))}</code> ${escapeHtml(t("vacioDespues"))}</p>
  </section>`
      : `
  <section>
    <p class="eyebrow">${escapeHtml(t("eyebrowMemoria"))}</p>
    <h2>${escapeHtml(t("resumenTitulo"))}</h2>
    <div class="figures">
      <div class="fig"><b>${r.documentos}</b><span>${escapeHtml(t("figDocumentos"))}</span></div>
      <div class="fig"><b>${r.datosActuales}</b><span>${escapeHtml(t("figDatos"))}</span></div>
      <div class="fig"><b>${r.personasYEmpresas}</b><span>${escapeHtml(t("figPersonas"))}</span></div>${
        r.datosQueCambiaron > 0
          ? `
      <div class="fig"><b>${r.datosQueCambiaron}</b><span>${escapeHtml(t("figCambiaron"))}</span></div>`
          : ""
      }
    </div>${
      Object.keys(r.porDominio).length
        ? `
    <p class="muted">${escapeHtml(t("porTema"))} ${Object.entries(r.porDominio)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<strong>${escapeHtml(k)}</strong> ${v}`)
      .join(" · ")}</p>`
        : ""
    }${
      r.ultimos.length
        ? `
    <h3>${escapeHtml(t("ultimoTitulo"))}</h3>
    <div class="scroll"><table>
      <thead><tr><th>${escapeHtml(t("thDocumento"))}</th><th>${escapeHtml(
        t("thTema"),
      )}</th><th>${escapeHtml(t("thGuardado"))}</th></tr></thead>
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
    <p class="eyebrow">${escapeHtml(t("eyebrowConsultar"))}</p>
    <h2>${escapeHtml(t("buscarTitulo"))}</h2>
    <p class="muted">${escapeHtml(t("buscarIntro"))}</p>
    <form method="get" action="/cuenta" class="buscador" data-buscador>
      <input type="search" name="q" placeholder="${escapeHtml(t("buscarPlaceholder"))}"
             value="${escapeHtml(opts.busqueda?.consulta ?? "")}" aria-label="${escapeHtml(
               t("buscarBoton"),
             )}">
      <button type="submit">${escapeHtml(t("buscarBoton"))}</button>
    </form>
    <p class="buscando" data-buscando hidden role="status">
      <span class="giro" aria-hidden="true"></span>
      ${escapeHtml(t("buscando"))}
    </p>${
      opts.busqueda
        ? opts.busqueda.datos.length
          ? `
    <ul class="hallazgos">${opts.busqueda.datos
      .map(
        (d) =>
          `<li>${escapeHtml(d.texto)}${
            d.hasta
              ? ` <span class="pend">${escapeHtml(t("yaNoVigente"))} ${escapeHtml(fmtFecha(d.hasta))}</span>`
              : d.desde
                ? ` <span class="muted">${escapeHtml(t("desdeFecha"))} ${escapeHtml(fmtFecha(d.desde))}</span>`
                : ""
          }</li>`,
      )
      .join("")}</ul>`
          : `
    <p class="muted">${escapeHtml(t("sinResultados"))} ${comillas[0]}${escapeHtml(opts.busqueda.consulta)}${comillas[1]}.</p>`
        : ""
    }${
      opts.busqueda?.entidades?.length
        ? `
    <h3>${escapeHtml(t("entidadesTitulo"))}</h3>
    <p class="muted">${escapeHtml(t("entidadesIntro"))}</p>
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
    : escapeHtml(t("sinServidor"));

  const espacio = opts.tenant
    ? `<code>${escapeHtml(opts.tenant)}</code> — ${escapeHtml(t("usaloEn"))} ` +
      `<code>brain --tenant ${escapeHtml(opts.tenant)}</code>`
    : escapeHtml(t("sinIdentificar"));

  const verificacion = opts.emailVerified
    ? `<span class="ok">${escapeHtml(t("verificado"))}</span>`
    : `<span class="pend">${escapeHtml(t("pendiente"))}</span>`;

  const reenviar = opts.emailVerified
    ? ""
    : `
    <p class="warn">${escapeHtml(t("avisoNoVerificado"))}</p>
    <form method="post" action="/cuenta/reenviar-verificacion">
      <input type="hidden" name="${CSRF_FIELD}" value="${escapeHtml(opts.csrf)}">
      <button type="submit">${escapeHtml(t("reenviarVerificacion"))}</button>
    </form>`;

  const cons = opts.constelacion;
  const vivas = cons ? cons.relaciones.filter((r) => !r.hasta).length : 0;
  const cambiadas = cons ? cons.relaciones.length - vivas : 0;
  const seccionConstelacion = !cons
    ? ""
    : `
  <section>
    <p class="eyebrow">${escapeHtml(t("eyebrowRelaciones"))}</p>
    <h2>${escapeHtml(cons.entidad)}</h2>
    <p class="muted">${
      cons.relaciones.length === 0
        ? escapeHtml(t("sinRelaciones"))
        : `${vivas} ${escapeHtml(t(vivas === 1 ? "relacionSingular" : "relacionPlural"))}${
            cambiadas ? ` · ${cambiadas} ${escapeHtml(t("queCambiaron"))}` : ""
          }. ${escapeHtml(t("seguirHilo"))}`
    }</p>${
      cons.relaciones.length
        ? `
    ${constelacionSvg(cons, "/cuenta", idioma)}
    <ul class="hallazgos">${cons.relaciones
      .map(
        (r) =>
          `<li>${escapeHtml(r.dato || r.con)}${
            r.hasta
              ? ` <span class="pend">${escapeHtml(t("yaNoVigente"))} ${escapeHtml(fmtFecha(r.hasta))}</span>`
              : r.desde
                ? ` <span class="muted">${escapeHtml(t("desdeFecha"))} ${escapeHtml(fmtFecha(r.desde))}</span>`
                : ""
          }</li>`,
      )
      .join("")}</ul>`
        : ""
    }
    <p><a href="/cuenta">${escapeHtml(t("volverResumen"))}</a></p>
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
      if (boton) { boton.disabled = true; boton.textContent = ${JSON.stringify(
        t("buscandoBoton"),
      )}; }
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
    <p class="eyebrow">${escapeHtml(t("eyebrowPanel"))}</p>
    <h1>${escapeHtml(t("titulo"))}</h1>${notice}
    <div class="plate">
      <div><span class="k">${escapeHtml(t("kCorreo"))}</span><span class="v">${escapeHtml(opts.email)}</span></div>
      <div><span class="k">${escapeHtml(t("kVerificacion"))}</span><span class="v">${verificacion}</span></div>
      <div><span class="k">${escapeHtml(t("kEspacio"))}</span><span class="v">${espacio}</span></div>
      <div><span class="k">${escapeHtml(t("kConector"))}</span><span class="v">${upstream}</span></div>
    </div>
    <div class="figures">
      <div class="fig"><b>${opts.sessions.length}</b><span>${escapeHtml(t("figSesiones"))}</span></div>
      <div class="fig"><b>${opts.clients.length}</b><span>${escapeHtml(t("figApps"))}</span></div>
    </div>${reenviar}
    <p class="muted">${escapeHtml(t("primeraVez"))} <a href="/guia">${escapeHtml(
      t("guiaDeUso"),
    )}</a>.</p>
  </section>

${seccionConstelacion}${seccionResumen}

  <section>
    <p class="eyebrow">${escapeHtml(t("eyebrowPortabilidad"))}</p>
    <h2>${escapeHtml(t("exportarTitulo"))}</h2>
    <p class="muted">${escapeHtml(t("exportarIntro"))}</p>
    <p><a class="btn" href="/export">${escapeHtml(t("exportarBoton"))}</a></p>
  </section>

  <section>
    <p class="eyebrow">${escapeHtml(t("eyebrowAccesos"))}</p>
    <h2>${escapeHtml(t("sesionesTitulo"))} (${opts.sessions.length})</h2>
    <p class="muted">${escapeHtml(t("sesionesIntro"))}</p>
    <div class="scroll"><table class="sesiones">
      <thead><tr><th>${escapeHtml(t("thUltimoUso"))}</th><th>${escapeHtml(
        t("thInicio"),
      )}</th><th>${escapeHtml(t("thIP"))}</th><th>${escapeHtml(t("thNavegador"))}</th></tr></thead>
      <tbody>
${sessionRows}
      </tbody>
    </table></div>
${closeOthers}
  </section>

  <section>
    <p class="eyebrow">${escapeHtml(t("eyebrowConectores"))}</p>
    <h2>${escapeHtml(t("appsTitulo"))} (${opts.clients.length})</h2>
    <p class="muted">${escapeHtml(t("appsIntro"))}</p>
${clientCards}
  </section>`;

  return dashboardShell({
    title: t("titulo"),
    active: "cuenta",
    session: { email: opts.email, csrf: opts.csrf },
    idioma: opts.idioma,
    url: opts.url,
    body: body + guionBuscador,
  });
}
