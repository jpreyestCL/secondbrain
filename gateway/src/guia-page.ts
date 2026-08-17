/**
 * Guía de uso (/guia). Solo produce el CONTENIDO; el `<head>`, el CSS y la
 * barra de navegación vienen del shell compartido (dashboard-layout.ts), el
 * mismo que envuelve /cuenta.
 *
 * La página es PÚBLICA: sin sesión la barra ofrece «Iniciar sesión» en vez del
 * correo y el botón de cerrar sesión, pero el contenido es el mismo (todo está
 * en el repo público y los comandos usan marcadores, no secretos).
 *
 * Documenta las dos formas de meter información al cerebro: hablando con Claude
 * por el conector MCP (el camino de todos los días) y la ingesta masiva de una
 * carpeta con el CLI `brain` (el camino para quien tiene terminal). Todo lo que
 * aparece aquí está verificado contra el servidor real.
 *
 * Bilingüe ES/EN: el texto de cara al usuario vive en `T` y se resuelve con
 * `traductor`. Lo que NO se traduce nunca: los nombres de las herramientas MCP,
 * los nombres de los flags, las variables de entorno y los comandos de shell.
 * Sí se traducen sus descripciones, los marcadores (`<carpeta>` → `<folder>`) y
 * los comentarios dentro de los bloques de shell.
 *
 * Ojo con el escape: los textos que van dentro de `<code>`/`<pre>` se pasan por
 * `escapeHtml` en la plantilla, así que en el diccionario van EN CRUDO
 * (`<carpeta>`, no `&lt;carpeta&gt;`). Los textos de prosa sí llevan marcado
 * (`<strong>`, `<em>`, enlaces) y se insertan tal cual.
 */
import { traductor, type Idioma, type Textos } from "./i18n.js";
import { escapeHtml } from "./html.js";
import { dashboardShell, type DashboardSessionView } from "./dashboard-layout.js";

type Clave =
  | "tituloPagina"
  | "eyebrow"
  | "lede"
  | "tocAria"
  | "toc1"
  | "toc2"
  | "toc3"
  | "toc4"
  | "toc5"
  // 01 · Conectar
  | "s1Titulo"
  | "s1Intro"
  | "s1Paso1"
  | "s1Paso2"
  | "s1Paso3"
  | "s1Paso4"
  | "s1Paso5"
  | "s1Paso6"
  | "s1Plugin"
  | "s1PluginComo"
  | "s1PluginBloque"
  | "s1PluginCarpetas"
  | "s1PluginCompleto"
  | "s1PluginLogin"
  | "s1PluginListo"
  | "s1Fallos"
  | "s1ThQue"
  | "s1ThHacer"
  | "s1InvalidClient"
  | "s1AccountNotLinked"
  | "s1BucleLogin"
  | "s1BucleLoginQue"
  | "s1403"
  | "s1Revocar"
  // 02 · Conversar
  | "s2Titulo"
  | "s2Intro"
  | "s2Guardar"
  | "s2GuardarComo"
  | "s2GuardarEjemplo"
  | "s2Relaciones"
  | "s2Fecha"
  | "s2Ingerir"
  | "s2IngerirComo"
  | "s2IngerirEjemplo"
  | "s2Consultar"
  | "s2ConsultarComo"
  | "s2ConsultaActual"
  | "s2ConsultaHistoria"
  | "s2Warn"
  // 03 · Herramientas
  | "s3Titulo"
  | "s3Intro"
  | "s3ThTool"
  | "s3ThQue"
  | "s3ThParams"
  | "toolAddMemory"
  | "toolSearchFacts"
  | "toolSearchNodes"
  | "toolGetEpisodes"
  | "toolGetEdge"
  | "toolDeleteEdge"
  | "toolDeleteEpisode"
  | "toolClearGraph"
  | "toolGetStatus"
  | "s3ReferenceTime"
  | "s3OnlyCurrent"
  | "s3ClearGraph"
  | "s3Aislamiento"
  // 04 · Ingesta masiva
  | "s4Titulo"
  | "s4Intro"
  | "s4Instalar"
  | "s4InstalarComo"
  | "s4Vincular"
  | "s4VincularComo"
  | "s4SinClaves"
  | "s4Pipeline"
  | "s4PipelineComo"
  | "s4AvisoTenant"
  | "s4AvisoSlug"
  | "s4Comandos"
  | "s4ThComando"
  | "s4ThQue"
  | "cmdAdd"
  | "cmdAddQue"
  | "cmdLogin"
  | "cmdLoginQue"
  | "cmdStatus"
  | "cmdStatusQue"
  | "cmdScan"
  | "cmdScanQue"
  | "cmdExtract"
  | "cmdExtractQue"
  | "cmdClassify"
  | "cmdClassifyQue"
  | "cmdApply"
  | "cmdApplyQue"
  | "cmdChunk"
  | "cmdChunkQue"
  | "cmdIngest"
  | "cmdIngestQue"
  | "cmdExpire"
  | "cmdExpireQue"
  | "s4FlagTenant"
  | "s4Ledger"
  | "s4Ocr"
  | "s4Redaccion"
  | "s4Originales"
  | "s4Remoto"
  | "s4RemotoComo"
  | "s4RemotoToken"
  | "s4SinTerminal"
  // 05 · Accesos
  | "s5Titulo"
  | "s5Intro"
  | "s5Boton"
  | "s5Cuenta";

