/**
 * Constelación: dibuja con qué se relaciona una entidad y desde cuándo.
 *
 * Es la única vista que muestra lo que un listado no puede: las **relaciones**
 * y su vigencia. Un dato que dejó de ser verdad no desaparece — se dibuja en
 * trazo discontinuo y en el color de lo histórico, así que la historia se ve
 * de un vistazo en lugar de tener que pedirla.
 *
 * SVG generado en el servidor, sin librerías: la CSP del sitio bloquea scripts
 * externos, y un grafo de fuerza en el navegador para 20 nodos es un cañón para
 * matar una mosca. El layout radial se calcula aquí y sale listo.
 *
 * Deliberadamente NO se dibuja el grafo completo: 4.000 nodos en pantalla son
 * una maraña bonita e ilegible. Una entidad y sus vecinos responden la pregunta
 * que la gente hace de verdad — "¿qué tiene que ver con esto?".
 */
import { escapeHtml } from "./html.js";

export interface Relacion {
  con: string;
  uuid: string;
  dato: string;
  desde: string;
  hasta: string;
}

export interface Constelacion {
  entidad: string;
  uuid: string;
  relaciones: Relacion[];
}

const ANCHO = 900;
const ALTO = 620;

/** Corta sin partir palabras a la mitad. */
function recorta(texto: string, max: number): string {
  if (texto.length <= max) return texto;
  const corte = texto.slice(0, max);
  const espacio = corte.lastIndexOf(" ");
  return (espacio > max * 0.6 ? corte.slice(0, espacio) : corte).trimEnd() + "…";
}

function anio(fecha: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(fecha || "");
  if (!m) return "";
  const meses = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${meses[Number(m[2]) - 1] ?? ""} ${m[1]}`;
}

/**
 * Reparte los vecinos en un anillo.
 *
 * Se empieza arriba y se alterna el radio en dos capas cuando hay muchos: con
 * todos a la misma distancia las etiquetas de los lados se pisan, y el dibujo
 * pasa de legible a decorativo.
 */
function posiciones(n: number): Array<{ x: number; y: number; angulo: number; capa: number }> {
  const cx = ANCHO / 2;
  const cy = ALTO / 2;
  const base = n <= 6 ? 200 : n <= 12 ? 225 : 240;
  return Array.from({ length: n }, (_, i) => {
    const angulo = (i / n) * Math.PI * 2 - Math.PI / 2;
    const capa = n > 8 ? i % 2 : 0;
    const radio = base + capa * 58;
    return {
      x: cx + Math.cos(angulo) * radio * 1.35, // elipse: hay más ancho que alto
      y: cy + Math.sin(angulo) * radio * 0.82,
      angulo,
      capa,
    };
  });
}

export function constelacionSvg(datos: Constelacion, base = ""): string {
  const cx = ANCHO / 2;
  const cy = ALTO / 2;
  const rels = datos.relaciones.slice(0, 18);
  const pos = posiciones(rels.length);

  const aristas = rels
    .map((r, i) => {
      const p = pos[i];
      // Curva suave hacia el centro: las rectas puras dan aspecto de diagrama
      // de ingeniería; el arco leve hace que el conjunto se lea como un mapa.
      const mx = (cx + p.x) / 2 + (p.y - cy) * 0.08;
      const my = (cy + p.y) / 2 - (p.x - cx) * 0.08;
      const vigente = !r.hasta;
      return `    <path class="arista ${vigente ? "viva" : "historica"}" style="--i:${i}"
      d="M ${cx.toFixed(1)} ${cy.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${p.x.toFixed(1)} ${p.y.toFixed(1)}">
      <title>${escapeHtml(r.dato || r.con)}</title>
    </path>`;
    })
    .join("\n");

  const nodos = rels
    .map((r, i) => {
      const p = pos[i];
      const derecha = p.x >= cx;
      const vigente = !r.hasta;
      const vigencia = vigente
        ? r.desde
          ? `desde ${anio(r.desde)}`
          : ""
        : `hasta ${anio(r.hasta)}`;
      const cuerpo = `<g class="nodo ${vigente ? "viva" : "historica"}" style="--i:${i}"
       transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})">
      <title>${escapeHtml(r.dato || r.con)}</title>
      <circle r="6"/>
      <text class="etiqueta" x="${derecha ? 14 : -14}" y="4"
        text-anchor="${derecha ? "start" : "end"}">${escapeHtml(recorta(r.con, 26))}</text>
      ${
        vigencia
          ? `<text class="vigencia" x="${derecha ? 14 : -14}" y="20"
        text-anchor="${derecha ? "start" : "end"}">${escapeHtml(vigencia)}</text>`
          : ""
      }
    </g>`;
      // Cada vecino es un enlace: pinchar re-centra la constelacion en el. Eso
      // convierte el dibujo en algo explorable en vez de una foto.
      return base && r.uuid
        ? `    <a href="${escapeHtml(base)}?entidad=${encodeURIComponent(r.uuid)}">${cuerpo}</a>`
        : `    ${cuerpo}`;
    })
    .join("\n");

  return `<svg class="constelacion" viewBox="0 0 ${ANCHO} ${ALTO}"
     role="img" aria-label="Relaciones de ${escapeHtml(datos.entidad)}">
  <g class="aristas">
