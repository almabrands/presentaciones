// Ficha de cada presentación (su "memoria"): metadatos + resumen de fondo y forma.
// Vive dentro del propio HTML, en <script type="application/json" id="ficha">, para que
// viaje con el archivo al duplicarlo, moverlo o editarlo con Claude Code.

const OPCIONES = {
  tipo: ['Propuesta comercial', 'Oferta técnica', 'Informe de estudio', 'Credenciales', 'Kick-off', 'Programa de formación', 'Presentación de resultados', 'Otro'],
  estado: ['Borrador', 'En revisión', 'Enviada', 'Ganada', 'Perdida', 'Archivada', 'Plantilla'],
  servicios: ['Investigación: insights y métricas', 'Consultoría estratégica', 'Diseño y gestión de marcas', 'Cultura y liderazgo'],
};
const LISTS = ['rubros', 'segmentos', 'servicios', 'estudios', 'productos', 'etiquetas'];
const TEXTS = ['cliente', 'tipo', 'estado', 'fecha', 'valor', 'responsable', 'fondo', 'forma', 'plantilla'];
const FICHA_RE = /<script type="application\/json" id="ficha">([\s\S]*?)<\/script>\s*/i;

function normalize(m) {
  const out = {};
  for (const k of TEXTS) out[k] = typeof m?.[k] === 'string' ? m[k].trim() : '';
  for (const k of LISTS) {
    const v = m?.[k];
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
    out[k] = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
  }
  return out;
}

function readFicha(html) {
  const m = html.match(FICHA_RE);
  if (!m) return normalize({});
  try { return normalize(JSON.parse(m[1])); } catch { return normalize({}); }
}

function writeFicha(html, ficha) {
  const json = JSON.stringify(normalize(ficha), null, 2).replace(/</g, '\\u003c');
  const block = `<script type="application/json" id="ficha">\n${json}\n</script>\n`;
  if (FICHA_RE.test(html)) return html.replace(FICHA_RE, block);
  return html.replace(/<\/head>/i, block + '</head>');
}

// Texto plano de cada slide: título (primer encabezado) + contenido, para buscar y para la IA
function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
const plain = (s) => decodeEntities(s.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function slidesText(html) {
  const out = [];
  const re = /<section class="slide[^>]*>([\s\S]*?)<\/section>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const hidden = /data-oculta/.test(m[0].slice(0, 200));
    const h = body.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    out.push({ titulo: h ? plain(h[1]).slice(0, 120) : '', texto: plain(body), oculta: hidden });
  }
  return out;
}

module.exports = { readFicha, writeFicha, slidesText, normalize, LISTS, OPCIONES };