const T: Textos<Clave> = {
  tituloPagina: { es: "Guía de uso", en: "User guide" },
  eyebrow: { es: "Manual del archivo", en: "Archive manual" },
  lede: {
    es: `Cómo guardar, consultar e ingerir información en tu second brain.
      Todo lo de esta página está verificado contra el servidor real.`,
    en: `How to save, query and ingest information in your second brain.
      Everything on this page is verified against the real server.`,
  },
  tocAria: { es: "Índice de la guía", en: "Guide contents" },
  toc1: { es: "Conectar tu Claude", en: "Connect your Claude" },
  toc2: { es: "Conversar con el cerebro", en: "Talk to your brain" },
  toc3: { es: "Las 9 herramientas MCP", en: "The 9 MCP tools" },
  toc4: { es: "Ingesta masiva de una carpeta", en: "Bulk ingestion of a folder" },
  toc5: { es: "Exportar y cerrar accesos", en: "Export and revoke access" },

  s1Titulo: { es: "Conectar tu Claude", en: "Connect your Claude" },
  s1Intro: {
    es: `Se hace una sola vez. Después tu memoria está disponible en cualquier
      conversación, en web, escritorio y teléfono.`,
    en: `You do this once. After that your memory is available in any
      conversation — web, desktop and mobile.`,
  },
  s1Paso1: {
    es: `Abre <strong>claude.ai</strong> (o Claude Desktop) y ve a
        <strong>Ajustes → Conectores</strong>.`,
    en: `Open <strong>claude.ai</strong> (or Claude Desktop) and go to
        <strong>Settings → Connectors</strong>.`,
  },
  s1Paso2: {
    es: `Elige <strong>Agregar conector personalizado</strong>.`,
    en: `Choose <strong>Add custom connector</strong>.`,
  },
  s1Paso3: { es: "Pega esta dirección:", en: "Paste this address:" },
  s1Paso4: {
    es: `Se abrirá una ventana para <strong>iniciar sesión</strong>: con tu correo y
        contraseña, o con <strong>Continuar con Google</strong>.`,
    en: `A window opens for you to <strong>sign in</strong>: with your email and
        password, or with <strong>Continue with Google</strong>.`,
  },
  s1Paso5: {
    es: `Verás una pantalla de <strong>autorización</strong> que indica qué permiso
        estás dando (leer y escribir toda tu memoria). Pulsa <strong>Autorizar</strong>.
        Solo se pregunta la primera vez para cada conector.`,
    en: `You will see an <strong>authorization</strong> screen stating what you are
        granting (read and write your whole memory). Press <strong>Authorize</strong>.
        You are only asked the first time for each connector.`,
  },
  s1Paso6: {
    es: `Listo. Compruébalo escribiéndole a Claude:
        <em>«¿qué tienes guardado sobre mí?»</em>`,
    en: `Done. Check it by asking Claude:
        <em>“what do you have stored about me?”</em>`,
  },
  s1Plugin: {
    es: "¿Usas Claude Code en la terminal?",
    en: "Using Claude Code in the terminal?",
  },
  s1PluginComo: {
    es: `Instala el plugin y te deja todo listo de una vez: el conector configurado
      y los comandos <code>/absorber</code>, <code>/guardar</code> y
      <code>/consultar</code> disponibles desde cualquier carpeta.`,
    en: `Install the plugin and it sets everything up at once: the connector configured
      and the <code>/absorber</code>, <code>/guardar</code> and <code>/consultar</code>
      commands available from any folder.`,
  },
  s1PluginBloque: {
    es: `/plugin marketplace add jpreyestCL/secondbrain
/plugin install secondbrain`,
    en: `/plugin marketplace add jpreyestCL/secondbrain
/plugin install secondbrain`,
  },
  s1PluginCarpetas: {
    es: `El plugin te deja hablar con tu memoria y guardar documentos sueltos. Para
      meter <strong>carpetas enteras</strong> hace falta además el comando
      <code>brain</code>, que es el que lee los archivos de tu disco (el servidor
      no puede: por eso nada se sube). Son dos líneas más, una sola vez:`,
    en: `The plugin lets you talk to your memory and store single documents. To ingest
      <strong>whole folders</strong> you also need the <code>brain</code> command, which
      is what reads the files on your disk (the server cannot: that is why nothing is
      uploaded). Two more lines, once:`,
  },
  s1PluginCompleto: {
    es: `curl -fsSL <BASE_URL>/install.sh | sh
brain login <BASE_URL>`,
    en: `curl -fsSL <BASE_URL>/install.sh | sh
brain login <BASE_URL>`,
  },
  s1PluginLogin: {
    es: `El <code>login</code> abre el navegador una vez y deja este equipo vinculado a
      tu cuenta. <strong>No pide ninguna clave de API</strong>: la extracción ocurre
      aquí o en el servidor, nunca con claves tuyas en el medio.`,
    en: `The <code>login</code> opens the browser once and links this machine to your
      account. <strong>It asks for no API key</strong>: extraction happens here or on the
      server, never with your own keys in between.`,
  },
  s1PluginListo: {
    es: `Ya está. Ahora puedes pedirle a Claude:
      <em>«absorbe los documentos de ~/mis-escrituras»</em> y él prepara los archivos y
      va guardando los hechos de cada documento. Los detalles del comando están en
      <a href="#masiva">Ingesta masiva</a>.`,
    en: `That is it. You can now ask Claude: <em>“absorb the documents in
      ~/my-deeds”</em> and it prepares the files and stores the facts from each
      document. The command details are in <a href="#masiva">Bulk ingestion</a>.`,
  },
  s1Fallos: { es: "Si algo falla", en: "If something goes wrong" },
  s1ThQue: { es: "Lo que ves", en: "What you see" },
  s1ThHacer: { es: "Qué significa y qué hacer", en: "What it means and what to do" },
  s1InvalidClient: {
    es: `El conector guarda un identificador que ya no existe en el servidor
            (por ejemplo, si se limpiaron los accesos). <strong>Elimina el conector
            en claude.ai y vuelve a agregarlo</strong>: se registra de nuevo solo.`,
    en: `The connector is holding a client id that no longer exists on the server
            (for example, after access was cleared). <strong>Delete the connector in
            claude.ai and add it again</strong>: it registers itself anew.`,
  },
  s1AccountNotLinked: {
    es: `Intentaste entrar con Google usando un correo que ya tenía cuenta con
            contraseña, y ese correo aún no está verificado. Revisa tu bandeja y
            confirma el correo; si no te llegó, reenvíalo desde
            <a href="/cuenta">tu cuenta</a>.`,
    en: `You tried to sign in with Google using an email that already had a
            password account, and that email is not verified yet. Check your inbox
            and confirm it; if it never arrived, resend it from
            <a href="/cuenta">your account</a>.`,
  },
  s1BucleLogin: {
    es: "Te devuelve al login una y otra vez",
    en: "It sends you back to the login over and over",
  },
  s1BucleLoginQue: {
    es: `La sesión caducó (duran 2 días). Vuelve a iniciar sesión; el conector
            sigue registrado.`,
    en: `The session expired (they last 2 days). Sign in again; the connector is
            still registered.`,
  },
  s1403: {
    es: `Tu cuenta existe pero no tiene memoria asignada. Escríbele al
            administrador: hay que aprovisionar tu espacio.`,
    en: `Your account exists but has no memory assigned. Write to the
            administrator: your space needs to be provisioned.`,
  },
  s1Revocar: {
    es: `Para revocar el acceso de un conector en cualquier momento, entra a
      <a href="/cuenta">tu cuenta</a> y pulsa <em>Revocar</em> junto a la aplicación.`,
    en: `To revoke a connector's access at any time, go to
      <a href="/cuenta">your account</a> and press <em>Revoke</em> next to the application.`,
  },

  s2Titulo: { es: "Conversar con el cerebro", en: "Talk to your brain" },
  s2Intro: {
    es: `Es el camino de todos los días y no necesita terminal: basta con
      tener el conector MCP agregado en Claude.`,
    en: `This is the everyday route and needs no terminal: all it takes is having
      the MCP connector added in Claude.`,
  },
  s2Guardar: { es: "Guardar un dato", en: "Save a fact" },
  s2GuardarComo: {
    es: `Díselo en lenguaje natural. Claude decide el ámbito y llama a la
      herramienta por ti.`,
    en: `Just say it in plain language. Claude works out the scope and calls the
      tool for you.`,
  },
  s2GuardarEjemplo: {
    es: "Guarda que mi cuenta del Banco X es Y",
    en: "Remember that my Banco X account is Y",
  },
  s2Relaciones: {
    es: `<strong>Menciona las relaciones explícitamente</strong>: “la cuenta <em>del Banco X</em>
        es <em>mía</em>”, “el contrato es <em>con</em> tal empresa”. El grafo extrae lo que
        dices, no lo que se sobreentiende.`,
    en: `<strong>State the relationships explicitly</strong>: “the account <em>at Banco X</em>
        is <em>mine</em>”, “the contract is <em>with</em> such-and-such company”. The graph
        extracts what you say, not what is implied.`,
  },
  s2Fecha: {
    es: `<strong>Menciona la fecha real del hecho</strong>, no la de hoy: “desde marzo de
        2024”. Esa fecha viaja en <code>reference_time</code> y es la que define desde
        cuándo el hecho está vigente.`,
    en: `<strong>State the real date of the fact</strong>, not today's: “since March
        2024”. That date travels in <code>reference_time</code> and is what defines when
        the fact starts being current.`,
  },
  s2Ingerir: { es: "Ingerir un documento", en: "Ingest a document" },
  s2IngerirComo: {
    es: `Adjunta el archivo en el chat y pide que lo ingiera. Claude lo lee
      —incluso PDFs escaneados o imágenes, usando visión—, lo trocea y lo guarda por
      secciones.`,
    en: `Attach the file in the chat and ask for it to be ingested. Claude reads it
      —even scanned PDFs or images, using vision—, splits it and stores it section by
      section.`,
  },
  s2IngerirEjemplo: {
    es: "Ingiere este contrato a mi second brain <em>(adjunto)</em>",
    en: "Add this contract to my second brain <em>(attached)</em>",
  },
  s2Consultar: { es: "Consultar", en: "Look up" },
  s2ConsultarComo: {
    es: `Por defecto te responde con el <strong>estado actual</strong>. Si quieres
      la <strong>historia</strong>, pídela: el hecho anterior no se borró, quedó cerrado con
      su periodo de vigencia.`,
    en: `By default it answers with the <strong>current state</strong>. If you want the
      <strong>history</strong>, ask for it: the previous fact was not deleted, it was closed
      off with its period of validity.`,
  },
  s2ConsultaActual: { es: "¿Cuál es mi cuenta bancaria?", en: "What is my bank account?" },
  s2ConsultaHistoria: {
    es: "Dame el historial completo de mis cuentas bancarias",
    en: "Give me the full history of my bank accounts",
  },
  s2Warn: {
    es: `Nunca pegues contraseñas ni tokens en el chat. El servidor los redacta
      igual antes de escribir nada, pero lo mejor es que no salgan de tu gestor de claves.`,
    en: `Never paste passwords or tokens in the chat. The server redacts them before
      writing anything anyway, but they are better off never leaving your password manager.`,
  },

  s3Titulo: { es: "Las 9 herramientas MCP", en: "The 9 MCP tools" },
  s3Intro: {
    es: `No necesitas llamarlas a mano: Claude las usa por ti. Están aquí para
      que sepas exactamente qué puede hacer el conector con tu memoria.`,
    en: `You do not need to call them by hand: Claude uses them for you. They are
      here so you know exactly what the connector can do with your memory.`,
  },
  s3ThTool: { es: "Herramienta", en: "Tool" },
  s3ThQue: { es: "Qué hace", en: "What it does" },
  s3ThParams: { es: "Parámetros", en: "Parameters" },
  toolAddMemory: {
    es: "Guarda un dato o un trozo de documento en tu memoria.",
    en: "Saves a fact or a chunk of a document into your memory.",
  },
  toolSearchFacts: {
    es: "Busca datos: qué se relaciona con qué, y desde cuándo.",
    en: "Searches facts: what relates to what, and since when.",
  },
  toolSearchNodes: {
    es: "Busca personas, empresas, cuentas, lugares y documentos.",
    en: "Searches people, companies, accounts, places and documents.",
  },
  toolGetEpisodes: {
    es: "Lista lo último guardado, con su texto original.",
    en: "Lists what was saved most recently, with its original text.",
  },
  toolGetEdge: {
    es: "Devuelve un dato concreto por su identificador, con su vigencia.",
    en: "Returns one specific fact by its identifier, with its period of validity.",
  },
  toolDeleteEdge: {
    es: "Borra un dato concreto (por ejemplo, uno mal entendido).",
    en: "Deletes one specific fact (for example, one that was misread).",
  },
  toolDeleteEpisode: {
    es: "Borra un documento guardado y todo lo que se dedujo de él.",
    en: "Deletes a stored document and everything inferred from it.",
  },
  toolClearGraph: {
    es: "Borra TODA tu memoria. No hay deshacer.",
    en: "Deletes ALL your memory. There is no undo.",
  },
  toolGetStatus: {
    es: "Comprueba que el servidor y la base de datos responden.",
    en: "Checks that the server and the database are responding.",
  },
  s3ReferenceTime: {
    es: `<code>reference_time</code> es ISO-8601 y es la <strong>fecha real del hecho</strong>.
        El servidor valida que caiga entre 1900 y como máximo un año en el futuro.`,
    en: `<code>reference_time</code> is ISO-8601 and is the <strong>real date of the
        fact</strong>. The server checks it falls between 1900 and at most one year into
        the future.`,
  },
  s3OnlyCurrent: {
    es: `<code>only_current</code> viene en <code>true</code> por defecto: devuelve solo los
        datos vigentes. Ponlo en <code>false</code> para incluir los que ya cambiaron y ver la
        historia completa.`,
    en: `<code>only_current</code> defaults to <code>true</code>: it returns only current
        facts. Set it to <code>false</code> to include the ones that already changed and see
        the full history.`,
  },
  s3ClearGraph: {
    es: `<code>clear_graph</code> es destructivo y no tiene deshacer. Exporta antes desde
        <a href="/export">/export</a> si tienes cualquier duda.`,
    en: `<code>clear_graph</code> is destructive and has no undo. Export first from
        <a href="/export">/export</a> if you have any doubt at all.`,
  },
  s3Aislamiento: {
    es: `<strong>Aislamiento:</strong> el servidor fuerza el <code>group_id</code>
      de tu usuario en cada llamada y comprueba la pertenencia de cada UUID antes de
      tocarlo. No es posible leer ni modificar el grafo de otra persona, ni siquiera
      pasando un <code>group_id</code> ajeno a mano.`,
    en: `<strong>Isolation:</strong> the server forces your user's <code>group_id</code>
      on every call and checks the ownership of every UUID before touching it. Reading or
      modifying someone else's graph is not possible, not even by passing someone else's
      <code>group_id</code> by hand.`,
  },

  s4Titulo: {
    es: "Ingesta masiva de una carpeta (CLI <code>brain</code>)",
    en: "Bulk ingestion of a folder (the <code>brain</code> CLI)",
  },
  s4Intro: {
    es: `Para cuando tienes cientos de documentos en el disco y adjuntarlos de
      a uno en el chat no tiene sentido. Requiere terminal.`,
    en: `For when you have hundreds of documents on disk and attaching them one by
      one in the chat makes no sense. Requires a terminal.`,
  },
  s4Instalar: { es: "Instalar", en: "Install" },
  s4InstalarComo: {
    es: `Un comando. Instala lo que falte y deja <code>brain</code> disponible
      desde cualquier carpeta.`,
    en: `One command. It installs whatever is missing and leaves <code>brain</code>
      available from any folder.`,
  },
  s4Vincular: { es: "Vincular con tu cuenta", en: "Link it to your account" },
  s4VincularComo: {
    es: "Se abre el navegador una vez para autenticarte.",
    en: "The browser opens once so you can authenticate.",
  },
  s4SinClaves: {
    es: `<strong>No necesitas ninguna clave de API.</strong> La extracción de
      entidades la hace el servidor con sus modelos; en tu equipo solo corren la lectura de
      archivos, el OCR y el troceado, que no usan modelos de lenguaje.`,
    en: `<strong>You need no API key.</strong> Entity extraction happens on the server
      with its models; on your machine only file reading, OCR and chunking run, and none of
      those uses a language model.`,
  },
  s4Pipeline: { es: "El pipeline", en: "The pipeline" },
  s4PipelineComo: {
    es: `Los pasos van en orden y cada uno deja su resultado en el ledger, así
      que puedes cortar y retomar donde ibas.`,
    en: `The steps run in order and each one records its result in the ledger, so you
      can stop and pick up where you left off.`,
  },
  s4AvisoTenant: {
    es: `Los ejemplos ya vienen con tu espacio
        (<code>{tenant}</code>): puedes copiarlos y pegarlos tal cual.`,
    en: `The examples already carry your space
        (<code>{tenant}</code>): you can copy and paste them as they are.`,
  },
  s4AvisoSlug: {
    es: `Sustituye <code>&lt;slug&gt;</code> por el nombre de tu espacio.
        <a href="/cuenta">Inicia sesión</a> y los ejemplos saldrán ya rellenados.`,
    en: `Replace <code>&lt;slug&gt;</code> with the name of your space.
        <a href="/cuenta">Sign in</a> and the examples come out already filled in.`,
  },
  s4Comandos: { es: "Comandos", en: "Commands" },
  s4ThComando: { es: "Comando", en: "Command" },
  s4ThQue: { es: "Qué hace", en: "What it does" },
  cmdAdd: { es: "add <carpeta>", en: "add <folder>" },
  cmdAddQue: {
    es: "Todo el proceso en un comando. Con --review se detiene antes de enviar.",
    en: "The whole process in one command. With --review it stops before sending.",
  },
  cmdLogin: { es: "login <url>", en: "login <url>" },
  cmdLoginQue: {
    es: "Vincula este equipo con tu cuenta del servidor. Se hace una vez.",
    en: "Links this machine to your server account. Done once.",
  },
  cmdStatus: { es: "status", en: "status" },
  cmdStatusQue: {
    es: "Muestra en qué etapa va cada documento.",
    en: "Shows which stage each document is in.",
  },
  cmdScan: { es: "scan <carpeta>", en: "scan <folder>" },
  cmdScanQue: {
    es: "Solo registra los archivos en el ledger.",
    en: "Only registers the files in the ledger.",
  },
  cmdExtract: { es: "extract", en: "extract" },
  cmdExtractQue: {
    es: "Solo saca el texto (OCR incluido si hace falta).",
    en: "Only pulls out the text (OCR included where needed).",
  },
  cmdClassify: { es: "classify --auto", en: "classify --auto" },
  cmdClassifyQue: {
    es: "Solo asigna dominio, tipo y fecha real. Sin LLM.",
    en: "Only assigns domain, type and the real date. No LLM.",
  },
  cmdApply: { es: "classify --apply <archivo>", en: "classify --apply <file>" },
  cmdApplyQue: {
    es: "Aplica un manifiesto que revisaste a mano.",
    en: "Applies a manifest you reviewed by hand.",
  },
  cmdChunk: { es: "chunk", en: "chunk" },
  cmdChunkQue: {
    es: "Solo trocea en secciones del tamaño que el grafo digiere.",
    en: "Only splits into sections of the size the graph digests.",
  },
  cmdIngest: { es: "ingest-graph", en: "ingest-graph" },
  cmdIngestQue: {
    es: "Solo envía al grafo (flags --doc-id y --force).",
    en: "Only sends to the graph (flags --doc-id and --force).",
  },
  cmdExpire: { es: "expire", en: "expire" },
  cmdExpireQue: {
    es: "Marca documentos como caducados (--all para todos).",
    en: "Marks documents as expired (--all for all of them).",
  },
  s4FlagTenant: {
    es: `Flag global: <code>--tenant &lt;slug&gt;</code> elige sobre qué espacio
      trabajar.`,
    en: `Global flag: <code>--tenant &lt;slug&gt;</code> chooses which space to work on.`,
  },
  s4Ledger: {
    es: `<strong>Ledger reanudable</strong> en <code>~/.brain/&lt;tenant&gt;/</code>: si algo
        falla, vuelves a lanzar el comando y sigue desde donde quedó.`,
    en: `<strong>Resumable ledger</strong> in <code>~/.brain/&lt;tenant&gt;/</code>: if
        something fails, you run the command again and it carries on from where it stopped.`,
  },
  s4Ocr: {
    es: `<strong>OCR</strong> de imágenes y de PDFs escaneados en el paso <code>extract</code>.`,
    en: `<strong>OCR</strong> for images and scanned PDFs in the <code>extract</code> step.`,
  },
  s4Redaccion: {
    es: `<strong>Redacción de credenciales</strong>: claves, tokens y números de tarjeta se
        reemplazan antes de escribir nada en el grafo.`,
    en: `<strong>Credential redaction</strong>: passwords, tokens and card numbers are
        replaced before anything is written to the graph.`,
  },
  s4Originales: {
    es: `<strong>Tus originales no se tocan</strong>: el pipeline solo lee de la carpeta.`,
    en: `<strong>Your originals are untouched</strong>: the pipeline only reads from the folder.`,
  },
  s4Remoto: {
    es: "Ingerir contra este servidor (sin SSH)",
    en: "Ingesting against this server (no SSH)",
  },
  s4RemotoComo: {
    es: `Es la forma recomendada y la única disponible si no administras el
      servidor. El último paso viaja por el mismo conector MCP que usa Claude: te
      autenticas con tu cuenta y el servidor hace la extracción con sus propios modelos.`,
    en: `This is the recommended way, and the only one available if you do not
      administer the server. The last step travels over the same MCP connector Claude uses:
      you authenticate with your account and the server does the extraction with its own
      models.`,
  },
  s4RemotoToken: {
    es: `La primera vez se abre el navegador para autorizar; el token queda
      guardado en <code>~/.brain/&lt;tenant&gt;/</code>. Los pasos anteriores son locales.`,
    en: `The first time, the browser opens so you can authorize; the token is stored in
      <code>~/.brain/&lt;tenant&gt;/</code>. The earlier steps are local.`,
  },
  s4SinTerminal: {
    es: `<strong>Sin terminal:</strong> adjunta los documentos en Claude y
      pídele que los guarde. No requiere instalar nada.`,
    en: `<strong>No terminal:</strong> attach the documents in Claude and ask it to
      save them. Nothing to install.`,
  },

  s5Titulo: { es: "Exportar y cerrar accesos", en: "Export and revoke access" },
  s5Intro: {
    es: `Tu memoria es tuya y sale entera cuando quieras: un JSON con los
      episodios (texto original), las entidades y los hechos con su vigencia.`,
    en: `Your memory is yours and comes out whole whenever you want: a JSON with the
      episodes (original text), the entities and the facts with their period of validity.`,
  },
  s5Boton: { es: "Descargar mi memoria (JSON)", en: "Download my memory (JSON)" },
  s5Cuenta: {
    es: `En <a href="/cuenta">tu cuenta</a> puedes revisar las sesiones abiertas,
      cerrarlas todas de golpe y revocar cualquier aplicación OAuth que hayas autorizado.`,
    en: `In <a href="/cuenta">your account</a> you can review the open sessions, close
      them all at once and revoke any OAuth application you have authorized.`,
  },
};

