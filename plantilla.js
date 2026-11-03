// Nueva plantilla desde un archivo (PDF de una presentación, imágenes de slides o un HTML ya hecho).
// Hace lo mismo que se hizo a mano con METRO, Hush Puppies y BICE:
//  1) Analiza todas las páginas (miniaturas + texto): tema de color, páginas representativas y ficha.
//  2) Replica cada página elegida como slide HTML del sistema (alma.css), recortando las fotos reales del PDF.
//  3) Arma la plantilla con su tema y su ficha (estado "Plantilla") en plantillas/.
// Requiere poppler (pdftoppm/pdftotext/pdfinfo) para PDF: brew install poppler
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ai = require('./ai');
const { readFicha, writeFicha, normalize, slidesText, OPCIONES } = require('./ficha');
const { guiaMarca } = require('./estilo');
const imagenes = require('./imagenes');

const ROOT = __dirname;
const CONCURRENCY = Number(process.env.AI_CONCURRENCY) || 3;
const MAX_PAGES = 24;
const jobs = new Map();
const HEX = /^#[0-9a-f]{6}$/i;

const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
function popplerBin(name) {
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  return null;
}
const slugify = (s) => String(s || 'plantilla').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'plantilla';
const b64 = (file) => fsp.readFile(file).then((b) => b.toString('base64'));

/* ───────── preparar páginas ───────── */
async function preparePdf(tmp, data) {
  const ppm = popplerBin('pdftoppm'), txt = popplerBin('pdftotext'), info = popplerBin('pdfinfo');
  if (!ppm || !txt || !info) throw new Error('Para importar PDF se necesita poppler. Instálalo con: brew install poppler');
  const pdf = path.join(tmp, 'src.pdf');
  await fsp.writeFile(pdf, Buffer.from(data, 'base64'));
  const meta = await run(info, [pdf]);
  const n = +((meta.match(/Pages:\s+(\d+)/) || [])[1] || 0);
  if (!n) throw new Error('No se pudo leer el PDF');
  // miniaturas para el análisis (máx. 100 páginas)
  await run(ppm, ['-jpeg', '-jpegopt', 'quality=70', '-scale-to', '420', '-l', String(Math.min(n, 100)), pdf, path.join(tmp, 't')]);
  const pages = [];
  for (let i = 1; i <= n; i++) {
    const text = (await run(txt, ['-f', String(i), '-l', String(i), '-layout', pdf, '-']).catch(() => '')).replace(/[ \t]+/g, ' ').trim();
    pages.push({ n: i, text });
  }
  const thumbs = (await fsp.readdir(tmp)).filter((f) => /^t-\d+\.jpg$/.test(f)).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
  for (const f of thumbs) { const k = parseInt(f.slice(2)); if (pages[k - 1]) pages[k - 1].thumb = path.join(tmp, f); }
  return { kind: 'pdf', pdf, pages, ppm };
}

async function prepareImages(tmp, files) {
  const pages = [];
  for (const [i, f] of files.entries()) {
    const ext = f.type === 'image/png' ? 'png' : 'jpg';
    const p = path.join(tmp, `img-${i + 1}.${ext}`);
    await fsp.writeFile(p, Buffer.from(f.data, 'base64'));
    pages.push({ n: i + 1, text: '', thumb: p, full: p, type: f.type });
  }
  return { kind: 'img', pages };
}

async function pageImage(src, n, tmp) {
  if (src.kind === 'img') return { data: await b64(src.pages[n - 1].full), type: src.pages[n - 1].type };
  const out = path.join(tmp, `p${n}`);
  await run(src.ppm, ['-jpeg', '-jpegopt', 'quality=82', '-singlefile', '-f', String(n), '-l', String(n), '-scale-to-x', '1600', '-scale-to-y', '900', src.pdf, out]);
  return { data: await b64(out + '.jpg'), type: 'image/jpeg' };
}

// recorte de una zona de la página (coordenadas del lienzo 1920×1080) → URL en media/
async function crop(src, n, box, tmp) {
  const [x, y, w, h] = box.map((v) => Math.round(+v));
  if (![x, y, w, h].every(Number.isFinite) || w < 40 || h < 40) return null;
  const buf = src.kind === 'pdf'
    ? await imagenes.cropPdf(src.pdf, n, { x, y, w, h }, tmp)
    : await imagenes.cropImage(src.pages[n - 1].full, { x, y, w, h }, tmp);
  return buf ? imagenes.saveBuffer(buf, 'image/jpeg') : null;
}

