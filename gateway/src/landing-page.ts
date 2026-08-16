/**
 * Landing pública de mybrain.rlz.cl (servida en `/`).
 *
 * Concepto: el diferencial del producto es la memoria bi-temporal (los hechos
 * tienen vigencia y se supersedan, no se borran). Toda la página está construida
 * como un expediente de archivo: papel con pauta, tinta, sellos de vigencia y
 * una línea de tiempo que recorre el documento por el costado. El héroe lo
 * demuestra con un deslizador de tiempo sobre datos reales de ejemplo.
 *
 * Sin dependencias externas: tipografías del sistema (serif de estilo antiguo +
 * monoespaciada), grano en SVG embebido y animaciones CSS. Nada viaja a un CDN.
 */

import { escapeHtml } from "./html.js";
import type { RegistrationMode } from "./env.js";
import { traductor, selectorIdioma, type Idioma, type Textos } from "./i18n.js";

/** Grano analógico: feTurbulence embebido, sin peticiones externas. */
const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E" +
  "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/%3E" +
  "%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.5'/%3E%3C/svg%3E";

/**
 * Textos de la landing.
 *
 * El inglés no es una traducción literal: reutiliza las frases de `README.en.md`,
 * que es la voz ya aprobada del proyecto en ese idioma. Lo que NO se traduce:
 * los nombres de las herramientas MCP (`add_memory`, `search_memory_facts`…),
 * la dirección del conector y los identificadores técnicos.
 */
type Clave =
  | "docTitulo" | "docDescripcion"
  | "navComo" | "navUsar" | "navConectar" | "navGuia" | "navCuenta"
  | "temaAria" | "railAria" | "railEsquema" | "railPrivacidad"
  | "heroEyebrow" | "heroTituloPre" | "heroTituloEm" | "heroLede"
  | "ctaConectar" | "ctaCodigo" | "trust1" | "trust2" | "trust3"
  | "demoPregunta" | "demoArrastra" | "demoHoy" | "demoLineaTiempo" | "demoRegistro"
  | "comoH2" | "comoLede"
  | "paso1T" | "paso1P" | "paso2T" | "paso2P"
  | "paso3T" | "paso3P" | "paso4T" | "paso4P"
  | "usarH2" | "usarGuardar" | "usarConsultar"
  | "q1" | "q1tool" | "q2" | "q2tool" | "q3pre" | "q3em" | "q3post" | "q3tool"
  | "q4" | "q4tool" | "q5" | "q5tool" | "q6" | "q6tool"
  | "esquemaH2" | "svgAria"
  | "dgClaude" | "dgMcp" | "dgGateway"
  | "dgTuProceso" | "dgOtroProceso" | "dgTuGrafo" | "dgOtroGrafo"
  | "leyenda1B" | "leyenda1P" | "leyenda2B" | "leyenda2P" | "leyenda3B" | "leyenda3P"
  | "conectarH2" | "paso1Pre" | "paso1F1" | "paso1Med" | "paso1F2"
  | "pasoPega" | "botonCopiar" | "pasoLogin"
  | "autoPre" | "autoEnlace" | "autoPost"
  | "privH2" | "priv1T" | "priv1P" | "priv2T" | "priv2P" | "priv3T" | "priv3P"
  | "footTag" | "footCodigo" | "footSobre" | "footY"
  | "regCerradoT" | "regCerradoP" | "regInviteT" | "regInviteP"
  | "regAbiertoT" | "regAbiertoP"
  | "btnYaTengo" | "btnCrear" | "btnCrearGratis"
  | "respVigente" | "respEn" | "vigenteDesde"
  | "stampVigente" | "stampArchivado" | "sinRegistroValor" | "stampSinRegistro"
  | "copiado" | "copiaMano";