interface Tool {
  name: string;
  /** Clave de la descripción; los nombres y parámetros no se traducen. */
  what: Clave;
  params: string;
}

/** Las 9 herramientas que expone el servidor MCP. */
const TOOLS: Tool[] = [
  {
    name: "add_memory",
    what: "toolAddMemory",
    params:
      "name, episode_body, source, source_description, group_id, uuid, reference_time",
  },
  {
    name: "search_memory_facts",
    what: "toolSearchFacts",
    params: "query, group_ids, max_facts, center_node_uuid, only_current",
  },
  { name: "search_nodes", what: "toolSearchNodes", params: "query, max_nodes, entity_types" },
  { name: "get_episodes", what: "toolGetEpisodes", params: "max_episodes, group_ids" },
  { name: "get_entity_edge", what: "toolGetEdge", params: "uuid" },
  { name: "delete_entity_edge", what: "toolDeleteEdge", params: "uuid" },
  { name: "delete_episode", what: "toolDeleteEpisode", params: "uuid" },
  { name: "clear_graph", what: "toolClearGraph", params: "group_ids" },
  { name: "get_status", what: "toolGetStatus", params: "—" },
];

/** Comandos del CLI: el comando lleva marcadores traducibles, la glosa también. */
const CLI_COMMANDS: Array<[Clave, Clave]> = [
  ["cmdAdd", "cmdAddQue"],
  ["cmdLogin", "cmdLoginQue"],
  ["cmdStatus", "cmdStatusQue"],
  ["cmdScan", "cmdScanQue"],
  ["cmdExtract", "cmdExtractQue"],
  ["cmdClassify", "cmdClassifyQue"],
  ["cmdApply", "cmdApplyQue"],
  ["cmdChunk", "cmdChunkQue"],
  ["cmdIngest", "cmdIngestQue"],
  ["cmdExpire", "cmdExpireQue"],
];

