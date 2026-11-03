// Crear una presentación completa con IA reutilizando slides existentes.
// 1) Planificar: Claude recibe el brief, los adjuntos y un índice de TODAS las slides (plantillas y
//    presentaciones) y arma la estructura eligiendo, para cada slide, una slide de origen que se
//    reusa tal cual o se adapta. Así la gráfica siempre sale de diseños existentes.
// 2) Construir: las slides a adaptar se reescriben en paralelo usando su origen como molde.
// 3) Armar: se monta todo sobre el tema de la presentación base, con su ficha, y se guarda.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const ai = require('./ai');
const imagenes = require('./imagenes');
const { readFicha, writeFicha, normalize, slidesText, OPCIONES } = require('./ficha');

const ROOT = __dirname;
const CONCURRENCY = Number(process.env.AI_CONCURRENCY) || 3;
const MAX_SLIDES = 30;
const jobs = new Map();

const titleOf = (html) => ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
const templateOf = (html) => (html.match(/<meta name="deck-template" content="([^"]*)"/i) || [])[1] || '';
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ───────── índice de slides reutilizables ───────── */
async function slideLibrary() {
  const decks = [];
  for (const dir of ['plantillas', 'presentaciones']) {
    const files = (await fsp.readdir(path.join(ROOT, dir))).filter((f) => f.endsWith('.html'));
    for (const f of files) {
      const html = await fsp.readFile(path.join(ROOT, dir, f), 'utf8');
      decks.push({ path: `${dir}/${f}`, title: titleOf(html) || f, kind: dir === 'plantillas' ? 'plantilla' : 'presentación', html, ficha: readFicha(html) });
    }
  }
  const slides = [];
  for (const d of decks) {
    const sections = d.html.match(/<section class="slide[\s\S]*?<\/section>/gi) || [];
    const texts = slidesText(d.html);
    sections.forEach((html, i) => {
      if (/data-oculta/.test(html.slice(0, 200))) return;
      const layout = (html.match(/data-layout="([^"]*)"/) || [])[1] || '';
      const t = texts[i] || { titulo: '', texto: '' };
      const fotos = (html.match(/class="[^"]*\bfoto\b/g) || []).length;
      slides.push({ id: `s${slides.length + 1}`, deck: d, n: i + 1, layout, titulo: t.titulo, texto: t.texto, html, fotos });
    });
  }
  return { decks, slides };
}

function libraryIndex({ decks, slides }) {
  return decks.map((d) => {
    const own = slides.filter((s) => s.deck === d);
    if (!own.length) return '';
    const f = d.ficha;
    const head = `## ${d.title} — ${d.kind} (${d.path})${f.tipo ? ' · ' + f.tipo : ''}${f.cliente ? ' · cliente ' + f.cliente : ''}${f.forma ? '\nForma: ' + f.forma : ''}`;
    const rows = own.map((s) => `- ${s.id} [${s.layout}]${s.fotos ? ` (${s.fotos} foto${s.fotos > 1 ? 's' : ''})` : ''} ${s.titulo ? s.titulo + ' — ' : ''}${s.texto.slice(0, 170)}`);
    return head + '\n' + rows.join('\n');
  }).filter(Boolean).join('\n\n');
}

