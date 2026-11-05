// Nueva plantilla desde un archivo (PDF de una presentación, imágenes de slides o un HTML ya hecho).
// El navegador hace el trabajo pesado (core/pdf-import.js con pdf.js: miniaturas, texto, posición de las fotos,
// recortes) y orquesta pasos cortos contra estos endpoints, para que funcione en Vercel (sin disco, sin poppler,
// requests < 4,5 MB y sin trabajos en memoria):
//  1) analyze   — miniaturas + texto de todas las páginas → tema de color, páginas representativas y ficha.
//  2) replicate — una página (imagen + texto + cajas de fotos) → slide HTML con slots data-img / data-crop
//                 (el navegador recorta esas fotos, las sube a media/ y reemplaza los slots).
//  3) save      — arma la plantilla con su tema y ficha (estado "Plantilla") y la guarda en plantillas/.
const ai = require('./ai');
const storage = require('./storage');
const imagenes = require('./imagenes');
const { readFicha, writeFicha, normalize, slidesText, OPCIONES } = require('./ficha');

const MAX_PAGES = 24;
const HEX = /^#[0-9a-f]{6}$/i;
const B64 = /^[A-Za-z0-9+/=]+$/;

const slugify = (s) => String(s || 'plantilla').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'plantilla';
const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
const img64 = (s) => { s = String(s || '').replace(/^data:[^,]*,/, ''); if (!s || !B64.test(s)) throw fail('Imagen inválida'); return s; };