const INSTALL_BLOCK = `curl -fsSL <BASE_URL>/install.sh | sh`;

const CONFIG_BLOCK = `brain login <BASE_URL>`;

const REMOTO_BLOCK = `brain --tenant <slug> ingest-graph --via mcp --url <MCP_URL>`;

const PIPELINE_BLOCK = `brain add ~/Documentos/inbox`;

const PIPELINE_BLOCK_EN = `brain add ~/Documents/inbox`;

/**
 * Rellena los ejemplos con los datos de quien mira la pagina.
 *
 * Un ejemplo con `<slug>` obliga a cada usuario a averiguar cual es el suyo.
 * Con sesion iniciada se sustituye por el tenant real, listo para copiar.
 */
function personalizar(bloque: string, tenant: string | null, mcpUrl: string): string {
  return bloque.replaceAll("<MCP_URL>", mcpUrl).replaceAll("<slug>", tenant ?? "<slug>");
}

export interface GuiaPageOptions {
  /** URL pública del gateway; se usa para mostrar la dirección del conector. */
  baseUrl?: string;
  /** Sesión del navegador, o null si se está viendo sin iniciar sesión. */
  session?: DashboardSessionView | null;
  /** Idioma actual y URL, para el selector de la barra. */
  idioma?: Idioma;
  url?: string;
  /** Slug del tenant de quien mira; con él los ejemplos salen listos para usar. */
  tenant?: string | null;
}

