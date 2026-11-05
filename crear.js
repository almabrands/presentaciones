// Crear una presentación completa con IA reutilizando slides existentes.
// El navegador orquesta pasos cortos (funciona igual en local y en Vercel: sin trabajos en memoria ni disco):
// 1) planStep  — Claude recibe el brief, los adjuntos y un índice de TODAS las slides (plantillas y
//    presentaciones) y arma la estructura eligiendo, para cada slide, una slide de origen que se
//    reusa tal cual o se adapta. Así la gráfica siempre sale de diseños existentes.
// 2) slideStep — cada slide a adaptar se reescribe usando su origen como molde (el navegador las pide en paralelo).
// 3) saveStep  — se monta todo sobre el tema de la presentación base, con su ficha, y se guarda (storage).
// Los adjuntos de imagen llegan ya subidos al banco media/ ({media}); los PDF, embebidos o como texto.
const ai = require('./ai');
const imagenes = require('./imagenes');
const storage = require('./storage');
const { readFicha, writeFicha, normalize, slidesText, OPCIONES } = require('./ficha');

const MAX_SLIDES = 30;
const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

const titleOf = (html) => ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
const templateOf = (html) => (html.match(/<meta name="deck-template" content="([^"]*)"/i) || [])[1] || '';
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ───────── índice de slides reutilizables ───────── */
async function slideLibrary() {
  const decks = [];
  for (const dir of ['plantillas', 'presentaciones']) {
    for (const d of await storage.listDeckDetails(dir)) {
      const html = await storage.readDeck(d.path).catch(() => '');
      if (html) decks.push({ path: d.path, title: titleOf(html) || d.file, kind: dir === 'plantillas' ? 'plantilla' : 'presentación', html, ficha: readFicha(html) });
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

// slide n (1-based, visible o no) de una presentación guardada
async function sourceSlide(rel, n) {
  const html = await storage.readDeck(storage.validatePath(rel));
  const sec = (html.match(/<section class="slide[\s\S]*?<\/section>/gi) || [])[+n - 1];
  if (!sec) throw fail(`No encontré la slide ${n} de ${rel}`);
  return { deckHtml: html, html: sec.replace(/\sdata-oculta(="[^"]*")?/, '') };
}

async function baseWithFicha(basePath, ficha) {
  const html = await storage.readDeck(storage.validatePath(basePath));
  const today = new Date().toISOString().slice(0, 10);
  return writeFicha(html, normalize({ ...(ficha || {}), estado: 'Borrador', fecha: today, plantilla: templateOf(html) }));
}

/* ───────── paso 1: plan ───────── */
async function planStep({ brief, data, files, base, largo, web }) {
  if (!brief || !String(brief).trim()) throw fail('Describe la presentación que quieres crear.');
  ai.attachmentBlocks(files); // valida
  files = await ai.hydrateFiles(files);
  const lib = await slideLibrary();
  if (!lib.slides.length) throw new Error('No hay plantillas ni presentaciones para usar como molde. Importa una plantilla primero.');
  const p = await plan({ brief: String(brief), data: data ? String(data) : '', files, base, largo: +largo || 0, lib, web: !!web });
  return {
    titulo: p.titulo, estructura: p.estructura, ficha: p.ficha, investigacion: p.investigacion,
    base: { path: p.base.path, title: p.base.title },
    biblioteca: { slides: lib.slides.length, decks: lib.decks.length },
    items: p.items.map((it) => ({
      src: { path: it.src.deck.path, n: it.src.n, title: it.src.deck.title },
      accion: it.accion, proposito: it.proposito, instrucciones: it.instrucciones, usa_adjuntos: it.usa_adjuntos,
      imagenes: it.imagenes, fotosWeb: it.fotosWeb,
    })),
  };
}

// fotos de internet propuestas por el plan → banco media/ ({url: "../media/…"} o null)
async function photosStep({ urls }) {
  urls = [...new Set((Array.isArray(urls) ? urls : []).map(String).filter((u) => /^https?:\/\//.test(u)))].slice(0, 24);
  const out = {};
  await Promise.all(urls.map((u) => imagenes.fetchImage(u).then((m) => { out[u] = m; }).catch((e) => { out[u] = null; console.log(`Foto web no descargada (${e.message}): ${u}`); })));
  return { fotos: out };
}

/* ───────── paso 2: una slide ───────── */
async function slideStep({ item, idx, total, brief, data, files, outline, investigacion, base, ficha }) {
  if (!item || !item.src) throw fail('Falta la slide de origen.');
  const src = await sourceSlide(item.src.path, item.src.n);
  const system = await ai.buildSystem(await baseWithFicha(base, ficha));
  files = Array.isArray(files) ? files : [];
  // solo se descargan del banco las imágenes que esta slide usa
  files = await ai.hydrateFiles(files, item.usa_adjuntos ? null : new Set((item.imagenes || []).map(Number)));
  const it = {
    src: { html: src.html }, proposito: String(item.proposito || ''), instrucciones: String(item.instrucciones || ''), usa_adjuntos: !!item.usa_adjuntos,
    imagenes: (Array.isArray(item.imagenes) ? item.imagenes : []).map(Number).filter((n) => Number.isInteger(n) && files[n]),
    web: (Array.isArray(item.web) ? item.web : []).filter((f) => f && /^\.\.\/media\/[a-f0-9]{16}\.[a-z]+$/.test(f.media)).map((f) => ({ media: f.media, desc: String(f.desc || '') })),
  };
  const html = await adapt({ item: it, idx: +idx || 0, total: +total || 1, system, brief: String(brief || ''), data: data ? String(data) : '', files, outline: String(outline || ''), investigacion: String(investigacion || '') });
  return { html };
}

/* ───────── paso 3: armar y guardar ───────── */
// slides: [{html}] (adaptada) o [{src:{path,n}}] (reusada tal cual, o de respaldo si falló)
async function saveStep({ titulo, base, ficha, slides }) {
  if (!Array.isArray(slides) || !slides.length) throw fail('No hay slides para guardar.');
  const out = [];
  for (const s of slides.slice(0, MAX_SLIDES)) {
    if (s && typeof s.html === 'string' && /<section class="slide/.test(s.html)) out.push(s.html);
    else if (s && s.src) out.push((await sourceSlide(s.src.path, s.src.n)).html);
  }
  if (!out.length) throw fail('No hay slides válidas para guardar.');
  const title = String(titulo || 'Nueva presentación').trim().slice(0, 140);
  let html = (await baseWithFicha(base, ficha)).replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  html = html.replace(/<main class="deck">[\s\S]*<\/main>/i, () => `<main class="deck">\n\n${out.join('\n\n')}\n\n</main>`);
  const slug = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'presentacion';
  const name = await storage.uniqueName('presentaciones', slug);
  await storage.writeDeck(`presentaciones/${name}`, await imagenes.externalizeAsync(html), { backup: false });
  return { path: `presentaciones/${name}` };
}

module.exports = { planStep, photosStep, slideStep, saveStep };