/* ───────── 1) planificar ───────── */
async function plan({ brief, data, files, base, largo, lib, web }) {
  const bases = lib.decks.filter((d) => d.kind === 'plantilla').map((d) => `${d.path} (${d.title})`).join('; ');
  const system = `Eres el director de presentaciones de Almabrands (consultora chilena de marca, propósito, investigación y cultura). Diseñas la ESTRUCTURA de una presentación nueva reutilizando slides de una biblioteca existente, para que la gráfica sea coherente con el sistema de la marca.

Responde SOLO un objeto JSON, sin texto adicional:
{
 "titulo": "título de la presentación",
 "base": "ruta de la presentación cuyo tema visual se usará (ej. ${lib.decks.find((d) => d.kind === 'plantilla')?.path || 'plantillas/x.html'})",
 "estructura": "2-3 frases explicando el hilo de la presentación",
 "ficha": {"cliente": "", "tipo": uno de ${JSON.stringify(OPCIONES.tipo)}, "rubros": [], "segmentos": [], "servicios": [subconjunto de ${JSON.stringify(OPCIONES.servicios)}], "estudios": [], "productos": [], "etiquetas": [], "fondo": "4-6 líneas", "forma": "2-3 líneas"},
 "slides": [{"origen": "sN", "accion": "reusar" | "adaptar", "proposito": "rol de la slide en el relato (corto)", "instrucciones": "qué contenido concreto debe llevar", "usa_adjuntos": true|false, "imagenes": [números de las imágenes adjuntas que se insertan en esta slide]${web ? ', "fotos_web": [{"url": "URL de una foto real encontrada en internet", "desc": "qué muestra · fuente"}]' : ''}}]${web ? ',\n "investigacion": "hallazgos verificados en internet que deben usar las slides: datos, cifras, hechos, productos, contexto de mercado, cada uno con su fuente (dominio). Máximo ~40 líneas."' : ''}
}

Reglas de estructura:
- Arma un relato completo y ordenado: portada → (contenidos opcional) → secciones con su separador → contenido → cierre/contacto. Numera los separadores en orden (01., 02., …) en las instrucciones.
- CADA slide debe tener un "origen" de la biblioteca: es su molde gráfico (tipo de slide, composición, componentes). Elige el origen cuyo layout mejor sirva al contenido (cifras → slide de cifras/KPIs; proceso → etapas; tiempos → gantt; equipo → equipo/perfiles; etc.). Puedes usar el mismo origen varias veces.
- Coherencia visual: privilegia slides de la presentación base. Toma slides de otras presentaciones solo cuando aporten contenido relevante (credenciales, clientes, casos, metodologías, equipo) o un tipo de slide que la base no tenga.
- "reusar" solo si la slide sirve tal cual (ej. credenciales, clientes, cómo lo hacemos, contacto). En todo lo demás usa "adaptar" con instrucciones concretas y específicas al brief.
- Instrucciones: indica títulos, mensajes y datos a usar (del brief, datos y adjuntos). No inventes cifras ni nombres; si faltan, pide marcadores [cifra], [nombre].
- usa_adjuntos: true solo en las slides que necesitan leer o insertar los archivos adjuntos.
- imagenes: si hay imágenes adjuntas (incluidas las fotos extraídas de los PDF), distribuye las pertinentes en las slides donde aporten (portada, contexto, producto, personas, casos, logos del cliente), usando su número de la lista de adjuntos. Para esas slides elige orígenes que tengan fotos (indicado como "(n fotos)" en la biblioteca) y usa "adaptar". No repitas la misma imagen en varias slides salvo que tenga sentido. Omite imágenes irrelevantes (íconos, pies de página).
- Largo: ${largo ? `OBLIGATORIO entre ${largo - 1} y ${largo + 1} slides en total, contando portada, separadores, credenciales y cierre. Para respetarlo, consolida contenidos, usa menos separadores y elige solo las credenciales más relevantes.` : 'el que pida el brief (típicamente 10-16)'}; máximo ${MAX_SLIDES}.
- base: ${base ? `usa exactamente "${base}"` : `elige la más adecuada entre: ${bases}`}.
- Español de Chile.${web ? `

# Búsqueda en internet (activada)
- Antes de planificar, investiga en internet sobre el cliente, su marca, productos, mercado y contexto (sitio oficial, prensa, redes, fuentes confiables). Resume lo verificado en "investigacion" con sus fuentes y úsalo en las instrucciones de cada slide en lugar de marcadores.
- fotos_web: para las slides que lleven fotos, propone fotos reales encontradas en las páginas que consultaste (pide explícitamente las URLs de sus imágenes: og:image y <img src>). Usa la URL directa del archivo de imagen o, si no la tienes, la de la página (el sistema toma su imagen principal). Nunca inventes URLs. Elige para esas slides orígenes con fotos.
- Tu respuesta final sigue siendo SOLO el objeto JSON.` : ''}

# Guía de marca (respétala en estructura, tono y contenidos)
${await require('./estilo').guiaMarca()}`;
  const att = ai.attachmentBlocks(files);
  const text = `# Biblioteca de slides disponibles\n\n${libraryIndex(lib)}\n\n---\n# Brief\n${brief.trim()}` +
    (data ? `\n\n# Datos aportados\n${data.slice(0, 40000)}` : '') +
    (att.notes.length ? `\n\n# Archivos adjuntos (van antes de este mensaje)\n${att.notes.join('\n')}` : '');
  const r = await ai.complete({ system, content: [...att.blocks, { type: 'text', text }], web });
  const j = ai.extractJson(r.text);
  const byId = new Map(lib.slides.map((s) => [s.id, s]));
  const items = (Array.isArray(j.slides) ? j.slides : [])
    .map((x) => ({ ...x, src: byId.get(String(x.origen || '').trim()) }))
    .filter((x) => x.src)
    .slice(0, MAX_SLIDES)
    .map((x) => {
      const imagenes = (Array.isArray(x.imagenes) ? x.imagenes : []).map((n) => Math.round(+n) - 1).filter((n) => n >= 0 && n < (files || []).length && /^image\//.test(files[n].type));
      const fotosWeb = (Array.isArray(x.fotos_web) ? x.fotos_web : []).filter((f) => f && /^https?:\/\//.test(f.url)).slice(0, 4).map((f) => ({ url: String(f.url), desc: String(f.desc || '') }));
      return { src: x.src, accion: x.accion === 'reusar' && !imagenes.length && !fotosWeb.length ? 'reusar' : 'adaptar', proposito: String(x.proposito || ''), instrucciones: String(x.instrucciones || ''), usa_adjuntos: !!x.usa_adjuntos, imagenes, fotosWeb };
    });
  if (!items.length) throw new Error('La IA no logró armar una estructura válida. Precisa el brief e intenta de nuevo.');
  const baseDeck = lib.decks.find((d) => d.path === (base || j.base)) || lib.decks.find((d) => d.kind === 'plantilla');
  return { titulo: String(j.titulo || 'Nueva presentación'), estructura: String(j.estructura || ''), ficha: j.ficha || {}, base: baseDeck, items, investigacion: String(j.investigacion || '') };
}

/* ───────── 2) adaptar cada slide ───────── */
async function adapt({ item, idx, total, system, brief, data, files, outline, investigacion }) {
  const { out: clean, imgs } = ai.stripImages(item.src.html.replace(/\sdata-oculta(="[^"]*")?/, ''));
  const elegidas = item.imagenes.filter((n) => files[n]);
  // con usa_adjuntos van todos los adjuntos; si no, solo las imágenes asignadas a esta slide
  const att = item.usa_adjuntos ? ai.attachmentBlocks(files)
    : elegidas.length ? ai.attachmentBlocks(files, { only: new Set(elegidas) }) : { blocks: [], notes: [] };
  const text = `Estás construyendo la slide ${idx + 1} de ${total} de una presentación nueva.

# Brief de la presentación
${brief.trim()}

# Estructura completa (para mantener coherencia de relato y numeración)
${outline}
${data ? `\n# Datos aportados (fuente; no inventes otros)\n${data.slice(0, 20000)}\n` : ''}${investigacion ? `\n# Investigación en internet (datos verificados; úsalos y cita las fuentes en una línea p-xs)\n${investigacion.slice(0, 12000)}\n` : ''}${att.notes.length ? `\n# Archivos adjuntos (van antes de este mensaje)\n${att.notes.join('\n')}\n` : ''}
# Slide de origen (MOLDE de diseño)
Conserva su tipo de slide, composición, clases, colores, logo/pie e imágenes de fondo; reemplaza el contenido según las instrucciones. Puedes agregar o quitar bloques repetibles (tarjetas, filas, ítems) si el contenido lo requiere, sin romper la composición.

${clean}

# Propósito de esta slide
${item.proposito}

# Instrucciones
${item.instrucciones}${elegidas.length ? `

# Imágenes para esta slide
Inserta estas imágenes adjuntas en slots .foto (reemplazando las fotos del molde o llenando sus slots vacíos; agrega "contain" a logos o gráficos): ${elegidas.map((n) => `data:ADJ_${n}`).join(', ')}.` : ''}${item.web && item.web.length ? `

# Fotos de internet para esta slide (ya descargadas)
Úsalas en slots .foto con background-image:url(…) copiando la URL tal cual (reemplazando las fotos del molde o llenando sus slots vacíos; "contain" para logos o productos recortados), y menciona la fuente en la línea de fuentes:
${item.web.map((f) => `- url(${f.media}) — ${f.desc}`).join('\n')}` : ''}`;
  const r = await ai.complete({ system, content: [...att.blocks, { type: 'text', text }] });
  return ai.restoreAttachments(ai.restoreImages(ai.extractSection(r.text), imgs), files);
}

async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

/* ───────── trabajo completo ───────── */
async function run(job, { brief, data, files, base, largo, titulo, web }) {
  const say = (t) => { job.pasos.push(t); job.t = Date.now(); };
  job.fase = 'planificando';
  if ((files || []).some((f) => f.type === 'application/pdf')) {
    say('Buscando fotos dentro de los PDF adjuntos…');
    const n0 = files.length;
    files = await imagenes.expandPdfImages(files);
    if (files.length > n0) say(`Extraje ${files.length - n0} imágenes de los PDF; Claude podrá usarlas en las slides.`);
  }
  say('Revisando la biblioteca de slides…');
  const lib = await slideLibrary();
  say(`Biblioteca: ${lib.slides.length} slides de ${lib.decks.length} presentaciones y plantillas. Claude está ${web ? 'investigando en internet y ' : ''}diseñando la estructura…`);
  const p = await plan({ brief, data, files, base, largo, lib, web });
  if (web) {
    // descarga las fotos propuestas (una vez cada URL) al banco media/
    const urls = [...new Set(p.items.flatMap((it) => it.fotosWeb.map((f) => f.url)))].slice(0, 24);
    const got = new Map();
    if (urls.length) say(`Descargando ${urls.length} fotos encontradas en internet…`);
    await Promise.all(urls.map((u) => imagenes.fetchImage(u).then((m) => got.set(u, m)).catch((e) => console.log(`Foto web no descargada (${e.message}): ${u}`))));
    for (const it of p.items) it.web = it.fotosWeb.filter((f) => got.has(f.url)).map((f) => ({ ...f, media: got.get(f.url) }));
    if (urls.length) say(`${got.size} de ${urls.length} fotos descargadas.`);
    if (p.investigacion) say('Investigación lista: las slides usarán esos datos con sus fuentes.');
  }
  job.titulo = titulo || p.titulo;
  job.estructura = p.estructura;
  job.base = p.base.path;
  job.slides = p.items.map((it) => ({ proposito: it.proposito, accion: it.accion, origen: `${it.src.deck.title} · slide ${it.src.n}`, estado: it.accion === 'reusar' ? 'listo' : 'pendiente' }));
  job.total = p.items.length;
  say(`Estructura lista: ${p.items.length} slides sobre la base “${p.base.title}”.`);

  const today = new Date().toISOString().slice(0, 10);
  const ficha = normalize({ ...p.ficha, estado: 'Borrador', fecha: today, plantilla: templateOf(p.base.html) });
  const baseHtml = writeFicha(p.base.html, ficha);
  const system = await ai.buildSystem(baseHtml);
  const outline = p.items.map((it, k) => `${k + 1}. ${it.proposito}`).join('\n');

  job.fase = 'generando';
  const out = new Array(p.items.length);
  const toAdapt = [];
  p.items.forEach((it, k) => { if (it.accion === 'reusar') out[k] = it.src.html.replace(/\sdata-oculta(="[^"]*")?/, ''); else toAdapt.push(k); });
  job.hechas = p.items.length - toAdapt.length;
  say(`Generando ${toAdapt.length} slides (${CONCURRENCY} en paralelo)…`);
  await pool(toAdapt, CONCURRENCY, async (k) => {
    job.slides[k].estado = 'generando';
    try {
      out[k] = await adapt({ item: p.items[k], idx: k, total: p.items.length, system, brief, data, files, outline, investigacion: p.investigacion });
      job.slides[k].estado = 'listo';
    } catch (e) {
      out[k] = p.items[k].src.html;
      job.slides[k].estado = 'error';
      say(`Slide ${k + 1}: no se pudo adaptar (${e.message}); quedó la slide de origen para editar a mano.`);
    }
    job.hechas++;
  });

  job.fase = 'armando';
  say('Armando la presentación…');
  let html = baseHtml.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(job.titulo)}</title>`);
  html = html.replace(/<main class="deck">[\s\S]*<\/main>/i, `<main class="deck">\n\n${out.join('\n\n')}\n\n</main>`);
  const slug = String(job.titulo).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'presentacion';
  let name = `${slug}.html`, n = 2;
  while (fs.existsSync(path.join(ROOT, 'presentaciones', name))) name = `${slug}-${n++}.html`;
  await fsp.writeFile(path.join(ROOT, 'presentaciones', name), imagenes.externalize(html));
  job.path = `presentaciones/${name}`;
  job.fase = 'listo';
  say('¡Presentación lista!');
}

function start(params) {
  if (!params.brief || !String(params.brief).trim()) throw new Error('Describe la presentación que quieres crear.');
  ai.attachmentBlocks(params.files); // valida adjuntos antes de partir
  const id = crypto.randomBytes(6).toString('hex');
  const job = { id, fase: 'en cola', pasos: [], slides: [], total: 0, hechas: 0, inicio: Date.now(), t: Date.now() };
  jobs.set(id, job);
  run(job, params).catch((e) => { job.fase = 'error'; job.error = e.message; job.pasos.push('Error: ' + e.message); });
  // limpieza de trabajos viejos
  for (const [k, j] of jobs) if (Date.now() - j.inicio > 6 * 3600e3) jobs.delete(k);
  return { id };
}

function get(id) {
  const j = jobs.get(id);
  if (!j) { const e = new Error('Trabajo no encontrado (¿se reinició el servidor?)'); e.status = 404; throw e; }
  return j;
}

module.exports = { start, get };