const T: Textos<Clave> = {
  docTitulo: {
    es: "secondbrain — tu memoria, con línea de tiempo",
    en: "secondbrain — your memory, with a timeline",
  },
  docDescripcion: {
    es: "Un segundo cerebro conversacional: guarda tu información desde Claude, ingiere documentos por chat y consúltala en lenguaje natural. Los hechos nunca se borran: se supersedan con fecha.",
    en: "A conversational second brain: save your information from Claude, ingest documents over chat and query it in plain language. Facts are never deleted: they are superseded with a date.",
  },

  navComo: { es: "Cómo funciona", en: "How it works" },
  navUsar: { es: "Qué le preguntas", en: "What you ask it" },
  navConectar: { es: "Conectar", en: "Connect" },
  navGuia: { es: "Guía", en: "Guide" },
  navCuenta: { es: "Tu cuenta", en: "Your account" },
  temaAria: {
    es: "Cambiar entre tema claro y oscuro",
    en: "Switch between light and dark theme",
  },
  railAria: { es: "Índice de la página", en: "Page index" },
  railEsquema: { es: "Bajo el capó", en: "Under the hood" },
  railPrivacidad: { es: "Sobre tus datos", en: "About your data" },

  heroEyebrow: {
    es: "Memoria personal · conector MCP para Claude",
    en: "Personal memory · MCP connector for Claude",
  },
  heroTituloPre: {
    es: "Tu memoria no se sobrescribe:",
    en: "Your memory isn't overwritten:",
  },
  heroTituloEm: { es: "se fecha", en: "it's dated" },
  heroLede: {
    es: "Guardas lo que necesitas recordar hablándole a Claude. Cuando un dato cambia, el anterior no se borra — queda archivado con su periodo de vigencia. Preguntas hoy y te responde hoy; preguntas por el pasado y te lo reconstruye.",
    en: "You save what you need to remember just by talking to Claude. When something changes, the previous value isn't deleted — it stays on file with the dates it was true. Ask today and you get today's answer; ask about the past and it reconstructs it.",
  },
  ctaConectar: { es: "Conectar con Claude", en: "Connect it to Claude" },
  ctaCodigo: { es: "Ver el código", en: "See the code" },
  trust1: { es: "un grafo por persona", en: "one graph per person" },
  trust2: { es: "código abierto", en: "open source" },
  trust3: { es: "exportable siempre", en: "always exportable" },

  demoPregunta: { es: "¿Cuál es mi cuenta corriente?", en: "What's my checking account?" },
  demoArrastra: { es: "arrastra el año", en: "drag the year" },
  demoHoy: { es: "hoy", en: "today" },
  demoLineaTiempo: { es: "Línea de tiempo", en: "Timeline" },
  demoRegistro: { es: "Registro completo", en: "Full record" },

  comoH2: {
    es: "Le hablas a Claude. El resto ocurre solo.",
    en: "You talk to Claude. The rest happens on its own.",
  },
  comoLede: {
    es: "No hay app que abrir ni formularios que llenar. Conectas una vez y tu cerebro queda disponible en cualquier conversación, en web, escritorio o teléfono.",
    en: "No new app to open, no forms to fill in. You connect once and your brain is available in any conversation — web, desktop or mobile.",
  },
  paso1T: { es: "Le cuentas algo", en: "You tell it something" },
  paso1P: {
    es: "“Guarda que mi cuenta del Banco de Chile es la 123-456.” Claude entiende de qué ámbito es y de cuándo data el hecho.",
    en: "“Remember that my Banco de Chile checking account is 123-456.” Claude works out which domain it belongs to and what date the fact is from.",
  },
  paso2T: { es: "O le pasas un documento", en: "Or you hand it a document" },
  paso2P: {
    es: "Adjuntas un PDF, una foto o una planilla en el chat. Lo lee —incluso escaneado—, lo ordena y lo archiva por secciones.",
    en: "Attach a PDF, a photo or a spreadsheet in the chat. It reads it — even scanned — sorts it out and files it section by section.",
  },
  paso3T: { es: "Se archiva con fecha", en: "It's filed with a date" },
  paso3P: {
    es: "Cada dato entra con la fecha real del hecho, no la de hoy. Si contradice algo anterior, lo cierra en esa fecha en vez de borrarlo.",
    en: "Every fact goes in with the date it actually happened, not today's. If it contradicts an earlier one, that one is closed on that date instead of deleted.",
  },
  paso4T: { es: "Preguntas cuando quieras", en: "You ask whenever you want" },
  paso4P: {
    es: "En lenguaje natural. Por defecto responde con lo vigente; si pides historia, te entrega la línea de tiempo.",
    en: "In plain language. By default it answers with the current facts; ask for the history and you get the timeline.",
  },

  usarH2: {
    es: "Lo que hoy vive en capturas de pantalla y correos viejos.",
    en: "Everything that today lives in screenshots and old email.",
  },
  usarGuardar: { es: "Guardar", en: "Save" },
  usarConsultar: { es: "Consultar", en: "Look up" },
  q1: {
    es: "Guarda que el router de la casa es TP-Link y la clave está en 1Password.",
    en: "Remember that the home router is a TP-Link and the password is in 1Password.",
  },
  q1tool: { es: "→ add_memory · dominio personal", en: "→ add_memory · personal domain" },
  q2: {
    es: "Anota que en la reunión de hoy decidimos usar Postgres en el proyecto X.",
    en: "Note that in today's meeting we decided to use Postgres on project X.",
  },
  q2tool: { es: "→ add_memory · dominio proyectos", en: "→ add_memory · projects domain" },
  q3pre: { es: "Ingesta este contrato", en: "Add this contract" },
  q3em: { es: "(adjunto)", en: "(attached)" },
  q3post: { es: "a mi second brain.", en: "to my second brain." },
  q3tool: {
    es: "→ add_memory × secciones del documento",
    en: "→ add_memory × document sections",
  },
  q4: {
    es: "¿Con quién tengo acuerdo de confidencialidad?",
    en: "Who do I have an NDA with?",
  },
  q4tool: {
    es: "→ search_memory_facts · solo vigentes",
    en: "→ search_memory_facts · current only",
  },
  q5: {
    es: "¿Qué exámenes me hice el 2024 y qué decían?",
    en: "What tests did I have in 2024 and what did they say?",
  },
  q5tool: { es: "→ search_nodes + get_episodes", en: "→ search_nodes + get_episodes" },
  q6: {
    es: "Dame el historial de mis cuentas bancarias.",
    en: "Give me the history of my bank accounts.",
  },
  q6tool: {
    es: "→ search_memory_facts · only_current = false",
    en: "→ search_memory_facts · only_current = false",
  },

  esquemaH2: { es: "Cada persona, su propio grafo.", en: "Each person, their own graph." },
  svgAria: {
    es: "Claude se conecta por MCP al gateway, que enruta a cada persona a su propio proceso y su propio grafo; el grafo de otra persona queda inalcanzable.",
    en: "Claude connects over MCP to the gateway, which routes each person to their own process and their own graph; someone else's graph is unreachable.",
  },
  dgClaude: {
    es: "Claude · web · escritorio · móvil",
    en: "Claude · web · desktop · mobile",
  },
  dgMcp: { es: "MCP · OAuth 2.1 + PKCE", en: "MCP · OAuth 2.1 + PKCE" },
  dgGateway: {
    es: "gateway · autentica y enruta",
    en: "gateway · authenticates and routes",
  },
  dgTuProceso: { es: "tu proceso", en: "your process" },
  dgOtroProceso: { es: "otro proceso", en: "another process" },
  dgTuGrafo: { es: "tu grafo", en: "your graph" },
  dgOtroGrafo: { es: "otro grafo", en: "another graph" },
  leyenda1B: { es: "Aislamiento estructural", en: "Structural isolation" },
  leyenda1P: {
    es: "Tu información vive en un grafo separado, con su propio usuario de base de datos y su propio proceso. No depende de que un filtro esté bien escrito.",
    en: "Your information lives in a separate graph, with its own database user and its own process. It doesn't rely on a filter being written correctly.",
  },
  leyenda2B: { es: "Qué guarda el grafo", en: "What the graph stores" },
  leyenda2P: {
    es: "El texto original de cada documento, las personas y empresas que aparecen en él y cómo se relacionan, y la vigencia de cada dato: desde cuándo y hasta cuándo fue verdad.",
    en: "The original text of every document, the people and companies that appear in it and how they relate, and the validity of each fact: from when and until when it was true.",
  },
  leyenda3B: { es: "Nada se borra", en: "Nothing is deleted" },
  leyenda3P: {
    es: "Un dato nuevo que contradice a otro lo cierra con fecha. El anterior sigue ahí, consultable, marcado como histórico.",
    en: "A new fact that contradicts an older one closes it with a date. The old one is still there, still queryable, marked as historical.",
  },

  conectarH2: { es: "Tres pasos, una sola vez.", en: "Three steps, once." },
  paso1Pre: { es: "En Claude, abre", en: "In Claude, open" },
  paso1F1: { es: "Ajustes → Conectores", en: "Settings → Connectors" },
  paso1Med: { es: "y elige", en: "and choose" },
  paso1F2: { es: "Agregar conector personalizado", en: "Add custom connector" },
  pasoPega: { es: "Pega esta dirección:", en: "Paste this address:" },
  botonCopiar: { es: "Copiar", en: "Copy" },
  pasoLogin: {
    es: "Inicia sesión cuando se abra la ventana. Listo: tu cerebro queda disponible en todas tus conversaciones.",
    en: "Sign in when the window opens. That's it: your brain is available in every conversation.",
  },
  autoPre: {
    es: "¿Prefieres control total? El proyecto es abierto y puedes",
    en: "Prefer full control? The project is open source and you can",
  },
  autoEnlace: {
    es: "levantarlo en tu propio servidor",
    en: "run the whole thing on your own server",
  },
  autoPost: { es: ".", en: "." },

  privH2: {
    es: "Guarda cosas sensibles — con cuidado.",
    en: "It stores sensitive things — carefully.",
  },
  priv1T: { es: "Contraseñas y tokens: no", en: "Passwords and tokens: no" },
  priv1P: {
    es: "Claves, tokens y números de tarjeta se detectan y se reemplazan antes de escribir nada. Se guarda que la credencial existe y dónde está, nunca su valor.",
    en: "Passwords, tokens and card numbers are detected and redacted before anything is written. What gets stored is that the credential exists and where it is, never its value.",
  },
  priv2T: { es: "Salud y finanzas: sí", en: "Health and finances: yes" },
  priv2P: {
    es: "Exámenes, contratos y cuentas se guardan marcados como sensibles, dentro de tu grafo aislado. Y el código es público: puedes auditar exactamente qué ocurre.",
    en: "Test results, contracts and accounts are stored flagged as sensitive, inside your isolated graph. And the code is public: you can audit exactly what happens.",
  },
  priv3T: { es: "Salida sin fricción", en: "Frictionless exit" },
  priv3P: {
    es: "Tu memoria entera se descarga en un archivo cuando quieras: el texto de tus documentos, quiénes aparecen en ellos y cada dato con su vigencia. Sin pedirle permiso a nadie.",
    en: "Your whole memory downloads to a single file whenever you want: the text of your documents, who appears in them and every fact with its dates. Without asking anyone's permission.",
  },

  footTag: {
    es: "secondbrain · memoria temporal para Claude",
    en: "secondbrain · temporal memory for Claude",
  },
  footCodigo: { es: "Código en GitHub", en: "Code on GitHub" },
  footSobre: { es: "construido sobre", en: "built on" },
  footY: { es: "y", en: "and" },

  regCerradoT: { es: "Registro cerrado por ahora", en: "Signups closed for now" },
  regCerradoP: {
    es: "Esta instancia no está aceptando cuentas nuevas en este momento. Si ya tienes una, puedes entrar; y si quieres tu propio espacio, el proyecto es abierto.",
    en: "This instance isn't accepting new accounts right now. If you already have one you can sign in; and if you want your own space, the project is open source.",
  },
  regInviteT: { es: "¿Todavía no tienes cuenta?", en: "Don't have an account yet?" },
  regInviteP: {
    es: "El acceso es por invitación: necesitas un código para crear tu espacio. Si ya lo tienes, regístrate y en el mismo momento se crea tu grafo privado. Si ya tienes cuenta, puedes entrar con Google.",
    en: "Access is by invitation: you need a code to create your space. If you already have one, sign up and your private graph is created there and then. If you already have an account, you can sign in with Google.",
  },
  regAbiertoT: { es: "¿Todavía no tienes cuenta?", en: "Don't have an account yet?" },
  regAbiertoP: {
    es: "El registro está abierto: no necesitas código ni invitación de nadie. Crea tu cuenta —con correo o con Google— y en el mismo momento se prepara tu grafo privado. Los cupos de esta instancia son limitados: se atienden por orden de llegada.",
    en: "Signups are open: no code, no invitation from anyone. Create your account — with email or with Google — and your private graph is prepared there and then. Places on this instance are limited and served first come, first served.",
  },
  btnYaTengo: { es: "Ya tengo cuenta", en: "I already have an account" },
  btnCrear: { es: "Crear cuenta", en: "Sign up" },
  btnCrearGratis: { es: "Crear cuenta gratis", en: "Sign up free" },

  respVigente: { es: "Respuesta vigente", en: "Current answer" },
  respEn: { es: "Respuesta en ", en: "Answer in " },
  vigenteDesde: { es: "vigente desde ", en: "current since " },
  stampVigente: { es: "vigente", en: "current" },
  stampArchivado: { es: "archivado", en: "archived" },
  sinRegistroValor: { es: "Todavía no había registro", en: "No record yet" },
  stampSinRegistro: { es: "sin registro", en: "no record" },
  copiado: { es: "Copiado ✓", en: "Copied ✓" },
  copiaMano: { es: "Copia a mano", en: "Copy it by hand" },
};