${aristas}
  </g>
  <g class="centro">
    <circle class="halo" cx="${cx}" cy="${cy}" r="64"/>
    <circle class="nucleo" cx="${cx}" cy="${cy}" r="9"/>
    <text class="titulo" x="${cx}" y="${cy - 26}" text-anchor="middle">${escapeHtml(
      recorta(datos.entidad, 34),
    )}</text>
  </g>
  <g class="nodos">
${nodos}
  </g>
</svg>`;
}

/** CSS de la constelación. Se inyecta en el shell del panel. */
export const CONSTELACION_CSS = `
  .constelacion { width: 100%; height: auto; display: block; overflow: visible; }
  .constelacion .halo { fill: var(--accent-soft); opacity: .5; }
  .constelacion .nucleo { fill: var(--accent); }
  .constelacion .titulo {
    font-family: var(--display); font-size: 25px; fill: var(--text);
    letter-spacing: -.01em;
  }
  .constelacion .arista { fill: none; stroke-width: 1; stroke-linecap: round; }
  .constelacion .arista.viva { stroke: var(--accent); opacity: .55; }
  /* Lo que dejó de ser verdad se dibuja discontinuo y en el color de lo
     histórico: la vigencia se lee sin tener que consultarla. */
  .constelacion .arista.historica {
    stroke: var(--histo); opacity: .5; stroke-dasharray: 3 5;
  }
  .constelacion .nodo circle { fill: var(--surface); stroke-width: 1.5; }
  .constelacion .nodo.viva circle { stroke: var(--accent); }
  .constelacion .nodo.historica circle { stroke: var(--histo); }
  .constelacion .etiqueta {
    font-family: var(--sans); font-size: 13px; fill: var(--text);
  }
  .constelacion .nodo.historica .etiqueta { fill: var(--muted); }
  .constelacion .vigencia {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .1em;
    text-transform: uppercase; fill: var(--muted);
  }
  .constelacion a { cursor: pointer; }
  .constelacion a:hover .etiqueta { fill: var(--accent-text); text-decoration: underline; }
  .constelacion a:hover circle { r: 8; }
  .constelacion a:focus-visible circle { outline: 2px solid var(--accent); outline-offset: 3px; }

  @media (prefers-reduced-motion: no-preference) {
    .constelacion .arista {
      stroke-dasharray: 460; stroke-dashoffset: 460;
      animation: trazo .9s var(--ease) forwards;
      animation-delay: calc(var(--i) * 45ms);
    }
    .constelacion .arista.historica {
      animation-name: trazo-historico;
    }
    .constelacion .nodo {
      opacity: 0; animation: aparece .5s var(--ease) forwards;
      animation-delay: calc(320ms + var(--i) * 45ms);
    }
    .constelacion .centro { animation: aparece .6s var(--ease) both; }
    .constelacion .halo { transform-origin: center; animation: latido 5s ease-in-out infinite; }
    @keyframes trazo { to { stroke-dashoffset: 0; } }
    /* Termina en el patrón discontinuo, no en línea continua. */
    @keyframes trazo-historico { to { stroke-dashoffset: 0; stroke-dasharray: 3 5; } }
    @keyframes aparece { from { opacity: 0; transform: translateY(6px); } }
    @keyframes latido { 50% { opacity: .3; } }
  }
  .constelacion .nodo, .constelacion .centro { transition: opacity .3s; }
`;
