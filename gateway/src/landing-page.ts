/**
 * Landing pública de mybrain.rlz.cl (servida en `/`).
 *
 * Concepto: el diferencial del producto es la memoria bi-temporal (los hechos
 * tienen vigencia y se supersedan, no se borran). El héroe lo demuestra con un
 * deslizador de tiempo sobre datos reales de ejemplo.
 */

import { escapeHtml } from "./html.js";

export function landingPageHtml(baseUrl: string): string {
  // baseUrl viene de la configuración, pero se escapa igual: ningún valor
  // interpolado entra crudo en el HTML (defensa en profundidad).
  const mcpUrl = escapeHtml(baseUrl.replace(/\/$/, "") + "/mcp");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>secondbrain — tu memoria, con línea de tiempo</title>
<meta name="description" content="Un segundo cerebro conversacional: guarda tu información desde Claude, ingiere documentos por chat y consúltala en lenguaje natural. Los hechos nunca se borran: se supersedan con fecha." />
<style>
  :root {
    --ink: #10151f;
    --paper: #edf0f3;
    --surface: #ffffff;
    --surface-2: #e4e9ee;
    --line: #cfd8de;
    --text: #182130;
    --muted: #5a6b72;
    --vigente: #1f7a6b;
    --vigente-soft: #d8ebe6;
    /* Texto sobre el acento y acento legible sobre fondos suaves (WCAG AA). */
    --on-accent: #ffffff;
    --accent-text: #155a4e;
    --historico: #a8836b;
    --historico-soft: #ece2da;
    --shadow: 0 1px 2px rgba(16,21,31,.06), 0 12px 32px -18px rgba(16,21,31,.35);
    --display: Georgia, "Iowan Old Style", "Times New Roman", serif;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --maxw: 68rem;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #0c1119; --surface: #141b26; --surface-2: #1b2532; --line: #2a3644;
      --text: #e6ecf2; --muted: #93a3ae;
      --vigente: #4fbfa6; --vigente-soft: #12312c;
      --on-accent: #08201c; --accent-text: #4fbfa6; --historico: #c2a189; --historico-soft: #2a2119;
      --shadow: 0 1px 2px rgba(0,0,0,.5), 0 18px 40px -22px rgba(0,0,0,.8);
    }
  }
  :root[data-theme="dark"] {
    --paper: #0c1119; --surface: #141b26; --surface-2: #1b2532; --line: #2a3644;
    --text: #e6ecf2; --muted: #93a3ae;
    --vigente: #4fbfa6; --vigente-soft: #12312c;
      --on-accent: #08201c; --accent-text: #4fbfa6; --historico: #c2a189; --historico-soft: #2a2119;
    --shadow: 0 1px 2px rgba(0,0,0,.5), 0 18px 40px -22px rgba(0,0,0,.8);
  }
  :root[data-theme="light"] {
    --paper: #edf0f3; --surface: #ffffff; --surface-2: #e4e9ee; --line: #cfd8de;
    --text: #182130; --muted: #5a6b72;
    --vigente: #1f7a6b; --vigente-soft: #d8ebe6;
    --on-accent: #ffffff; --accent-text: #155a4e; --historico: #a8836b; --historico-soft: #ece2da;
    --shadow: 0 1px 2px rgba(16,21,31,.06), 0 12px 32px -18px rgba(16,21,31,.35);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--paper); color: var(--text);
    font-family: var(--sans); font-size: 17px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: var(--maxw); margin-inline: auto; padding-inline: 1.5rem; }
  a { color: inherit; }
  h1, h2, h3 { font-family: var(--display); font-weight: 400; text-wrap: balance; margin: 0; }
  h1 { font-size: clamp(2.4rem, 6vw, 4rem); line-height: 1.04; letter-spacing: -.02em; }
  h2 { font-size: clamp(1.6rem, 3.4vw, 2.3rem); line-height: 1.15; letter-spacing: -.015em; }
  h3 { font-size: 1.12rem; line-height: 1.3; }
  p { margin: 0; }
  .eyebrow {
    font-family: var(--mono); font-size: .74rem; letter-spacing: .16em;
    text-transform: uppercase; color: var(--muted);
  }
  .lede { font-size: 1.14rem; color: var(--muted); max-width: 44ch; }

  /* ---------- nav ---------- */
  nav { border-bottom: 1px solid var(--line); background: var(--paper); }
  nav .wrap { display: flex; align-items: center; justify-content: space-between; gap: 1rem; height: 62px; }
  .brand { display: flex; align-items: baseline; gap: .55rem; font-family: var(--display); font-size: 1.15rem; }
  .brand span { font-family: var(--mono); font-size: .68rem; letter-spacing: .14em; color: var(--vigente); text-transform: uppercase; }
  .navlinks { display: flex; gap: 1.4rem; font-size: .92rem; color: var(--muted); }
  .navlinks a { text-decoration: none; }
  .navlinks a:hover { color: var(--text); }
  @media (max-width: 640px) { .navlinks { display: none; } }

  /* ---------- hero ---------- */
  header { padding: clamp(3rem, 8vw, 5.5rem) 0 clamp(2rem, 5vw, 3.5rem); }
  .hero { display: grid; grid-template-columns: 1fr; gap: 2.5rem; }
  @media (min-width: 900px) { .hero { grid-template-columns: 1.02fr 1fr; gap: 3.5rem; align-items: start; } }
  .hero-copy { display: flex; flex-direction: column; gap: 1.4rem; }
  h1 em { font-style: italic; color: var(--vigente); }
  .cta-row { display: flex; flex-wrap: wrap; gap: .7rem; align-items: center; }
  .btn {
    display: inline-flex; align-items: center; gap: .5rem; text-decoration: none;
    padding: .68rem 1.15rem; border-radius: 3px; font-size: .95rem;
    border: 1px solid var(--vigente); background: var(--vigente); color: var(--on-accent);
    transition: transform .12s ease, opacity .12s ease;
  }
  .btn:hover { opacity: .9; transform: translateY(-1px); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--line); }
  .btn.ghost:hover { border-color: var(--muted); }
  .btn:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--vigente); outline-offset: 3px; }

  /* ---------- demo temporal ---------- */
  .demo {
    background: var(--surface); border: 1px solid var(--line); border-radius: 4px;
    box-shadow: var(--shadow); overflow: hidden;
  }
  .demo-head {
    padding: .85rem 1.1rem; border-bottom: 1px solid var(--line);
    background: var(--surface-2); display: flex; justify-content: space-between;
    align-items: center; gap: 1rem; flex-wrap: wrap;
  }
  .demo-q { font-family: var(--mono); font-size: .82rem; color: var(--muted); }
  .demo-body { padding: 1.4rem 1.1rem 1.1rem; }
  .year {
    font-family: var(--display); font-size: 2.6rem; line-height: 1;
    font-variant-numeric: tabular-nums; letter-spacing: -.02em;
  }
  .answer {
    margin-top: 1rem; padding: 1rem; border-radius: 3px;
    background: var(--vigente-soft); border-left: 3px solid var(--vigente);
  }
  .answer .label {
    font-family: var(--mono); font-size: .68rem; letter-spacing: .14em;
    text-transform: uppercase; color: var(--accent-text); display: block; margin-bottom: .35rem;
  }
  .answer .value { font-size: 1.06rem; }
  .answer .range { font-family: var(--mono); font-size: .76rem; color: var(--muted); margin-top: .45rem; }
  .slider-wrap { margin-top: 1.3rem; }
  input[type=range] { width: 100%; accent-color: var(--vigente); }
  .ticks {
    display: flex; justify-content: space-between; font-family: var(--mono);
    font-size: .7rem; color: var(--muted); margin-top: .3rem; font-variant-numeric: tabular-nums;
  }
  .history { margin-top: 1.3rem; border-top: 1px solid var(--line); padding-top: 1rem; }
  .history .eyebrow { display: block; margin-bottom: .7rem; }
  .rec {
    display: flex; gap: .75rem; align-items: baseline; padding: .5rem .65rem;
    border-radius: 3px; font-size: .92rem; margin-bottom: .35rem;
  }
  .rec .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; transform: translateY(-2px); }
  .rec .when { font-family: var(--mono); font-size: .75rem; color: var(--muted); margin-left: auto; white-space: nowrap; }
  .rec.on { background: var(--vigente-soft); }
  .rec.on .dot { background: var(--vigente); }
  .rec.off { background: var(--historico-soft); color: var(--muted); }
  .rec.off .dot { background: var(--historico); }
  .rec.off .txt { text-decoration: line-through; text-decoration-thickness: 1px; }

  /* ---------- secciones ---------- */
  section { padding: clamp(3rem, 7vw, 5rem) 0; border-top: 1px solid var(--line); }
  .sec-head { display: flex; flex-direction: column; gap: .7rem; margin-bottom: 2.5rem; max-width: 52ch; }
  .grid { display: grid; gap: 1.1rem; }
  @media (min-width: 760px) { .grid.c2 { grid-template-columns: 1fr 1fr; } .grid.c4 { grid-template-columns: repeat(4, 1fr); } }
  .card {
    background: var(--surface); border: 1px solid var(--line); border-radius: 4px;
    padding: 1.3rem; display: flex; flex-direction: column; gap: .55rem;
  }
  .card .num {
    font-family: var(--mono); font-size: .72rem; letter-spacing: .1em; color: var(--vigente);
  }
  .card p { color: var(--muted); font-size: .96rem; }
  .quote {
    font-family: var(--mono); font-size: .88rem; background: var(--surface-2);
    border: 1px solid var(--line); border-radius: 3px; padding: .8rem .95rem;
    color: var(--text);
  }
  .quote::before { content: "› "; color: var(--vigente); }
  .asklist { display: grid; gap: .6rem; }

  /* ---------- esquema ---------- */
  .schema {
    background: var(--surface); border: 1px solid var(--line); border-radius: 4px;
    padding: 1.2rem; overflow-x: auto;
  }
  .schema pre {
    margin: 0; font-family: var(--mono); font-size: .8rem; line-height: 1.65;
    color: var(--muted); white-space: pre;
  }
  .schema b { color: var(--vigente); font-weight: 400; }

  /* ---------- conectar ---------- */
  .steps { counter-reset: s; display: grid; gap: 1rem; }
  .step { display: grid; grid-template-columns: auto 1fr; gap: .9rem; align-items: start; }
  .step::before {
    counter-increment: s; content: counter(s);
    font-family: var(--mono); font-size: .78rem; width: 1.7rem; height: 1.7rem;
    display: grid; place-items: center; border: 1px solid var(--vigente);
    color: var(--vigente); border-radius: 50%; flex: none;
  }
  .url {
    font-family: var(--mono); font-size: .95rem; background: var(--surface-2);
    border: 1px dashed var(--vigente); border-radius: 3px; padding: .55rem .8rem;
    display: inline-block; margin-top: .4rem; word-break: break-all;
  }
  footer { border-top: 1px solid var(--line); padding: 2.5rem 0 3.5rem; color: var(--muted); font-size: .9rem; }
  footer a { color: var(--vigente); }
  .foot-row { display: flex; flex-wrap: wrap; gap: 1.2rem; justify-content: space-between; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
</style>
</head>
<body>

<nav><div class="wrap">
  <div class="brand">secondbrain <span>mybrain.rlz.cl</span></div>
  <div class="navlinks">
    <a href="#como">Cómo funciona</a>
    <a href="#usar">Qué le preguntas</a>
    <a href="#conectar">Conectar</a>
    <a href="/guia">Guía</a>
    <a href="/cuenta">Tu cuenta</a>
    <a href="https://github.com/jpreyestCL/secondbrain">GitHub</a>
  </div>
</div></nav>

<header><div class="wrap hero">
  <div class="hero-copy">
    <p class="eyebrow">Memoria personal · conector MCP para Claude</p>
    <h1>Tu memoria no se sobrescribe: <em>se fecha</em>.</h1>
    <p class="lede">
      Guardas lo que necesitas recordar hablándole a Claude. Cuando un dato cambia,
      el anterior no se borra — queda archivado con su periodo de vigencia. Preguntas
      hoy y te responde hoy; preguntas por el pasado y te lo reconstruye.
    </p>
    <div class="cta-row">
      <a class="btn" href="#conectar">Conectar con Claude</a>
      <a class="btn ghost" href="https://github.com/jpreyestCL/secondbrain">Ver el código</a>
    </div>
  </div>

  <div class="demo">
    <div class="demo-head">
      <span class="demo-q">¿Cuál es mi cuenta corriente?</span>
      <span class="eyebrow">arrastra el año</span>
    </div>
    <div class="demo-body">
      <div class="year" id="yr">2026</div>
      <div class="answer" aria-live="polite">
        <span class="label" id="alabel">Respuesta vigente</span>
        <div class="value" id="aval">Banco Santander · 789-012-345</div>
        <div class="range" id="arange">vigente desde 2026-08-01</div>
      </div>
      <div class="slider-wrap">
        <label class="eyebrow" for="sl">Línea de tiempo</label>
        <!-- Sin aria-label: el nombre accesible debe ser la etiqueta visible
             ("Línea de tiempo", WCAG 2.5.3). min=2010 hace alcanzable el
             tramo anterior al primer registro. -->
        <input id="sl" type="range" min="2010" max="2026" value="2026" step="1" />
        <div class="ticks"><span>2010</span><span>2018</span><span>2026</span></div>
      </div>
      <div class="history">
        <span class="eyebrow">Registro completo</span>
        <div id="recs"></div>
      </div>
    </div>
  </div>
</div></header>

<section id="como"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Cómo funciona</p>
    <h2>Le hablas a Claude. El resto ocurre solo.</h2>
    <p class="lede">No hay app que abrir ni formularios que llenar. Conectas una vez y tu
      cerebro queda disponible en cualquier conversación, en web, escritorio o teléfono.</p>
  </div>
  <div class="grid c4">
    <div class="card">
      <span class="num">PASO 1</span>
      <h3>Le cuentas algo</h3>
      <p>“Guarda que mi cuenta del Banco de Chile es la 123-456.” Claude entiende de qué
        ámbito es y de cuándo data el hecho.</p>
    </div>
    <div class="card">
      <span class="num">PASO 2</span>
      <h3>O le pasas un documento</h3>
      <p>Adjuntas un PDF, una foto o una planilla en el chat. Lo lee —incluso escaneado—,
        lo ordena y lo archiva por secciones.</p>
    </div>
    <div class="card">
      <span class="num">PASO 3</span>
      <h3>Se archiva con fecha</h3>
      <p>Cada dato entra con la fecha real del hecho, no la de hoy. Si contradice algo
        anterior, lo cierra en esa fecha en vez de borrarlo.</p>
    </div>
    <div class="card">
      <span class="num">PASO 4</span>
      <h3>Preguntas cuando quieras</h3>
      <p>En lenguaje natural. Por defecto responde con lo vigente; si pides historia,
        te entrega la línea de tiempo.</p>
    </div>
  </div>
</div></section>

<section id="usar"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Qué le preguntas</p>
    <h2>Lo que hoy vive en capturas de pantalla y correos viejos.</h2>
  </div>
  <div class="grid c2">
    <div class="card">
      <h3>Guardar</h3>
      <div class="asklist">
        <div class="quote">Guarda que el router de la casa es TP-Link y la clave está en 1Password.</div>
        <div class="quote">Anota que en la reunión de hoy decidimos usar Postgres en el proyecto X.</div>
        <div class="quote">Ingesta este contrato <em>(adjunto)</em> a mi second brain.</div>
      </div>
    </div>
    <div class="card">
      <h3>Consultar</h3>
      <div class="asklist">
        <div class="quote">¿Con quién tengo acuerdo de confidencialidad?</div>
        <div class="quote">¿Qué exámenes me hice el 2024 y qué decían?</div>
        <div class="quote">Dame el historial de mis cuentas bancarias.</div>
      </div>
    </div>
  </div>
</div></section>

<section id="esquema"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Bajo el capó</p>
    <h2>Cada persona, su propio grafo.</h2>
    <p class="lede">Tu información vive en un grafo de conocimiento separado, con su propio
      usuario de base de datos y su propio proceso. El aislamiento es estructural: no
      depende de que un filtro esté bien escrito.</p>
  </div>
  <div class="schema"><pre>
   Claude  (web · escritorio · móvil)
     │
     │  conector MCP  ·  OAuth 2.1 + PKCE
     ▼
  <b>gateway</b> ─── autentica y enruta a cada quien a SU cerebro
     │
     ├──► <b>tu proceso</b>  ──► <b>tu grafo</b>      ← nadie más lo alcanza
     └──► otro proceso  ──► otro grafo

  El grafo guarda:   episodio (texto original)
                     entidades y relaciones extraídas
                     <b>vigencia</b>  desde ── hasta   ← nada se borra
</pre></div>
</div></section>

<section id="conectar"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Conectar</p>
    <h2>Tres pasos, una sola vez.</h2>
  </div>
  <div class="grid c2">
    <div class="card">
      <div class="steps">
        <div class="step"><div>En Claude, abre <strong>Ajustes → Conectores</strong> y elige
          <strong>Agregar conector personalizado</strong>.</div></div>
        <div class="step"><div>Pega esta dirección:
          <span class="url">${mcpUrl}</span></div></div>
        <div class="step"><div>Inicia sesión cuando se abra la ventana. Listo: tu cerebro
          queda disponible en todas tus conversaciones.</div></div>
      </div>
    </div>
    <div class="card">
      <h3>¿Todavía no tienes cuenta?</h3>
      <p>El acceso es por invitación: necesitas un código para crear tu espacio. Si ya lo
        tienes, regístrate y en el mismo momento se crea tu grafo privado. Si ya tienes
        cuenta, puedes entrar con Google.</p>
      <div class="cta-row" style="margin-top:.4rem">
        <a class="btn" href="/registro">Crear cuenta</a>
        <a class="btn ghost" href="/login">Ya tengo cuenta</a>
      </div>
      <p style="margin-top:.8rem">¿Prefieres control total? El proyecto es abierto y puedes
        <a href="https://github.com/jpreyestCL/secondbrain">levantarlo en tu propio servidor</a>.</p>
    </div>
  </div>
</div></section>

<section id="privacidad"><div class="wrap">
  <div class="sec-head">
    <p class="eyebrow">Sobre tus datos</p>
    <h2>Guarda cosas sensibles — con cuidado.</h2>
  </div>
  <div class="grid c2">
    <div class="card">
      <h3>Contraseñas: no</h3>
      <p>Claves, tokens y números de tarjeta se detectan y se reemplazan antes de escribir
        nada. Se guarda que la credencial existe y dónde está, nunca su valor.</p>
    </div>
    <div class="card">
      <h3>Salud y finanzas: sí</h3>
      <p>Exámenes, contratos y cuentas se guardan marcados como sensibles, dentro de tu
        grafo aislado. Y el código es público: puedes auditar exactamente qué ocurre.</p>
    </div>
  </div>
</div></section>

<footer><div class="wrap foot-row">
  <span>secondbrain · memoria temporal para Claude</span>
  <span>
    <a href="/cuenta">Tu cuenta</a> ·
    <a href="https://github.com/jpreyestCL/secondbrain">Código en GitHub</a> ·
    construido sobre <a href="https://github.com/getzep/graphiti">Graphiti</a> y
    <a href="https://www.falkordb.com/">FalkorDB</a>
  </span>
</div></footer>

<script>
(function () {
  var RECS = [
    { txt: "Banco Estado · 44-556-677",     from: 2014, to: 2018 },
    { txt: "Banco de Chile · 123-456-789",  from: 2018, to: 2026 },
    { txt: "Banco Santander · 789-012-345", from: 2026, to: null }
  ];
  var sl = document.getElementById("sl");
  var yr = document.getElementById("yr");
  var aval = document.getElementById("aval");
  var arange = document.getElementById("arange");
  var alabel = document.getElementById("alabel");
  var recs = document.getElementById("recs");

  function fmt(r) {
    return r.to === null ? "vigente desde " + r.from : r.from + " — " + r.to;
  }

  function render(y) {
    yr.textContent = String(y);
    var active = null;
    for (var i = 0; i < RECS.length; i++) {
      var r = RECS[i];
      if (y >= r.from && (r.to === null || y < r.to)) { active = r; break; }
    }
    if (active) {
      aval.textContent = active.txt;
      arange.textContent = fmt(active);
      alabel.textContent = (y >= 2026) ? "Respuesta vigente" : "Respuesta en " + y;
    } else {
      aval.textContent = "Todavía no había registro";
      arange.textContent = "—";
      alabel.textContent = "Respuesta en " + y;
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

  sl.addEventListener("input", function () { render(parseInt(sl.value, 10)); });
  render(parseInt(sl.value, 10));
})();
</script>
</body>
</html>`;
}