/**
 * Literal JavaScript seguro para incrustar en el `<script>` de la página.
 * `JSON.stringify` cita y escapa; el `<` se neutraliza aparte para que un texto
 * que contuviera `</script>` no cierre el bloque.
 */
function litJs(texto: string): string {
  return JSON.stringify(texto).replace(/</g, "\\u003c");
}

export function landingPageHtml(
  baseUrl: string,
  registrationMode: RegistrationMode = "open",
  opts: { idioma?: Idioma; url?: string } = {},
): string {
  const idioma = opts.idioma ?? "es";
  const t = traductor(T, idioma);
  // baseUrl viene de la configuración, pero se escapa igual: ningún valor
  // interpolado entra crudo en el HTML (defensa en profundidad).
  const mcpUrl = escapeHtml(baseUrl.replace(/\/$/, "") + "/mcp");
  // El selector solo aparece cuando quien llama resolvió un idioma: sin él la
  // página se sirve exactamente como antes.
  const selector = opts.idioma ? selectorIdioma(opts.url ?? "/", opts.idioma) : "";
  // La tarjeta "¿Todavía no tienes cuenta?" cambia con REGISTRATION_MODE: en
  // `open` no se menciona ningún código porque no existe.
  const registroCard =
    registrationMode === "closed"
      ? `<h3>${t("regCerradoT")}</h3>
      <p>${t("regCerradoP")}</p>
      <div class="cta-row" style="margin-top:.6rem">
        <a class="btn" href="/login">${t("btnYaTengo")}</a>
      </div>`
      : registrationMode === "invite"
        ? `<h3>${t("regInviteT")}</h3>
      <p>${t("regInviteP")}</p>
      <div class="cta-row" style="margin-top:.6rem">
        <a class="btn" href="/registro">${t("btnCrear")}</a>
        <a class="btn ghost" href="/login">${t("btnYaTengo")}</a>
      </div>`
        : `<h3>${t("regAbiertoT")}</h3>
      <p>${t("regAbiertoP")}</p>
      <div class="cta-row" style="margin-top:.6rem">
        <a class="btn" href="/registro">${t("btnCrearGratis")}</a>
        <a class="btn ghost" href="/login">${t("btnYaTengo")}</a>
      </div>`;

  return `<!doctype html>
<html lang="${idioma}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${t("docTitulo")}</title>
<meta name="description" content="${escapeHtml(t("docDescripcion"))}" />
<script>
  /* Tema antes del primer pintado: sin parpadeo. La clase "js" habilita las animaciones
     de entrada: sin JavaScript el contenido se ve completo desde el inicio. */
  (function () {
    var r = document.documentElement;
    r.className += " js";
    try {
      var t = localStorage.getItem("sb-theme");
      if (t === "light" || t === "dark") r.setAttribute("data-theme", t);
    } catch (e) {}
  })();
</script>
<style>
  :root {
    /* El navegador pinta sus propias superficies (barras de desplazamiento, el
       lienzo antes de aplicar el CSS) según esto: sin declararlo, forzar el tema
       oscuro deja barras claras sobre una página negra. */
    color-scheme: light dark;
    --paper: #f1eee8;
    --surface: #fbf9f5;
    --surface-2: #eae5dc;
    --line: #d7d1c6;
    --line-soft: #e4dfd5;
    --text: #16201f;
    --muted: #5d6763;
    --vigente: #1d7364;
    --vigente-soft: #d8ebe6;
    /* Texto sobre el acento y acento legible sobre fondos suaves (WCAG AA). */
    --on-accent: #ffffff;
    --accent-text: #155a4e;
    --historico: #a8836b;
    --historico-soft: #ece2da;
    --shadow: 0 1px 2px rgba(16,21,31,.05), 0 18px 44px -26px rgba(16,21,31,.45);
    --grain: .30;
    --display: "Iowan Old Style", "Hoefler Text", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --maxw: 70rem;
    --ease: cubic-bezier(.16, 1, .3, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0a0f0f; --surface: #111817; --surface-2: #18211f; --line: #26312e; --line-soft: #1e2725;
      --text: #e7ece9; --muted: #93a29c;
      --vigente: #4fbfa6; --vigente-soft: #12312c;
      --on-accent: #08201c; --accent-text: #4fbfa6; --historico: #c2a189; --historico-soft: #2a2119;
      --shadow: 0 1px 2px rgba(0,0,0,.5), 0 24px 50px -28px rgba(0,0,0,.9);
      --grain: .22;
    }
  }
  :root[data-theme="dark"] {
    --paper: #0a0f0f; --surface: #111817; --surface-2: #18211f; --line: #26312e; --line-soft: #1e2725;
    --text: #e7ece9; --muted: #93a29c;
    --vigente: #4fbfa6; --vigente-soft: #12312c;
    --on-accent: #08201c; --accent-text: #4fbfa6; --historico: #c2a189; --historico-soft: #2a2119;
    --shadow: 0 1px 2px rgba(0,0,0,.5), 0 24px 50px -28px rgba(0,0,0,.9);
    --grain: .22;
  }
  :root[data-theme="dark"] { color-scheme: dark; }
  :root[data-theme="light"] {
    color-scheme: light;
    --paper: #f1eee8; --surface: #fbf9f5; --surface-2: #eae5dc; --line: #d7d1c6; --line-soft: #e4dfd5;
    --text: #16201f; --muted: #5d6763;
    --vigente: #1d7364; --vigente-soft: #d8ebe6;
    --on-accent: #ffffff; --accent-text: #155a4e; --historico: #a8836b; --historico-soft: #ece2da;
    --shadow: 0 1px 2px rgba(16,21,31,.05), 0 18px 44px -26px rgba(16,21,31,.45);
    --grain: .30;
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--paper); color: var(--text);
    font-family: var(--display); font-size: 17.5px; line-height: 1.62;
    -webkit-font-smoothing: antialiased; overflow-x: hidden;
  }
  /* Grano fijo sobre todo el documento: textura de papel, no decoración. */
  body::after {
    content: ""; position: fixed; inset: 0; z-index: 90; pointer-events: none;
    background-image: url("${GRAIN}");
    opacity: var(--grain); mix-blend-mode: soft-light;
  }
  .wrap { max-width: var(--maxw); margin-inline: auto; padding-inline: 1.6rem; }
  /* Los hijos de cualquier rejilla pueden encogerse: sin esto, una fila con
     texto que no parte (una cuenta bancaria, una fecha) ensancha la columna
     y desborda la página en móvil. */
  .hero > *, .grid > *, .flow > *, .diagram > *, .ledger > *, .card > *, .demo-body > * { min-width: 0; }
  a { color: inherit; }
  h1, h2, h3 { font-weight: 400; text-wrap: balance; margin: 0; }
  h1 { font-size: clamp(2.5rem, 6.4vw, 4.4rem); line-height: 1.02; letter-spacing: -.022em; }
  h2 { font-size: clamp(1.7rem, 3.6vw, 2.5rem); line-height: 1.12; letter-spacing: -.018em; }
  h3 { font-size: 1.15rem; line-height: 1.28; letter-spacing: -.01em; }
  p { margin: 0; }
  em { font-style: italic; }
  .eyebrow {
    font-family: var(--mono); font-size: .7rem; letter-spacing: .18em;
    text-transform: uppercase; color: var(--muted);
  }
  .lede { font-size: 1.16rem; color: var(--muted); max-width: 46ch; }
  ::selection { background: var(--vigente); color: var(--on-accent); }

  /* ---------- entrada escalonada (solo con JS) ---------- */
  .js .rv { opacity: 0; transform: translateY(16px); }
  .js .rv.in {
    opacity: 1; transform: none;
    transition: opacity .8s var(--ease), transform .8s var(--ease);
    transition-delay: calc(var(--i, 0) * 80ms);
  }

  /* ---------- nav ---------- */
  nav {
    position: sticky; top: 0; z-index: 40;
    border-bottom: 1px solid transparent; background: color-mix(in srgb, var(--paper) 88%, transparent);
    backdrop-filter: blur(10px) saturate(1.2);
    transition: border-color .3s ease, background .3s ease;
  }
  nav.stuck { border-bottom-color: var(--line); }
  /* La fila envuelve en vez de desbordar: overflow-x hidden en el body
     recortaría lo que sobresalga y dejaría el botón de tema inalcanzable. */
  nav .wrap { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .3rem 1rem; min-height: 64px; padding-block: .5rem; }
  .brand { min-width: 0; }
  .brand { display: flex; align-items: baseline; gap: .55rem; font-size: 1.2rem; letter-spacing: -.01em; }
  .brand span { font-family: var(--mono); font-size: .64rem; letter-spacing: .16em; color: var(--vigente); text-transform: uppercase; }
  .navright { display: flex; align-items: center; gap: 1.3rem; }
  .navlinks { display: flex; gap: 1.35rem; font-family: var(--sans); font-size: .88rem; color: var(--muted); }
  .navlinks a { text-decoration: none; position: relative; padding-block: .2rem; white-space: nowrap; }
  .navlinks a::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 1px;
    background: var(--vigente); transform: scaleX(0); transform-origin: left;
    transition: transform .35s var(--ease);
  }
  .navlinks a:hover { color: var(--text); }
  .navlinks a:hover::after { transform: scaleX(1); }
  /* En pantallas estrechas se caen los enlaces de ancla (que solo repiten lo
     que se ve al bajar) pero se mantienen los destinos reales. */
  @media (max-width: 860px) { .navlinks { gap: 1rem; font-size: .84rem; } .navlinks .anchor { display: none; } }
  @media (max-width: 520px) { .navlinks .sec { display: none; } .brand span { display: none; } }
  .theme {
    display: grid; place-items: center; width: 34px; height: 34px; flex: none;
    border: 1px solid var(--line); border-radius: 50%; background: transparent;
    color: var(--muted); cursor: pointer; transition: color .2s, border-color .2s, transform .2s var(--ease);
  }
  .theme:hover { color: var(--vigente); border-color: var(--vigente); transform: rotate(-18deg); }
  .theme svg { width: 15px; height: 15px; }
  .theme .moon { display: none; }
  @media (prefers-color-scheme: dark) { .theme .moon { display: block; } .theme .sun { display: none; } }
  :root[data-theme="dark"] .theme .moon { display: block; }
  :root[data-theme="dark"] .theme .sun { display: none; }
  :root[data-theme="light"] .theme .sun { display: block; }
  :root[data-theme="light"] .theme .moon { display: none; }
  /* Selector de idioma: mismo lenguaje visual que en dashboard-layout.ts
     (monoespaciada en versalitas, marco fino), adaptado a la paleta de papel. */
  .idioma {
    font-family: var(--mono); font-size: .68rem; letter-spacing: .12em;
    text-transform: uppercase; text-decoration: none; color: var(--muted);
    border: 1px solid var(--line); border-radius: 2px; padding: .25rem .6rem;
    white-space: nowrap; flex: none; transition: color .2s, border-color .2s;
  }
  .idioma:hover { color: var(--accent-text); border-color: var(--vigente); }

  /* ---------- riel de secciones (la página es una línea de tiempo) ---------- */
  .rail {
    position: fixed; left: max(1.2rem, calc(50vw - var(--maxw) / 2 - 3.6rem));
    top: 50%; transform: translateY(-50%); z-index: 30;
    display: none; flex-direction: column; gap: .15rem;
  }
  @media (min-width: 1240px) { .rail { display: flex; } }
  .rail a {
    display: flex; align-items: center; gap: .5rem; text-decoration: none;
    font-family: var(--mono); font-size: .64rem; letter-spacing: .08em;
    color: var(--muted); opacity: .45; padding: .32rem 0;
    transition: color .3s ease, opacity .3s ease;
  }
  .rail .tick { width: 14px; height: 1px; background: currentColor; flex: none; transition: width .4s var(--ease); }
  .rail a:hover { opacity: 1; }
  .rail a:hover .tick { width: 22px; }
  .rail a.on { color: var(--vigente); opacity: 1; }
  .rail a.on .tick { width: 26px; }
  .sr {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
  }

  /* ---------- hero ---------- */
  header {
    position: relative; padding: clamp(3.2rem, 8vw, 6rem) 0 clamp(2.5rem, 6vw, 4rem);
    overflow: hidden;
  }
  /* Pauta de cuaderno que se desvanece + halo que sigue al puntero. */
  header::before {
    content: ""; position: absolute; inset: -10% -20% auto; height: 130%; pointer-events: none;
    background:
      radial-gradient(360px 360px at var(--mx, 72%) var(--my, 26%), color-mix(in srgb, var(--vigente) 14%, transparent), transparent 70%),
      repeating-linear-gradient(to bottom, color-mix(in srgb, var(--line) 42%, transparent) 0 1px, transparent 1px 36px);
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 38%, transparent 82%);
    mask-image: linear-gradient(to bottom, #000 0%, rgba(0,0,0,.55) 38%, transparent 82%);
  }
  .hero { position: relative; display: grid; grid-template-columns: 1fr; gap: 2.8rem; }
  @media (min-width: 950px) { .hero { grid-template-columns: 1.02fr 1fr; gap: 3.8rem; align-items: start; } }
  .hero-copy { display: flex; flex-direction: column; gap: 1.5rem; }
  h1 em { color: var(--vigente); position: relative; white-space: nowrap; }
  /* La subrayada se dibuja sola, como tinta secándose. */
  h1 em::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: .06em; height: 3px;
    background: currentColor; opacity: .32; border-radius: 2px;
    transform: scaleX(0); transform-origin: left;
  }
  .js h1 em::after { animation: ink 1.1s var(--ease) .75s forwards; }
  @keyframes ink { to { transform: scaleX(1); } }
  .cta-row { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; }
  .btn {
    display: inline-flex; align-items: center; gap: .5rem; text-decoration: none;
    font-family: var(--sans); font-size: .92rem; font-weight: 500;
    padding: .72rem 1.25rem; border-radius: 2px;
    border: 1px solid var(--vigente); background: var(--vigente); color: var(--on-accent);
    transition: transform .25s var(--ease), box-shadow .25s var(--ease), background .2s ease;
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--vigente) 40%, transparent);
  }
  .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 24px -12px color-mix(in srgb, var(--vigente) 80%, transparent); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--line); box-shadow: none; }
  .btn.ghost:hover { border-color: var(--vigente); color: var(--vigente); }
  .btn:focus-visible, a:focus-visible, button:focus-visible { outline: 2px solid var(--vigente); outline-offset: 3px; }
  .trust { display: flex; flex-wrap: wrap; gap: .5rem 1.2rem; font-family: var(--mono); font-size: .7rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
  .trust span { display: inline-flex; align-items: center; gap: .4rem; }
  .trust span::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--vigente); }

  /* ---------- expediente temporal (demo) ---------- */
  .demo {
    position: relative; background: var(--surface); border: 1px solid var(--line);
    border-radius: 3px; box-shadow: var(--shadow);
  }
  .demo::before {
    content: ""; position: absolute; inset: 4px; border: 1px solid var(--line-soft);
    border-radius: 2px; pointer-events: none;
  }
  .demo-head {
    position: relative; padding: .9rem 1.2rem; border-bottom: 1px solid var(--line);
    display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;
  }
  .demo-q { font-family: var(--mono); font-size: .8rem; color: var(--text); }
  .demo-q::before { content: "› "; color: var(--vigente); }
  .demo-body { position: relative; padding: 1.3rem 1.2rem 1.2rem; }
  .yearline { display: flex; align-items: baseline; gap: .7rem; }
  .year {
    font-size: 3.1rem; line-height: .95; font-variant-numeric: tabular-nums;
    letter-spacing: -.03em;
  }
  .year-tag {
    font-family: var(--mono); font-size: .62rem; letter-spacing: .14em; text-transform: uppercase;
    color: var(--accent-text); border: 1px solid currentColor; border-radius: 999px; padding: .1rem .5rem;
  }
  .year-tag[hidden] { display: none; }
  .answer {
    position: relative; margin-top: 1.1rem; padding: 1rem 1.05rem; border-radius: 2px;
    background: var(--vigente-soft); border: 1px solid color-mix(in srgb, var(--vigente) 35%, transparent);
    transition: background .45s ease, border-color .45s ease;
  }
  .answer.hist { background: var(--historico-soft); border-color: color-mix(in srgb, var(--historico) 45%, transparent); }
  .answer.none { background: var(--surface-2); border-color: var(--line); }
  .answer.none .label, .answer.none .value { color: var(--muted); }
  .answer .label {
    font-family: var(--mono); font-size: .64rem; letter-spacing: .16em;
    text-transform: uppercase; color: var(--accent-text); display: block; margin-bottom: .4rem;
  }
  .answer.hist .label { color: color-mix(in srgb, var(--historico) 75%, var(--text)); }
  .answer .value { font-size: 1.1rem; letter-spacing: -.01em; }
  .answer .range { font-family: var(--mono); font-size: .73rem; color: var(--muted); margin-top: .45rem; }
  .js .answer.flip .value, .js .answer.flip .range { animation: stamp .42s var(--ease); }
  @keyframes stamp {
    0% { opacity: 0; transform: translateY(6px) scale(.985); filter: blur(3px); }
    100% { opacity: 1; transform: none; filter: none; }
  }
  .stamp {
    position: absolute; right: .8rem; top: .7rem; transform: rotate(-7deg);
    font-family: var(--mono); font-size: .6rem; letter-spacing: .2em; text-transform: uppercase;
    border: 1.5px solid currentColor; border-radius: 2px; padding: .16rem .45rem;
    color: var(--vigente); opacity: .75;
  }
  .answer.hist .stamp { color: var(--historico); }
  .answer.none .stamp { color: var(--muted); }
  .js .answer.flip .stamp { animation: stampMark .5s var(--ease); }
  @keyframes stampMark {
    0% { opacity: 0; transform: rotate(-7deg) scale(1.5); }
    55% { opacity: .95; transform: rotate(-7deg) scale(.94); }
    100% { opacity: .75; transform: rotate(-7deg) scale(1); }
  }

  /* --- eje de tiempo con segmentos de vigencia --- */
  .slider-wrap { margin-top: 1.4rem; }
  .slider-wrap > .eyebrow { display: block; margin-bottom: .55rem; }
  .axis { position: relative; height: 44px; }
  .axis:has(input:focus-visible) { outline: 2px solid var(--vigente); outline-offset: 5px; border-radius: 3px; }
  .segs {
    position: absolute; left: 0; right: 0; top: 19px; height: 6px;
    background: repeating-linear-gradient(-45deg, var(--line-soft) 0 3px, transparent 3px 6px);
    border-radius: 3px; overflow: hidden;
  }
  .seg { position: absolute; top: 0; height: 100%; border-radius: 3px; }
  .seg.on { background: var(--vigente); }
  .seg.off { background: color-mix(in srgb, var(--historico) 60%, transparent); }
  .needle {
    position: absolute; top: 2px; bottom: 2px; width: 2px; margin-left: -1px;
    background: var(--text); pointer-events: none; transition: left .12s linear;
  }
  .needle::before {
    content: ""; position: absolute; top: -1px; left: 50%; width: 9px; height: 9px;
    margin-left: -4.5px; background: var(--text); transform: rotate(45deg);
  }
  /* Sin JavaScript el eje pintado (segmentos y aguja) nunca se dibuja, así que
     el deslizador se queda con su aspecto nativo en vez de parecer roto. */
  .segs, .needle { display: none; }
  .js .segs, .js .needle { display: block; }
  .axis input[type=range] { width: 100%; margin: 12px 0 0; accent-color: var(--vigente); cursor: ew-resize; }
  .js .axis input[type=range] {
    position: absolute; inset: 0; width: 100%; height: 100%; margin: 0;
    -webkit-appearance: none; appearance: none; background: transparent;
  }
  .js .axis input[type=range]::-webkit-slider-runnable-track { height: 44px; background: transparent; }
  .js .axis input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 26px; height: 44px; background: transparent; }
  .js .axis input[type=range]::-moz-range-track { height: 44px; background: transparent; }
  .js .axis input[type=range]::-moz-range-thumb { width: 26px; height: 44px; border: 0; background: transparent; }
  .ticks {
    display: flex; justify-content: space-between; font-family: var(--mono);
    font-size: .68rem; color: var(--muted); margin-top: .1rem; font-variant-numeric: tabular-nums;
  }

  /* --- registro completo --- */
  .history { margin-top: 1.3rem; border-top: 1px solid var(--line); padding-top: 1rem; }
  .history .eyebrow { display: block; margin-bottom: .7rem; }
  .rec {
    position: relative; display: flex; flex-wrap: wrap; gap: .2rem .75rem; align-items: baseline;
    padding: .5rem .65rem; border-radius: 2px; font-size: .93rem; margin-bottom: .3rem;
    transition: background .35s ease, color .35s ease;
  }
  .rec .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; transform: translateY(-2px); transition: background .35s ease, box-shadow .35s ease; }
  .rec .txt { position: relative; }
  .rec .txt::after {
    content: ""; position: absolute; left: -2px; right: -2px; top: 52%; height: 1px;
    background: currentColor; transform: scaleX(0); transform-origin: left;
    transition: transform .4s var(--ease);
  }
  .rec .when { font-family: var(--mono); font-size: .72rem; color: var(--muted); margin-left: auto; white-space: nowrap; }
  .rec.on { background: var(--vigente-soft); }
  .rec.on .dot { background: var(--vigente); box-shadow: 0 0 0 4px color-mix(in srgb, var(--vigente) 22%, transparent); }
  .rec.off { background: var(--historico-soft); color: var(--muted); }
  .rec.off .dot { background: var(--historico); }
  .rec.off .txt::after { transform: scaleX(1); }

  /* ---------- secciones ---------- */
  section { position: relative; padding: clamp(3.4rem, 7vw, 5.6rem) 0; border-top: 1px solid var(--line); }
  /* El nav es pegajoso y mide 64px: sin esto el título de cada sección aterriza
     debajo de él al saltar por un ancla. */
  section[id], header[id] { scroll-margin-top: 4.5rem; }
  .sec-head { display: flex; flex-direction: column; gap: .75rem; margin-bottom: 2.8rem; max-width: 54ch; }
  .sec-head .eyebrow { display: flex; align-items: center; gap: .6rem; }
  .sec-head .eyebrow::after { content: ""; height: 1px; width: 3rem; background: var(--line); }
  .grid { display: grid; gap: 1.15rem; }
  @media (min-width: 800px) { .grid.c2 { grid-template-columns: 1fr 1fr; gap: 1.6rem; } }

  /* --- pasos: una secuencia conectada, no cuatro tarjetas iguales --- */
  .flow { display: grid; gap: 2rem; counter-reset: paso; }
  @media (min-width: 860px) {
    .flow { grid-template-columns: repeat(4, 1fr); gap: 1.4rem; }
    .flow .step:nth-child(even) { margin-top: 2.4rem; }
  }
  .step { position: relative; display: flex; flex-direction: column; gap: .6rem; padding-top: 2.6rem; }
  .step::before {
    counter-increment: paso; content: "0" counter(paso);
    position: absolute; top: 0; left: 0; font-family: var(--mono); font-size: .72rem;
    letter-spacing: .14em; color: var(--vigente);
  }
  .step::after {
    content: ""; position: absolute; top: .55rem; left: 2.4rem; right: 0; height: 1px;
    background: linear-gradient(to right, var(--line), transparent);
  }
  .step p { color: var(--muted); font-size: .95rem; }

  /* --- líneas de conversación --- */
  .card {
    background: var(--surface); border: 1px solid var(--line); border-radius: 3px;
    padding: 1.5rem; display: flex; flex-direction: column; gap: .8rem;
  }
  .card p { color: var(--muted); font-size: .96rem; }
  .asklist { display: grid; gap: .55rem; }
  .quote {
    position: relative; font-family: var(--mono); font-size: .84rem; line-height: 1.5;
    background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 2px;
    padding: .7rem .85rem .7rem 1.5rem; color: var(--text);
    transition: border-color .3s ease, transform .3s var(--ease);
  }
  .quote::before { content: "›"; position: absolute; left: .7rem; color: var(--vigente); }
  .quote:hover { border-color: color-mix(in srgb, var(--vigente) 45%, transparent); transform: translateX(3px); }
  .quote .tool {
    display: block; margin-top: .35rem; font-size: .7rem; letter-spacing: .06em;
    color: var(--accent-text); opacity: 0; transform: translateY(-3px);
    transition: opacity .3s ease, transform .3s var(--ease);
  }
  .quote:hover .tool { opacity: 1; transform: none; }

  /* ---------- diagrama de aislamiento ---------- */
  .diagram { display: grid; gap: 1.2rem; }
  @media (min-width: 900px) { .diagram { grid-template-columns: 1.35fr 1fr; align-items: center; gap: 2.4rem; } }
  .diagram-frame {
    background: var(--surface); border: 1px solid var(--line); border-radius: 3px;
    padding: 1.2rem; overflow-x: auto;
  }
  .diagram svg { display: block; width: 100%; height: auto; min-width: 30rem; }
  .dg-box { fill: var(--surface-2); stroke: var(--line); }
  .dg-box.mine { fill: var(--vigente-soft); stroke: var(--vigente); }
  .dg-box.other { opacity: .45; }
  .dg-t { font-family: var(--mono); font-size: 11px; fill: var(--text); }
  .dg-t.dim { fill: var(--muted); }
  .dg-t.acc { fill: var(--accent-text); }
  .dg-line { stroke: var(--line); stroke-width: 1.4; fill: none; }
  .dg-line.live { stroke: var(--vigente); stroke-dasharray: 5 5; }
  .js .dg-line.live { animation: march 1.4s linear infinite; }
  @keyframes march { to { stroke-dashoffset: -20; } }
  .dg-x { stroke: var(--historico); stroke-width: 1.4; }
  .legend { display: grid; gap: .9rem; }
  .legend div { display: grid; gap: .2rem; }
  .legend b { font-family: var(--mono); font-size: .68rem; letter-spacing: .14em; text-transform: uppercase; color: var(--vigente); font-weight: 400; }
  .legend p { color: var(--muted); font-size: .95rem; }

  /* ---------- conectar ---------- */
  .steps { display: grid; gap: 1.1rem; counter-reset: s; }
  .stepline { display: grid; grid-template-columns: auto 1fr; gap: .95rem; align-items: start; }
  .stepline::before {
    counter-increment: s; content: counter(s);
    font-family: var(--mono); font-size: .75rem; width: 1.75rem; height: 1.75rem;
    display: grid; place-items: center; border: 1px solid var(--vigente);
    color: var(--vigente); border-radius: 50%; flex: none;
  }
  .copy {
    display: flex; align-items: center; gap: .6rem; margin-top: .55rem;
    font-family: var(--mono); font-size: .88rem; background: var(--surface-2);
    border: 1px dashed color-mix(in srgb, var(--vigente) 60%, transparent); border-radius: 2px;
    padding: .5rem .6rem .5rem .8rem; width: 100%;
  }
  .copy code { overflow-wrap: anywhere; }
  .copy button {
    margin-left: auto; font: inherit; font-size: .7rem; letter-spacing: .12em; text-transform: uppercase;
    background: transparent; border: 1px solid var(--line); border-radius: 2px; color: var(--muted);
    padding: .25rem .55rem; cursor: pointer; white-space: nowrap;
    transition: color .2s, border-color .2s, background .2s;
  }
  .copy button:hover { color: var(--vigente); border-color: var(--vigente); }
  .copy button.done { color: var(--on-accent); background: var(--vigente); border-color: var(--vigente); }

  /* ---------- privacidad ---------- */
  .ledger { display: grid; gap: 0; border-top: 1px solid var(--line); }
  .row {
    display: grid; grid-template-columns: auto 1fr; gap: 1rem 1.1rem; align-items: start;
    padding: 1.4rem 0; border-bottom: 1px solid var(--line);
  }
  @media (min-width: 760px) { .row { grid-template-columns: auto 14rem 1fr; align-items: baseline; } }
  .mark {
    width: 1.7rem; height: 1.7rem; border-radius: 50%; display: grid; place-items: center;
    font-family: var(--mono); font-size: .85rem; flex: none;
  }
  .mark.yes { color: var(--accent-text); border: 1px solid var(--vigente); background: var(--vigente-soft); }
  .mark.no { color: color-mix(in srgb, var(--historico) 70%, var(--text)); border: 1px solid var(--historico); background: var(--historico-soft); }
  .row p { color: var(--muted); font-size: .97rem; }

  footer { border-top: 1px solid var(--line); padding: 2.6rem 0 3.6rem; color: var(--muted); font-size: .9rem; }
  footer a { color: var(--vigente); }
  .foot-row { display: flex; flex-wrap: wrap; gap: 1.2rem; justify-content: space-between; align-items: baseline; }

  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { transition: none !important; animation: none !important; }
    .js .rv { opacity: 1; transform: none; }
    .js h1 em::after { transform: scaleX(1); }
  }
</style>
</head>
<body>

<nav id="nav"><div class="wrap">
  <div class="brand">secondbrain <span>mybrain.rlz.cl</span></div>
  <div class="navright">
    <div class="navlinks">
      <a class="anchor" href="#como">${t("navComo")}</a>
      <a class="anchor" href="#usar">${t("navUsar")}</a>
      <a class="anchor" href="#conectar">${t("navConectar")}</a>
      <a href="/guia">${t("navGuia")}</a>
      <a href="/cuenta">${t("navCuenta")}</a>
      <a class="sec" href="https://github.com/jpreyestCL/secondbrain">GitHub</a>
    </div>
    ${selector}
    <button class="theme" id="theme" type="button" aria-label="${t("temaAria")}">
      <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"/></svg>
      <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.3 8.3 0 1 0 20 14.5Z"/></svg>
    </button>
  </div>
</div></nav>

<nav class="rail" id="rail" aria-label="${t("railAria")}">
  <a href="#como"><span class="tick"></span>01<span class="sr"> · ${t("navComo")}</span></a>
  <a href="#usar"><span class="tick"></span>02<span class="sr"> · ${t("navUsar")}</span></a>
  <a href="#esquema"><span class="tick"></span>03<span class="sr"> · ${t("railEsquema")}</span></a>
  <a href="#conectar"><span class="tick"></span>04<span class="sr"> · ${t("navConectar")}</span></a>
  <a href="#privacidad"><span class="tick"></span>05<span class="sr"> · ${t("railPrivacidad")}</span></a>
</nav>

<header id="hero"><div class="wrap hero">
  <div class="hero-copy">
    <p class="eyebrow rv" style="--i:0">${t("heroEyebrow")}</p>
    <h1 class="rv" style="--i:1">${t("heroTituloPre")} <em>${t("heroTituloEm")}</em>.</h1>
    <p class="lede rv" style="--i:2">
      ${t("heroLede")}
    </p>
    <div class="cta-row rv" style="--i:3">
      <a class="btn" href="#conectar">${t("ctaConectar")}</a>
      <a class="btn ghost" href="https://github.com/jpreyestCL/secondbrain">${t("ctaCodigo")}</a>
    </div>
    <div class="trust rv" style="--i:4">
      <span>${t("trust1")}</span>
      <span>${t("trust2")}</span>
      <span>${t("trust3")}</span>
    </div>
  </div>

  <div class="demo rv" style="--i:3">
    <div class="demo-head">
      <span class="demo-q">${t("demoPregunta")}</span>
      <span class="eyebrow">${t("demoArrastra")}</span>
    </div>
    <div class="demo-body">
      <div class="yearline">
        <div class="year" id="yr">2026</div>
        <span class="year-tag" id="ytag">${t("demoHoy")}</span>
      </div>
      <div class="answer" aria-live="polite">
        <span class="label" id="alabel">${t("respVigente")}</span>
        <div class="value" id="aval">Banco Santander · 789-012-345</div>
        <div class="range" id="arange">${t("vigenteDesde")}2024</div>
        <span class="stamp" id="stamp">${t("stampVigente")}</span>
      </div>
      <div class="slider-wrap">
        <label class="eyebrow" for="sl">${t("demoLineaTiempo")}</label>
        <!-- Sin aria-label: el nombre accesible debe ser la etiqueta visible
             ("Línea de tiempo", WCAG 2.5.3). min=2010 hace alcanzable el
             tramo anterior al primer registro. -->
        <div class="axis">
          <div class="segs" id="segs"></div>
          <div class="needle" id="needle" style="left:100%"></div>
          <input id="sl" type="range" min="2010" max="2026" value="2026" step="1" />
        </div>
        <div class="ticks"><span>2010</span><span>2018</span><span>2026</span></div>
      </div>
      <div class="history">
        <span class="eyebrow">${t("demoRegistro")}</span>
        <div id="recs"></div>
      </div>
    </div>
  </div>
</div></header>

<section id="como"><div class="wrap">
  <div class="sec-head rv">
    <p class="eyebrow">${t("navComo")}</p>
    <h2>${t("comoH2")}</h2>
    <p class="lede">${t("comoLede")}</p>
  </div>
  <div class="flow">
    <div class="step rv" style="--i:0">
      <h3>${t("paso1T")}</h3>
      <p>${t("paso1P")}</p>
    </div>
    <div class="step rv" style="--i:1">
      <h3>${t("paso2T")}</h3>
      <p>${t("paso2P")}</p>
    </div>
    <div class="step rv" style="--i:2">
      <h3>${t("paso3T")}</h3>
      <p>${t("paso3P")}</p>
    </div>
    <div class="step rv" style="--i:3">
      <h3>${t("paso4T")}</h3>
      <p>${t("paso4P")}</p>
    </div>
  </div>
</div></section>

<section id="usar"><div class="wrap">
  <div class="sec-head rv">
    <p class="eyebrow">${t("navUsar")}</p>
    <h2>${t("usarH2")}</h2>
  </div>
  <div class="grid c2">
    <div class="card rv" style="--i:0">
      <h3>${t("usarGuardar")}</h3>
      <div class="asklist">
        <div class="quote">${t("q1")}
          <span class="tool">${t("q1tool")}</span></div>
        <div class="quote">${t("q2")}
          <span class="tool">${t("q2tool")}</span></div>
        <div class="quote">${t("q3pre")} <em>${t("q3em")}</em> ${t("q3post")}
          <span class="tool">${t("q3tool")}</span></div>
      </div>
    </div>
    <div class="card rv" style="--i:1">
      <h3>${t("usarConsultar")}</h3>
      <div class="asklist">
        <div class="quote">${t("q4")}
          <span class="tool">${t("q4tool")}</span></div>
        <div class="quote">${t("q5")}
          <span class="tool">${t("q5tool")}</span></div>
        <div class="quote">${t("q6")}
          <span class="tool">${t("q6tool")}</span></div>
      </div>
    </div>
  </div>
</div></section>

<section id="esquema"><div class="wrap">
  <div class="sec-head rv">
    <p class="eyebrow">${t("railEsquema")}</p>
    <h2>${t("esquemaH2")}</h2>
  </div>
  <div class="diagram">
    <div class="diagram-frame rv">
      <svg viewBox="0 0 560 290" role="img" aria-label="${escapeHtml(t("svgAria"))}">
        <rect class="dg-box" x="150" y="8" width="260" height="40" rx="3"/>
        <text class="dg-t" x="280" y="33" text-anchor="middle">${t("dgClaude")}</text>

        <path class="dg-line live" d="M280 48 L280 94"/>
        <path class="dg-line" d="M274 88 L280 96 L286 88"/>
        <text class="dg-t acc" x="292" y="76">${t("dgMcp")}</text>

        <rect class="dg-box mine" x="150" y="96" width="260" height="42" rx="3"/>
        <text class="dg-t" x="280" y="122" text-anchor="middle">${t("dgGateway")}</text>

        <path class="dg-line live" d="M240 138 L240 168 L150 168 L150 196"/>
        <path class="dg-line" d="M320 138 L320 168 L410 168 L410 196"/>

        <rect class="dg-box mine" x="45" y="196" width="210" height="38" rx="3"/>
        <text class="dg-t" x="150" y="220" text-anchor="middle">${t("dgTuProceso")}</text>
        <rect class="dg-box other" x="305" y="196" width="210" height="38" rx="3"/>
        <text class="dg-t dim" x="410" y="220" text-anchor="middle">${t("dgOtroProceso")}</text>

        <path class="dg-line live" d="M150 234 L150 252"/>
        <path class="dg-line" d="M410 234 L410 252"/>

        <rect class="dg-box mine" x="45" y="252" width="210" height="34" rx="3"/>
        <text class="dg-t" x="150" y="274" text-anchor="middle">${t("dgTuGrafo")}</text>
        <rect class="dg-box other" x="305" y="252" width="210" height="34" rx="3"/>
        <text class="dg-t dim" x="410" y="274" text-anchor="middle">${t("dgOtroGrafo")}</text>

        <path class="dg-x" stroke-dasharray="4 4" d="M255 269 L305 269"/>
        <path class="dg-x" d="M273 262 L287 276 M287 262 L273 276"/>
      </svg>
    </div>
    <div class="legend rv" style="--i:1">
      <div>
        <b>${t("leyenda1B")}</b>
        <p>${t("leyenda1P")}</p>
      </div>
      <div>
        <b>${t("leyenda2B")}</b>
        <p>${t("leyenda2P")}</p>
      </div>
      <div>
        <b>${t("leyenda3B")}</b>
        <p>${t("leyenda3P")}</p>
      </div>
    </div>
  </div>
</div></section>

<section id="conectar"><div class="wrap">
  <div class="sec-head rv">
    <p class="eyebrow">${t("navConectar")}</p>
    <h2>${t("conectarH2")}</h2>
  </div>
  <div class="grid c2">
    <div class="card rv" style="--i:0">
      <div class="steps">
        <div class="stepline"><div>${t("paso1Pre")} <strong>${t("paso1F1")}</strong> ${t("paso1Med")}
          <strong>${t("paso1F2")}</strong>.</div></div>
        <div class="stepline"><div>${t("pasoPega")}
          <span class="copy"><code id="mcp">${mcpUrl}</code><button type="button" id="copy" hidden>${t("botonCopiar")}</button></span></div></div>
        <div class="stepline"><div>${t("pasoLogin")}</div></div>
      </div>
    </div>
    <div class="card rv" style="--i:1">
      ${registroCard}
      <p style="margin-top:.4rem">${t("autoPre")}
        <a href="https://github.com/jpreyestCL/secondbrain">${t("autoEnlace")}</a>${t("autoPost")}</p>
    </div>
  </div>
</div></section>

<section id="privacidad"><div class="wrap">
  <div class="sec-head rv">
    <p class="eyebrow">${t("railPrivacidad")}</p>
    <h2>${t("privH2")}</h2>
  </div>
  <div class="ledger">
    <div class="row rv" style="--i:0">
      <span class="mark no" aria-hidden="true">✕</span>
      <h3>${t("priv1T")}</h3>
      <p>${t("priv1P")}</p>
    </div>
    <div class="row rv" style="--i:1">
      <span class="mark yes" aria-hidden="true">✓</span>
      <h3>${t("priv2T")}</h3>
      <p>${t("priv2P")}</p>
    </div>
    <div class="row rv" style="--i:2">
      <span class="mark yes" aria-hidden="true">↓</span>
      <h3>${t("priv3T")}</h3>
      <p>${t("priv3P")}</p>
    </div>
  </div>
</div></section>

<footer><div class="wrap foot-row">
  <span>${t("footTag")}</span>
  <span>
    <a href="/guia">${t("navGuia")}</a> ·
    <a href="/cuenta">${t("navCuenta")}</a> ·
    <a href="https://github.com/jpreyestCL/secondbrain">${t("footCodigo")}</a> ·
    ${t("footSobre")} <a href="https://github.com/getzep/graphiti">Graphiti</a> ${t("footY")}
    <a href="https://www.falkordb.com/">FalkorDB</a>
  </span>
</div></footer>

<script>
(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- tema ---------- */
  var themeBtn = document.getElementById("theme");
  themeBtn.addEventListener("click", function () {
    var root = document.documentElement;
    var dark = root.getAttribute("data-theme")
      ? root.getAttribute("data-theme") === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("sb-theme", next); } catch (e) {}
  });

  /* ---------- entrada escalonada + riel de secciones ---------- */
  var revealables = document.querySelectorAll(".rv");
  if (!("IntersectionObserver" in window) || reduce) {
    for (var k = 0; k < revealables.length; k++) revealables[k].classList.add("in");
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    for (var m = 0; m < revealables.length; m++) {
      // Lo que ya está en pantalla se muestra de inmediato: en una pestaña de
      // fondo el observador no dispara hasta que la pestaña se ve, y el héroe
      // no puede quedarse en blanco esperando.
      var box = revealables[m].getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) revealables[m].classList.add("in");
      else io.observe(revealables[m]);
    }
  }

  var railLinks = document.querySelectorAll("#rail a");
  if ("IntersectionObserver" in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        for (var i = 0; i < railLinks.length; i++) {
          railLinks[i].classList.toggle(
            "on",
            railLinks[i].getAttribute("href") === "#" + e.target.id
          );
        }
      });
    }, { rootMargin: "-45% 0px -45% 0px" });
    var secs = document.querySelectorAll("section[id]");
    for (var n = 0; n < secs.length; n++) spy.observe(secs[n]);
  }

  var nav = document.getElementById("nav");
  var onScroll = function () { nav.classList.toggle("stuck", window.scrollY > 8); };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- halo que sigue al puntero en el héroe ---------- */
  var hero = document.getElementById("hero");
  if (!reduce && window.matchMedia("(hover: hover)").matches) {
    var pending = false, px = 0, py = 0;
    hero.addEventListener("pointermove", function (ev) {
      var box = hero.getBoundingClientRect();
      px = ((ev.clientX - box.left) / box.width) * 100;
      py = ((ev.clientY - box.top) / box.height) * 100;
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        hero.style.setProperty("--mx", px.toFixed(1) + "%");
        hero.style.setProperty("--my", py.toFixed(1) + "%");
        pending = false;
      });
    });
  }

  /* ---------- copiar la dirección MCP ---------- */
  /* En un contexto inseguro (http plano, que es justo el caso de quien se
     autoaloja) navigator.clipboard no existe. Antes el botón se quedaba mudo;
     ahora sencillamente no aparece y la dirección se copia a mano. */
  var copyBtn = document.getElementById("copy");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    copyBtn.hidden = false;
    copyBtn.addEventListener("click", function () {
      var text = document.getElementById("mcp").textContent;
      var flash = function (label, ok) {
        copyBtn.textContent = label;
        copyBtn.classList.toggle("done", ok);
        setTimeout(function () {
          copyBtn.textContent = ${litJs(t("botonCopiar"))};
          copyBtn.classList.remove("done");
        }, 1800);
      };
      navigator.clipboard.writeText(text).then(
        function () { flash(${litJs(t("copiado"))}, true); },
        function () { flash(${litJs(t("copiaMano"))}, false); }
      );
    });
  }

  /* ---------- expediente temporal ---------- */
  var MIN = 2010, MAX = 2026;
  var RECS = [
    { txt: "Banco Estado · 44-556-677",     from: 2014, to: 2018 },
    { txt: "Banco de Chile · 123-456-789",  from: 2018, to: 2024 },
    { txt: "Banco Santander · 789-012-345", from: 2024, to: null }
  ];
  var sl = document.getElementById("sl");
  var yr = document.getElementById("yr");
  var ytag = document.getElementById("ytag");
  var answer = document.querySelector(".answer");
  var aval = document.getElementById("aval");
  var arange = document.getElementById("arange");
  var alabel = document.getElementById("alabel");
  var stamp = document.getElementById("stamp");
  var recs = document.getElementById("recs");
  var answerLive = document.querySelector(".answer");
  var segs = document.getElementById("segs");
  var needle = document.getElementById("needle");
  var last = null;

  function pct(y) { return ((y - MIN) / (MAX - MIN)) * 100; }

  function fmt(r) {
    return r.to === null ? ${litJs(t("vigenteDesde"))} + r.from : r.from + " — " + r.to;
  }

  /* Barra de vigencias: cada registro ocupa su tramo real del eje. */
  (function paintSegments() {
    var html = "";
    for (var i = 0; i < RECS.length; i++) {
      var r = RECS[i];
      var a = pct(r.from), b = pct(r.to === null ? MAX : r.to);
      var w = Math.max(b - a, 1.5);
      html += '<span class="seg ' + (r.to === null ? "on" : "off") + '" style="left:' +
              a.toFixed(2) + '%;width:' + w.toFixed(2) + '%"></span>';
    }
    segs.innerHTML = html;
  })();

  function render(y) {
    yr.textContent = String(y);
    ytag.hidden = y < MAX;
    needle.style.left = pct(y) + "%";

    var active = null;
    for (var i = 0; i < RECS.length; i++) {
      var r = RECS[i];
      if (y >= r.from && (r.to === null || y < r.to)) { active = r; break; }
    }

    var key = active ? active.txt : "—";
    if (key !== last) {
      answer.classList.remove("flip");
      void answer.offsetWidth;
      answer.classList.add("flip");
      last = key;
    }

    answer.classList.toggle("hist", !!active && active.to !== null);
    answer.classList.toggle("none", !active);
    if (active) {
      aval.textContent = active.txt;
      arange.textContent = fmt(active);
      alabel.textContent = (y >= MAX) ? ${litJs(t("respVigente"))} : ${litJs(t("respEn"))} + y;
      stamp.textContent = active.to === null ? ${litJs(t("stampVigente"))} : ${litJs(t("stampArchivado"))};
    } else {
      aval.textContent = ${litJs(t("sinRegistroValor"))};
      arange.textContent = "—";
      alabel.textContent = ${litJs(t("respEn"))} + y;
      stamp.textContent = ${litJs(t("stampSinRegistro"))};
    }

    var html = "";
    for (var j = 0; j < RECS.length; j++) {
      var rec = RECS[j];
      var on = (y >= rec.from && (rec.to === null || y < rec.to));
      html += '<div class="rec ' + (on ? "on" : "off") + '">' +
                '<span class="dot"></span>' +
                '<span class="txt">' + rec.txt + '</span>' +
                '<span class="when">' + fmt(rec) + '</span>' +
              '</div>';
    }
    recs.innerHTML = html;
  }

  sl.addEventListener("input", function () { stop(); render(parseInt(sl.value, 10)); });
  render(parseInt(sl.value, 10));

  /* La respuesta vive en una región aria-live. El recorrido automático la
     reescribe ~26 veces seguidas, así que mientras dura se silencia: un lector
     de pantalla no puede quedar atrapado en una cola de anuncios que nadie
     pidió. Se reactiva en cuanto el recorrido termina o el usuario interviene. */
  function live(on) { answerLive.setAttribute("aria-live", on ? "polite" : "off"); }

  /* Una pasada automática al cargar para que se entienda el gesto; cualquier
     interacción la cancela y devuelve el control. */
  var tour = null;
  var voiceBack = null;
  function stop() {
    if (tour) { cancelAnimationFrame(tour.raf); tour = null; }
    if (voiceBack) { clearTimeout(voiceBack); voiceBack = null; }
    live(true);
  }
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (ev) {
    window.addEventListener(ev, stop, { passive: true, once: true });
  });

  if (!reduce) {
    var legs = [
      { wait: 900,  from: 2026, to: 2013, ms: 1500 },
      { wait: 650,  from: 2013, to: 2026, ms: 1800 }
    ];
    var leg = 0, t0 = null;
    tour = { raf: 0 };
    var step = function (t) {
      if (!tour) return;
      if (t0 === null) t0 = t;
      var l = legs[leg];
      var elapsed = t - t0;
      if (elapsed < l.wait) { tour.raf = requestAnimationFrame(step); return; }
      var p = Math.min((elapsed - l.wait) / l.ms, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var y = Math.round(l.from + (l.to - l.from) * eased);
      if (String(y) !== sl.value) { sl.value = String(y); render(y); }
      if (p < 1) { tour.raf = requestAnimationFrame(step); return; }
      leg++;
      t0 = null;
      if (leg < legs.length) { tour.raf = requestAnimationFrame(step); } else { stop(); }
    };
    live(false);
    /* requestAnimationFrame se congela en una pestaña de fondo: sin esta red el
       recorrido no llegaría a su fin y la región se quedaría muda para siempre.
       setTimeout sí corre (estrangulado) en segundo plano. */
    var total = 0;
    for (var g = 0; g < legs.length; g++) total += legs[g].wait + legs[g].ms;
    voiceBack = setTimeout(stop, total + 500);
    tour.raf = requestAnimationFrame(step);
  }
})();
</script>
</body>
</html>`;
}