// foto detectada en el PDF (original sin textos encima, o recorte del render) → URL en media/
async function detected(src, n, box, tmp) {
  const ph = await imagenes.photoFromBox(src.pdf, n, box, tmp);
  return ph ? imagenes.saveBuffer(ph.buf, ph.type) : null;
}

const withBg = (tag, url) => (/style="/.test(tag) ? tag.replace(/style="/, `style="background-image:url(${url});`) : tag.replace(/>$/, ` style="background-image:url(${url})">`));
const boxOf = (tag) => {
  const g = (k) => +((tag.match(new RegExp(`(?:^|[;"\\s])${k}:\\s*(-?[\\d.]+)px`)) || [])[1]);
  const b = { x: g('left'), y: g('top'), w: g('width'), h: g('height') };
  return Object.values(b).every(Number.isFinite) ? b : null;
};

/* ───────── 1) análisis ───────── */
async function analyze(src, nombre, notas) {
  const content = [];
  src.pages.forEach((p) => {
    if (p.thumb && content.length < 100) {
      content.push({ type: 'text', text: `Página ${p.n}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: p.type || 'image/jpeg', data: fs.readFileSync(p.thumb).toString('base64') } });
    }
  });
  const texts = src.pages.map((p) => `--- Página ${p.n}\n${p.text.slice(0, 500)}`).join('\n').slice(0, 60000);
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
  const valid = new Set(src.pages.map((p) => p.n));
  const pags = (Array.isArray(j.paginas) ? j.paginas : []).filter((x) => valid.has(+x.pagina)).slice(0, MAX_PAGES);
  if (!pags.length) throw new Error('La IA no pudo identificar las páginas de la presentación.');
  const tema = j.tema || {};
  return {
    nombre: String(nombre || j.nombre || 'Nueva plantilla'), estilo: String(j.estilo || ''), ficha: j.ficha || {},
    tema: { accent: HEX.test(tema.accent) ? tema.accent : '#FF0000', accent2: HEX.test(tema.accent2) ? tema.accent2 : '#42108E', accent3: HEX.test(tema.accent3) ? tema.accent3 : '#008E92' },
    paginas: pags.map((x) => ({ n: +x.pagina, tipo: String(x.tipo || ''), nota: String(x.nota || '') })),
  };
}

/* ───────── 2) replicar cada página ───────── */
async function replicate({ src, page, idx, total, system, estilo, tmp, molde, boxes = [] }) {
  const img = await pageImage(src, page.n, tmp);
  const text = src.pages[page.n - 1].text;
  const lista = boxes.map((b, i) => `- imagen ${i + 1}: left:${b.x}px; top:${b.y}px; width:${b.w}px; height:${b.h}px`).join('\n');
  const prompt = `Replica la página ${page.n} (slide ${idx + 1} de ${total}, tipo "${page.tipo}") de la presentación de referencia como UNA slide HTML del sistema.

# Estilo general de la presentación
${estilo}

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
${text.slice(0, 4000) || '(sin texto extraíble)'}`;
  const r = await ai.complete({ system, content: [{ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } }, { type: 'text', text: prompt }] });
  let html = ai.extractSection(r.text);
  // imágenes: data-img = detectada en el PDF; data-crop = zona a recortar de la página
  const tags = [...html.matchAll(/<div\b[^>]*\bdata-(?:img|crop)="[^"]*"[^>]*>/g)].map((m) => m[0]);
  const used = new Set(), placed = [];
  const urls = await Promise.all(tags.map(async (tag) => {
    const id = (tag.match(/data-img="(\d+)"/) || [])[1];
    const b = id && boxes[+id - 1];
    if (b) { used.add(+id - 1); placed.push(b); return detected(src, page.n, b, tmp).catch(() => null); }
    const box = (tag.match(/data-crop="([^"]+)"/) || [])[1];
    if (box) { const [x, y, w, h] = box.split(',').map(Number); placed.push({ x, y, w, h }); return crop(src, page.n, [x, y, w, h], tmp).catch(() => null); }
    return null;
  }));
  let i = 0;
  html = html.replace(/<div\b[^>]*\bdata-(?:img|crop)="[^"]*"[^>]*>/g, (tag) => {
    const url = urls[i++];
    tag = tag.replace(/\sdata-(?:img|crop)="[^"]*"/g, '').replace(/\s{2,}/g, ' ');
    return url ? withBg(tag, url) : tag.replace(/\bfoto lleno\b/, 'foto');
  });
  // fotos originales que la IA no usó: se agregan en su lugar exacto (detrás del contenido)
  const slots = [...html.matchAll(/<div\b[^>]*class="[^"]*\bfoto\b[^>]*>/g)].map((m) => boxOf(m[0])).filter(Boolean);
  const extra = [];
  for (const [k, b] of boxes.entries()) {
    if (used.has(k) || !b.raw || b.w * b.h < 1920 * 1080 * 0.03) continue;
    if ([...placed, ...slots].some((o) => imagenes.iou(o, b) > 0.3)) continue;
    const url = await detected(src, page.n, b, tmp).catch(() => null);
    if (url) extra.push(`<div class="foto lleno" data-hint="imagen del original" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background-image:url(${url})"></div>`);
  }
  if (extra.length) html = html.replace(/(<div class="canvas"[^>]*>)/, `$1\n${extra.join('\n')}`);
  return html;
}

async function pool(items, n, fn) {
  let i = 0;
  const go = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, go));
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

async function uniqueTemplate(base) {
  let name = `${base}.html`, n = 2;
  while (fs.existsSync(path.join(ROOT, 'plantillas', name))) name = `${base}-${n++}.html`;
  return name;
}

/* ───────── trabajo completo ───────── */
async function runJob(job, { files, nombre, notas }) {
  const say = (t) => job.pasos.push(t);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'alma-tpl-'));
  try {
    const html0 = files.find((f) => /html/.test(f.type) || /\.html?$/i.test(f.name));
    if (html0) {
      // HTML ya construido con el sistema: se importa tal cual y se completa su ficha
      job.fase = 'analizando';
      let html = Buffer.from(html0.data, 'base64').toString('utf8');
      if (!/class="deck"/.test(html) || !/class="slide/.test(html)) throw new Error('El HTML no tiene el formato de presentación del sistema (main.deck > section.slide).');
      const title = (nombre || ((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'Plantilla importada')).trim();
      html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title.replace(/</g, '&lt;')}</title>`);
      say('Claude está leyendo la presentación para generar su ficha…');
      const ficha = await ai.suggestFicha({ title, slides: slidesText(html), ficha: readFicha(html) });
      html = writeFicha(html, { ...ficha, estado: 'Plantilla' });
      const name = await uniqueTemplate(slugify(title));
      await fsp.writeFile(path.join(ROOT, 'plantillas', name), imagenes.externalize(html));
      job.path = `plantillas/${name}`; job.titulo = title; job.fase = 'listo'; say('¡Plantilla lista!');
      return;
    }
    job.fase = 'preparando';
    const pdf = files.find((f) => f.type === 'application/pdf');
    const imgs = files.filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
    if (!pdf && !imgs.length) throw new Error('Adjunta un PDF de la presentación, imágenes de sus slides o un HTML.');
    say(pdf ? 'Leyendo el PDF y generando miniaturas de cada página…' : `Preparando ${imgs.length} imágenes…`);
    const src = pdf ? await preparePdf(tmp, pdf.data) : await prepareImages(tmp, imgs);
    say(`${src.pages.length} páginas. Claude está analizando colores, tipos de slide y contenido…`);

    job.fase = 'analizando';
    const a = await analyze(src, nombre, notas);
    job.titulo = a.nombre;
    job.estructura = a.estilo;
    job.slides = a.paginas.map((p) => ({ proposito: `Página ${p.n} · ${p.tipo}`, accion: 'replicar', origen: p.nota, estado: 'pendiente' }));
    job.total = a.paginas.length;
    say(`Análisis listo: replicaré ${a.paginas.length} páginas representativas. Tema: ${a.tema.accent} · ${a.tema.accent2} · ${a.tema.accent3}.`);

    const slug = slugify(a.nombre.replace(/^plantilla\s*/i, ''));
    const today = new Date().toISOString().slice(0, 10);
    const ficha = normalize({ ...a.ficha, estado: 'Plantilla', fecha: today, plantilla: slug, forma: a.ficha.forma || a.estilo });
    let html = writeFicha(skeleton({ title: a.nombre, slug, tema: a.tema, estilo: a.estilo }), ficha);
    const system = await ai.buildSystem(html);
    // posición exacta de las fotos de cada página elegida (desde el PDF)
    const boxes = src.kind === 'pdf' ? await imagenes.pdfImageBoxes(src.pdf, a.paginas.map((p) => p.n), tmp) : {};
    const nFotos = Object.values(boxes).flat().length;
    if (nFotos) say(`Encontré ${nFotos} imágenes en las páginas elegidas; se guardarán en el banco de imágenes (media/).`);

    // molde técnico: una slide de las plantillas existentes con el mismo tipo (ayuda a usar bien las clases)
    const moldes = {};
    for (const f of (await fsp.readdir(path.join(ROOT, 'plantillas'))).filter((x) => x.endsWith('.html'))) {
      const t = await fsp.readFile(path.join(ROOT, 'plantillas', f), 'utf8');
      for (const s of t.match(/<section class="slide[\s\S]*?<\/section>/gi) || []) {
        const lay = (s.match(/data-layout="([^"]*)"/) || [])[1] || '';
        if (lay && !moldes[lay] && s.length < 9000) moldes[lay] = ai.stripImages(s).out;
      }
    }
    const pick = (tipo) => { const t = tipo.toLowerCase(); const k = Object.keys(moldes).find((l) => t.includes(l) || l.includes(t)); return k ? moldes[k] : ''; };

    job.fase = 'generando';
    const out = new Array(a.paginas.length);
    say(`Replicando ${a.paginas.length} slides (${CONCURRENCY} en paralelo)…`);
    await pool(a.paginas, CONCURRENCY, async (page, k) => {
      job.slides[k].estado = 'generando';
      try {
        out[k] = await replicate({ src, page, idx: k, total: a.paginas.length, system, estilo: a.estilo, tmp, molde: pick(page.tipo), boxes: boxes[page.n] || [] });
        job.slides[k].estado = 'listo';
      } catch (e) {
        out[k] = '';
        job.slides[k].estado = 'error';
        say(`Página ${page.n}: no se pudo replicar (${e.message}).`);
      }
      job.hechas++;
    });
    const ok = out.filter(Boolean);
    if (!ok.length) throw new Error('No se pudo replicar ninguna página.');

    job.fase = 'armando';
    say('Armando la plantilla…');
    html = html.replace(/<main class="deck">\s*<\/main>/, `<main class="deck">\n\n${ok.join('\n\n')}\n\n</main>`);
    const name = await uniqueTemplate(slug);
    await fsp.writeFile(path.join(ROOT, 'plantillas', name), html);
    job.path = `plantillas/${name}`;
    job.fase = 'listo';
    say('¡Plantilla lista! Revísala en el editor y ajusta lo que haga falta.');
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

function start({ files, nombre, notas }) {
  files = (files || []).filter((f) => f && f.data);
  if (!files.length) throw new Error('Adjunta un archivo.');
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, fase: 'en cola', pasos: [], slides: [], total: 0, hechas: 0, inicio: Date.now() };
  jobs.set(id, job);
  runJob(job, { files, nombre: (nombre || '').trim(), notas: (notas || '').trim() })
    .catch((e) => { job.fase = 'error'; job.error = e.message; job.pasos.push('Error: ' + e.message); });
  for (const [k, j] of jobs) if (Date.now() - j.inicio > 6 * 3600e3) jobs.delete(k);
  return { id };
}

function get(id) {
  const j = jobs.get(id);
  if (!j) { const e = new Error('Trabajo no encontrado (¿se reinició el servidor?)'); e.status = 404; throw e; }
  return j;
}

// convertir una presentación existente en plantilla
async function desdePresentacion(rel, titulo) {
  const abs = path.resolve(ROOT, rel);
  if (path.relative(ROOT, path.dirname(abs)) !== 'presentaciones') throw new Error('Ruta no permitida');
  let html = await fsp.readFile(abs, 'utf8');
  const title = (titulo || 'Plantilla ' + ((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')).trim();
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title.replace(/</g, '&lt;')}</title>`);
  const slug = slugify(title.replace(/^plantilla\s*/i, ''));
  if (/<meta name="deck-template"/.test(html)) html = html.replace(/<meta name="deck-template" content="[^"]*">/, `<meta name="deck-template" content="${slug}">`);
  html = writeFicha(html, { ...readFicha(html), estado: 'Plantilla', plantilla: slug });
  const name = await uniqueTemplate(slug);
  await fsp.writeFile(path.join(ROOT, 'plantillas', name), imagenes.externalize(html));
  return { path: `plantillas/${name}` };
}

module.exports = { start, get, desdePresentacion };