/* ───────── 1) análisis ───────── */
async function analyze({ pages, nombre, notas }) {
  if (!Array.isArray(pages) || !pages.length) throw fail('El archivo no tiene páginas.');
  pages = pages.slice(0, 100).map((p, i) => ({ n: +p.n || i + 1, text: String(p.text || ''), thumb: p.thumb ? img64(p.thumb) : null, type: p.type || 'image/jpeg' }));
  const content = [];
  pages.forEach((p) => {
    if (!p.thumb) return;
    content.push({ type: 'text', text: `Página ${p.n}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: p.type, data: p.thumb } });
  });
  const texts = pages.map((p) => `--- Página ${p.n}\n${p.text.slice(0, 500)}`).join('\n').slice(0, 60000);
  const system = `Eres el director de arte de Almabrands. Analizas una presentación de referencia para convertirla en una PLANTILLA del sistema de presentaciones HTML de la marca.
Responde SOLO un objeto JSON:
{"nombre": "Plantilla <Cliente> · <tipo>", "tema": {"accent": "#RRGGBB color principal", "accent2": "#RRGGBB secundario", "accent3": "#RRGGBB terciario"},
 "estilo": "3-5 líneas: fondos, uso del color, tipografía, tratamiento de fotos (B/N, recortes, bordes rasgados), íconos, pies de página",
 "paginas": [{"pagina": n, "tipo": "portada|seccion|texto|lista|columnas|tarjetas|cifras|tabla|grafico|gantt|equipo|logos|cierre|…", "nota": "qué la hace representativa"}],
 "ficha": {"cliente": "", "tipo": uno de ${JSON.stringify(OPCIONES.tipo)}, "rubros": [], "segmentos": [], "servicios": [subconjunto de ${JSON.stringify(OPCIONES.servicios)}], "estudios": [], "productos": [], "etiquetas": [], "fondo": "4-6 líneas", "forma": "2-4 líneas"}}
Reglas para "paginas": elige entre 8 y ${MAX_PAGES} páginas que cubran TODOS los tipos de slide distintos (portada, separadores, cada layout de contenido, cierre), en el orden original. Si hay muchas páginas con el mismo layout, incluye solo una o dos. Si son ${MAX_PAGES} o menos, incluye todas salvo duplicados exactos.
Español de Chile.`;
  content.push({ type: 'text', text: `Nombre sugerido por el usuario: ${nombre || '(ninguno)'}\nNotas del usuario: ${notas || '(ninguna)'}\n\nTexto extraído por página:\n${texts}` });
  const r = await ai.complete({ system, content });
  const j = ai.extractJson(r.text);
  const costoAnalisis = ai.costo(r);
  const valid = new Set(pages.map((p) => p.n));
  const pags = (Array.isArray(j.paginas) ? j.paginas : []).filter((x) => valid.has(+x.pagina)).slice(0, MAX_PAGES);
  if (!pags.length) throw new Error('La IA no pudo identificar las páginas de la presentación.');
  const tema = j.tema || {};
  return {
    nombre: String(nombre || j.nombre || 'Nueva plantilla'), estilo: String(j.estilo || ''), ficha: j.ficha || {},
    tema: { accent: HEX.test(tema.accent) ? tema.accent : '#FF0000', accent2: HEX.test(tema.accent2) ? tema.accent2 : '#42108E', accent3: HEX.test(tema.accent3) ? tema.accent3 : '#008E92' },
    paginas: pags.map((x) => ({ n: +x.pagina, tipo: String(x.tipo || ''), nota: String(x.nota || '') })),
    costo: costoAnalisis,
  };
}

// análisis que devuelve el navegador en cada paso (se sanea: viene del cliente)
function cleanA(a) {
  a = a || {};
  const t = a.tema || {};
  return {
    nombre: String(a.nombre || 'Nueva plantilla').slice(0, 120), estilo: String(a.estilo || '').slice(0, 2000),
    ficha: a.ficha && typeof a.ficha === 'object' ? a.ficha : {},
    tema: { accent: HEX.test(t.accent) ? t.accent : '#FF0000', accent2: HEX.test(t.accent2) ? t.accent2 : '#42108E', accent3: HEX.test(t.accent3) ? t.accent3 : '#008E92' },
  };
}

function skeleton({ title, slug, tema, estilo }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<meta name="deck-template" content="${slug}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,500;1,600;1,700&display=block">
<link rel="stylesheet" href="../core/alma.css">
<style>
/* Tema ${title.replace(/\*\//g, '')} — ${estilo.replace(/\s+/g, ' ').replace(/\*\//g, '').slice(0, 160)} */
:root{--accent:${tema.accent};--accent2:${tema.accent2};--accent3:${tema.accent3}}
</style>
<script src="../core/editor.js" defer></script>
</head>
<body>
<main class="deck">
</main>
</body>
</html>
`;
}

function deckHead(a) {
  const slug = slugify(a.nombre.replace(/^plantilla\s*/i, ''));
  const today = new Date().toISOString().slice(0, 10);
  const ficha = normalize({ ...a.ficha, estado: 'Plantilla', fecha: today, plantilla: slug, forma: a.ficha.forma || a.estilo });
  return { slug, html: writeFicha(skeleton({ title: a.nombre, slug, tema: a.tema, estilo: a.estilo }), ficha) };
}

// moldes técnicos: una slide de las plantillas existentes por layout (ayuda a usar bien las clases)
let moldesCache = null, moldesAt = 0;
async function moldes() {
  if (moldesCache && Date.now() - moldesAt < 10 * 60e3) return moldesCache;
  const out = {};
  const list = await storage.listDeckDetails('plantillas').catch(() => []);
  for (const d of list) {
    const t = await storage.readDeck(d.path).catch(() => '');
    for (const s of t.match(/<section class="slide[\s\S]*?<\/section>/gi) || []) {
      const lay = (s.match(/data-layout="([^"]*)"/) || [])[1] || '';
      if (lay && !out[lay] && s.length < 9000) out[lay] = ai.stripImages(s).out;
    }
  }
  moldesCache = out; moldesAt = Date.now();
  return out;
}
async function pickMolde(tipo) {
  const m = await moldes();
  const t = String(tipo || '').toLowerCase();
  const k = t && Object.keys(m).find((l) => t.includes(l) || l.includes(t));
  return k ? m[k] : '';
}

/* ───────── 2) replicar una página ───────── */
// devuelve la slide con los slots de imagen marcados: data-img="N" (caja detectada N) o data-crop="x,y,w,h"
async function replicate({ a, page, idx, total, image, text, boxes }) {
  a = cleanA(a);
  page = { n: +page?.n || 1, tipo: String(page?.tipo || ''), nota: String(page?.nota || '') };
  boxes = (Array.isArray(boxes) ? boxes : []).slice(0, 40).map((b) => ({ x: Math.round(+b.x), y: Math.round(+b.y), w: Math.round(+b.w), h: Math.round(+b.h) }))
    .filter((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite));
  const system = await ai.buildSystem(deckHead(a).html);
  const molde = await pickMolde(page.tipo);
  const lista = boxes.map((b, i) => `- imagen ${i + 1}: left:${b.x}px; top:${b.y}px; width:${b.w}px; height:${b.h}px`).join('\n');
  const prompt = `Replica la página ${page.n} (slide ${(+idx || 0) + 1} de ${+total || 1}, tipo "${page.tipo}") de la presentación de referencia como UNA slide HTML del sistema.

# Estilo general de la presentación
${a.estilo}

# Cómo replicarla
- Reproduce la composición, jerarquía, proporciones, colores y textos EXACTOS de la imagen (corrige solo errores evidentes). Coordenadas en el lienzo 1920×1080: la imagen adjunta está a escala de ese lienzo.
- Usa el color principal como var(--accent), el secundario var(--accent2) y el terciario var(--accent3); clases de alma.css siempre que existan (títulos, listas, tarjetas, kpi, tablas, gantt, bars, donut, pill, logos, contact, pincel, etc.).
${lista ? `- IMÁGENES DETECTADAS en el archivo original de esta página (posición exacta en el lienzo):
${lista}
  Para cada foto, ilustración o logo de esta lista usa un slot <div class="foto lleno" data-img="N" data-hint="descripción" style="left:..;top:..;width:..;height:.."> con esas mismas coordenadas: el sistema inserta la imagen original. Omite solo las que sean puramente decorativas y ya se reproduzcan con componentes del sistema (pincel/borde rasgado, logo almabrands). Si una imagen va de fondo de toda la slide, ponla primero dentro del .canvas.
` : ''}- Otras FOTOGRAFÍAS o imágenes que veas y no estén en esa lista: un slot <div class="foto lleno" data-crop="x,y,w,h" data-hint="descripción" style="left:..;top:..;width:..;height:.."> con las MISMAS coordenadas (en px del lienzo 1920×1080) que ocupa en la página: el sistema recorta esa zona del original y la inserta.
- Agrega "bw" si la foto es en blanco y negro, y "contain" a logos de clientes o marcas.
- Logo almabrands: <img class="logo" src="../core/assets/logo-almabrands.png"> o logo-almabrands-blanco.png sobre fondos de color.
- Íconos simples: SVG inline de trazo (class="li"). Bordes rasgados/pinceladas: <div class="pincel"> (o .pincel.ac / .flip).
- Gráficos: componentes editables (.bars, .donut, tablas) con los mismos datos.
- Si un texto no se lee, usa un marcador [texto].
${molde ? `\n# Slide existente con estructura parecida (úsala como referencia técnica de clases; NO copies su contenido)\n${molde}\n` : ''}
# Texto extraído de la página (para no cometer errores de transcripción)
${String(text || '').slice(0, 4000) || '(sin texto extraíble)'}`;
  const r = await ai.complete({ tier: 'slide', system, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img64(image) } }, { type: 'text', text: prompt }] });
  return { html: ai.extractSection(r.text), costo: ai.costo(r) };
}

/* ───────── 3) guardar ───────── */
async function save({ a, slides }) {
  a = cleanA(a);
  const ok = (Array.isArray(slides) ? slides : []).map(String).filter((s) => /<section class="slide/.test(s));
  if (!ok.length) throw fail('No se pudo replicar ninguna página.');
  const { slug, html: head } = deckHead(a);
  // por si quedó alguna imagen embebida: a media/
  const body = await imagenes.externalizeAsync(ok.map((s) => s.replace(/\sdata-(?:img|crop)="[^"]*"/g, '')).join('\n\n'));
  const html = head.replace(/<main class="deck">\s*<\/main>/, `<main class="deck">\n\n${body}\n\n</main>`);
  const name = await storage.uniqueName('plantillas', slug);
  await storage.writeDeck(`plantillas/${name}`, html, { backup: false });
  return { path: `plantillas/${name}`, titulo: a.nombre };
}

// HTML ya construido con el sistema: se importa tal cual (el navegador ya subió sus imágenes) y se completa su ficha
async function importHtml({ html, nombre }) {
  html = String(html || '');
  if (!/class="deck"/.test(html) || !/class="slide/.test(html)) throw fail('El HTML no tiene el formato de presentación del sistema (main.deck > section.slide).');
  const title = (String(nombre || '').trim() || ((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'Plantilla importada')).trim();
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title.replace(/</g, '&lt;')}</title>`);
  const ficha = await ai.suggestFicha({ title, slides: slidesText(html), ficha: readFicha(html) });
  html = writeFicha(html, { ...ficha, estado: 'Plantilla' });
  const name = await storage.uniqueName('plantillas', slugify(title));
  await storage.writeDeck(`plantillas/${name}`, await imagenes.externalizeAsync(html), { backup: false });
  return { path: `plantillas/${name}`, titulo: title };
}

// convertir una presentación existente en plantilla
async function desdePresentacion(rel, titulo) {
  rel = storage.validatePath(rel);
  if (!rel.startsWith('presentaciones/')) throw fail('Ruta no permitida');
  let html = await storage.readDeck(rel);
  const title = (titulo || 'Plantilla ' + ((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')).trim();
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title.replace(/</g, '&lt;')}</title>`);
  const slug = slugify(title.replace(/^plantilla\s*/i, ''));
  if (/<meta name="deck-template"/.test(html)) html = html.replace(/<meta name="deck-template" content="[^"]*">/, `<meta name="deck-template" content="${slug}">`);
  html = writeFicha(html, { ...readFicha(html), estado: 'Plantilla', plantilla: slug });
  const name = await storage.uniqueName('plantillas', slug);
  await storage.writeDeck(`plantillas/${name}`, await imagenes.externalizeAsync(html), { backup: false });
  return { path: `plantillas/${name}` };
}

module.exports = { analyze, replicate, save, importHtml, desdePresentacion };