export function guiaPageHtml(opts: GuiaPageOptions = {}): string {
  const idioma = opts.idioma ?? "es";
  const t = traductor(T, idioma);
  const mcpUrl = (opts.baseUrl ?? "https://mybrain.rlz.cl").replace(/\/$/, "") + "/mcp";
  const toolRows = TOOLS.map(
    (tool) => `      <tr>
        <td><code>${escapeHtml(tool.name)}</code></td>
        <td>${escapeHtml(t(tool.what))}</td>
        <td class="params"><code>${escapeHtml(tool.params)}</code></td>
      </tr>`,
  ).join("\n");

  const tenant = opts.tenant ?? null;
  const pipeline = personalizar(
    idioma === "en" ? PIPELINE_BLOCK_EN : PIPELINE_BLOCK,
    tenant,
    mcpUrl,
  );
  const remoto = personalizar(REMOTO_BLOCK, tenant, mcpUrl);
  const baseUrl = mcpUrl.replace(/\/mcp$/, "");
  const instalar = INSTALL_BLOCK.replaceAll("<BASE_URL>", baseUrl);
  const vincular = CONFIG_BLOCK.replaceAll("<BASE_URL>", baseUrl);
  const avisoTenant = tenant
    ? `<p class="notice">${t("s4AvisoTenant").replace("{tenant}", escapeHtml(tenant))}</p>`
    : `<p class="muted">${t("s4AvisoSlug")}</p>`;

  const cliRows = CLI_COMMANDS.map(
    ([cmd, what]) => `      <tr>
        <td><code>${escapeHtml(t(cmd))}</code></td>
        <td>${escapeHtml(t(what))}</td>
      </tr>`,
  ).join("\n");

  const body = `  <section class="head">
    <p class="eyebrow">${t("eyebrow")}</p>
    <h1>${t("tituloPagina")}</h1>
    <p class="lede">${t("lede")}</p>
  </section>

  <nav class="toc" aria-label="${t("tocAria")}">
    <a href="#conectar">01 · ${t("toc1")}</a>
    <a href="#conversar">02 · ${t("toc2")}</a>
    <a href="#herramientas">03 · ${t("toc3")}</a>
    <a href="#masiva">04 · ${t("toc4")}</a>
    <a href="#accesos">05 · ${t("toc5")}</a>
  </nav>

  <section id="conectar">
    <p class="secnum">01</p>
    <h2>${t("s1Titulo")}</h2>
    <p>${t("s1Intro")}</p>
    <ol>
      <li>${t("s1Paso1")}</li>
      <li>${t("s1Paso2")}</li>
      <li>${t("s1Paso3")}
        <div class="block"><pre><code>${escapeHtml(mcpUrl)}</code></pre></div></li>
      <li>${t("s1Paso4")}</li>
      <li>${t("s1Paso5")}</li>
      <li>${t("s1Paso6")}</li>
    </ol>

    <h3>${t("s1Plugin")}</h3>
    <p class="muted">${t("s1PluginComo")}</p>
    <div class="block"><pre><code>${escapeHtml(t("s1PluginBloque"))}</code></pre></div>
    <p class="muted">${t("s1PluginCarpetas")}</p>
    <div class="block"><pre><code>${escapeHtml(
      t("s1PluginCompleto").replaceAll("<BASE_URL>", baseUrl),
    )}</code></pre></div>
    <p class="muted">${t("s1PluginLogin")}</p>
    <p class="notice">${t("s1PluginListo")}</p>

    <h3>${t("s1Fallos")}</h3>
    <div class="scroll"><table>
      <thead><tr><th>${t("s1ThQue")}</th><th>${t("s1ThHacer")}</th></tr></thead>
      <tbody>
        <tr>
          <td><code>invalid_client</code></td>
          <td>${t("s1InvalidClient")}</td>
        </tr>
        <tr>
          <td><code>account_not_linked</code></td>
          <td>${t("s1AccountNotLinked")}</td>
        </tr>
        <tr>
          <td>${t("s1BucleLogin")}</td>
          <td>${t("s1BucleLoginQue")}</td>
        </tr>
        <tr>
          <td><code>403</code> ${idioma === "en" ? "when using a tool" : "al usar una herramienta"}</td>
          <td>${t("s1403")}</td>
        </tr>
      </tbody>
    </table></div>

    <p class="muted">${t("s1Revocar")}</p>
  </section>

  <section id="conversar">
    <p class="secnum">02</p>
    <h2>${t("s2Titulo")}</h2>
    <p class="muted">${t("s2Intro")}</p>

    <h3>${t("s2Guardar")}</h3>
    <p class="muted">${t("s2GuardarComo")}</p>
    <div class="quote">${t("s2GuardarEjemplo")}</div>
    <ul>
      <li>${t("s2Relaciones")}</li>
      <li>${t("s2Fecha")}</li>
    </ul>

    <h3>${t("s2Ingerir")}</h3>
    <p class="muted">${t("s2IngerirComo")}</p>
    <div class="quote">${t("s2IngerirEjemplo")}</div>

    <h3>${t("s2Consultar")}</h3>
    <p class="muted">${t("s2ConsultarComo")}</p>
    <div class="quote">${t("s2ConsultaActual")}</div>
    <div class="quote">${t("s2ConsultaHistoria")}</div>

    <p class="warn">${t("s2Warn")}</p>
  </section>

  <section id="herramientas">
    <p class="secnum">03</p>
    <h2>${t("s3Titulo")}</h2>
    <p class="muted">${t("s3Intro")}</p>
    <div class="scroll"><table>
      <thead><tr><th>${t("s3ThTool")}</th><th>${t("s3ThQue")}</th><th>${t("s3ThParams")}</th></tr></thead>
      <tbody>
${toolRows}
      </tbody>
    </table></div>

    <ul>
      <li>${t("s3ReferenceTime")}</li>
      <li>${t("s3OnlyCurrent")}</li>
      <li>${t("s3ClearGraph")}</li>
    </ul>

    <p class="notice">${t("s3Aislamiento")}</p>
  </section>

  <section id="masiva">
    <p class="secnum">04</p>
    <h2>${t("s4Titulo")}</h2>
    <p class="muted">${t("s4Intro")}</p>

    <h3>${t("s4Instalar")}</h3>
    <p class="muted">${t("s4InstalarComo")}</p>
    <div class="block"><pre><code>${escapeHtml(instalar)}</code></pre></div>

    <h3>${t("s4Vincular")}</h3>
    <p class="muted">${t("s4VincularComo")}</p>
    <div class="block"><pre><code>${escapeHtml(vincular)}</code></pre></div>
    <p class="notice">${t("s4SinClaves")}</p>

    <h3>${t("s4Pipeline")}</h3>
    ${avisoTenant}
    <p class="muted">${t("s4PipelineComo")}</p>
    <div class="block"><pre><code>${escapeHtml(pipeline)}</code></pre></div>

    <h3>${t("s4Comandos")}</h3>
    <div class="scroll"><table>
      <thead><tr><th>${t("s4ThComando")}</th><th>${t("s4ThQue")}</th></tr></thead>
      <tbody>
${cliRows}
      </tbody>
    </table></div>
    <p class="muted">${t("s4FlagTenant")}</p>

    <ul>
      <li>${t("s4Ledger")}</li>
      <li>${t("s4Ocr")}</li>
      <li>${t("s4Redaccion")}</li>
      <li>${t("s4Originales")}</li>
    </ul>

    <h3>${t("s4Remoto")}</h3>
    <p class="muted">${t("s4RemotoComo")}</p>
    <div class="block"><pre><code>${escapeHtml(remoto)}</code></pre></div>
    <p class="muted">${t("s4RemotoToken")}</p>

    <p class="notice">${t("s4SinTerminal")}</p>
  </section>

  <section id="accesos">
    <p class="secnum">05</p>
    <h2>${t("s5Titulo")}</h2>
    <p class="muted">${t("s5Intro")}</p>
    <p><a class="btn" href="/export">${t("s5Boton")}</a></p>
    <p class="muted">${t("s5Cuenta")}</p>
  </section>`;

  return dashboardShell({
    title: t("tituloPagina"),
    active: "guia",
    session: opts.session ?? null,
    idioma: opts.idioma,
    url: opts.url,
    body,
  });
}
