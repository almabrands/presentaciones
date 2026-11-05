// Servidor Almabrands Presentaciones.
// Local: node server.js  →  http://localhost:5177
// Vercel: exporta el Express app (ver api/index.js y vercel.json)
const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

// .env opcional — no pisa variables ya definidas
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const ai = require('./ai');
const crear = require('./crear');
const plantilla = require('./plantilla');
const estilo = require('./estilo');
const imagenes = require('./imagenes');
const storage = require('./storage');
const { readFicha, writeFicha, slidesText, OPCIONES } = require('./ficha');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5177;
const DIRS = ['plantillas', 'presentaciones'];

const slugify = (s) =>
  String(s || 'presentacion').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'presentacion';

const titleOf = (html) => ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Servidor Express ──
const app = express();
app.use(express.json({ limit: '200mb' }));

// Archivos estáticos (local: desde disco; Vercel: CDN sirve core/ y plantillas/ del repo)
app.use('/core', express.static(path.join(ROOT, 'core'), { maxAge: 0 }));
app.use('/plantillas', express.static(path.join(ROOT, 'plantillas'), { maxAge: 0 }));
if (storage.mode === 'local') {
  app.use('/media', express.static(path.join(ROOT, 'media'), { maxAge: 0 }));
  app.use('/presentaciones', express.static(path.join(ROOT, 'presentaciones'), { maxAge: 0 }));
}
app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));

// ── Config pública para el frontend ──
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    allowedEmails: (process.env.ALLOWED_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean),
  });
});

// ── Presentaciones desde Supabase (solo modo supabase) ──
app.get('/presentaciones/:file', async (req, res, next) => {
  if (storage.mode === 'local') return next();
  try {
    const relPath = storage.validatePath(`presentaciones/${req.params.file}`);
    const html = storage.rewriteMediaUrls(await storage.readDeck(relPath));
    res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(html);
  } catch (e) { next(e); }
});

// ── Media desde Supabase Storage (solo modo supabase) ──
app.get('/media/:file', (req, res, next) => {
  if (storage.mode === 'local') return next();
  const url = storage.mediaPublicUrl(req.params.file);
  if (!url) return res.status(404).send('Not found');
  res.redirect(301, url);
});

// ── API ──

app.get('/api/list', async (req, res, next) => {
  try {
    const [plantillas, presentaciones] = await Promise.all([
      storage.listDeckDetails('plantillas'),
      storage.listDeckDetails('presentaciones'),
    ]);
    res.json({ plantillas, presentaciones, chrome: false, opciones: OPCIONES });
  } catch (e) { next(e); }
});

app.get('/api/stat', async (req, res, next) => {
  try {
    const relPath = storage.validatePath(req.query.path);
    res.json(await storage.statDeck(relPath));
  } catch (e) { next(e); }
});

app.post('/api/new', async (req, res, next) => {
  try {
    const b = req.body;
    const srcRel = storage.validatePath(b.from);
    let html = await storage.readDeck(srcRel);
    const title = (b.title || '').trim() || titleOf(html);
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
    const src0 = readFicha(html);
    const today = new Date().toISOString().slice(0, 10);
    const fromTemplate = b.from.startsWith('plantillas/');
    const tmpl = (html.match(/<meta name="deck-template" content="([^"]*)"/i) || [])[1] || '';
    html = writeFicha(html, fromTemplate
      ? { plantilla: tmpl, forma: src0.forma, estado: 'Borrador', fecha: today }
      : { ...src0, estado: 'Borrador', fecha: today });
    const name = await storage.uniqueName('presentaciones', slugify(title));
    await storage.writeDeck(`presentaciones/${name}`, await imagenes.externalizeAsync(html), { backup: false });
    res.json({ path: `presentaciones/${name}` });
  } catch (e) { next(e); }
});

app.post('/api/save', async (req, res, next) => {
  try {
    const b = req.body;
    const relPath = storage.validatePath(b.path);
    if (b.baseMtime) {
      const { mtime } = await storage.statDeck(relPath).catch(() => ({ mtime: 0 }));
      if (mtime && Math.abs(mtime - b.baseMtime) > 1 && !b.force) {
        return res.status(409).json({ error: 'El archivo fue modificado fuera del editor.' });
      }
    }
    if (typeof b.html !== 'string' || !b.html.includes('class="deck"')) {
      return res.status(400).json({ error: 'HTML inválido' });
    }
    const mtime = await storage.writeDeck(relPath, await imagenes.externalizeAsync(b.html));
    res.json({ ok: true, mtime });
  } catch (e) { next(e); }
});

app.post('/api/delete', async (req, res, next) => {
  try {
    await storage.deleteDeck(storage.validatePath(req.body.path));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/rename', async (req, res, next) => {
  try {
    const b = req.body;
    const relPath = storage.validatePath(b.path);
    let html = await storage.readDeck(relPath);
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(b.title)}</title>`);
    await storage.writeDeck(relPath, html);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/ficha', async (req, res, next) => {
  try {
    const b = req.body;
    const relPath = storage.validatePath(b.path);
    let html = await storage.readDeck(relPath);
    await storage.writeDeck(relPath, writeFicha(html, b.ficha || {}));
    html = await storage.readDeck(relPath);
    res.json({ ok: true, ficha: readFicha(html) });
  } catch (e) { next(e); }
});

app.post('/api/ficha/ai', async (req, res, next) => {
  try {
    const b = req.body;
    const html = await storage.readDeck(storage.validatePath(b.path));
    const ficha = await ai.suggestFicha({ title: titleOf(html), slides: slidesText(html), ficha: b.ficha || readFicha(html) });
    res.json({ ficha });
  } catch (e) { next(e); }
});

app.post('/api/buscar', async (req, res, next) => {
  try {
    const [pr, pl] = await Promise.all([
      storage.listDeckDetails('presentaciones'),
      storage.listDeckDetails('plantillas'),
    ]);
    const r = await ai.searchDecks({ query: req.body.query, decks: [...pr, ...pl] });
    console.log(`Búsqueda IA: "${String(req.body.query).slice(0, 60)}" → ${r.resultados.length} resultados`);
    res.json(r);
  } catch (e) { next(e); }
});

// Crear presentación con IA: el navegador orquesta pasos cortos (core/crear-ia.js)
app.post('/api/crear/plan', async (req, res, next) => {
  try {
    const b = req.body;
    console.log(`Crear con IA: "${String(b.brief).slice(0, 60)}" → plan`);
    res.json(await crear.planStep({ brief: b.brief, data: b.data, files: b.files, base: b.base || '', largo: +b.largo || 0, web: !!b.web }));
  } catch (e) { next(e); }
});
app.post('/api/crear/fotos', async (req, res, next) => {
  try { res.json(await crear.photosStep(req.body)); } catch (e) { next(e); }
});
app.post('/api/crear/slide', async (req, res, next) => {
  try { res.json(await crear.slideStep(req.body)); } catch (e) { next(e); }
});
app.post('/api/crear/guardar', async (req, res, next) => {
  try { res.json(await crear.saveStep(req.body)); } catch (e) { next(e); }
});

// Importar plantilla: el navegador (core/pdf-import.js) orquesta pasos cortos (cada request < 4,5 MB para Vercel)
app.post('/api/plantillas/analizar', async (req, res, next) => {
  try {
    const b = req.body;
    console.log(`Importar plantilla: analizando ${(b.pages || []).length} páginas`);
    res.json(await plantilla.analyze({ pages: b.pages, nombre: (b.nombre || '').trim(), notas: (b.notas || '').trim() }));
  } catch (e) { next(e); }
});
app.post('/api/plantillas/replicar', async (req, res, next) => {
  try { res.json(await plantilla.replicate(req.body)); } catch (e) { next(e); }
});
app.post('/api/plantillas/guardar', async (req, res, next) => {
  try { res.json(await plantilla.save(req.body)); } catch (e) { next(e); }
});
app.post('/api/plantillas/html', async (req, res, next) => {
  try { res.json(await plantilla.importHtml(req.body)); } catch (e) { next(e); }
});

// Sube una imagen al banco media/ (nombre = hash del contenido) → { url: "../media/<hash>.<ext>" }
app.post('/api/media', async (req, res, next) => {
  try {
    const { type, data } = req.body || {};
    if (!/^image\/(jpeg|png|webp|gif)$/.test(type) || typeof data !== 'string' || !data) throw Object.assign(new Error('Imagen inválida'), { status: 400 });
    const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length < 100) throw Object.assign(new Error('Imagen inválida'), { status: 400 });
    res.json({ url: await imagenes.saveBufferAsync(buf, type) });
  } catch (e) { next(e); }
});
app.post('/api/plantillas/desde', async (req, res, next) => {
  try { res.json(await plantilla.desdePresentacion(req.body.path, req.body.titulo)); } catch (e) { next(e); }
});

app.get('/api/estilo', async (req, res, next) => {
  try { res.json(await estilo.get()); } catch (e) { next(e); }
});
app.post('/api/estilo', async (req, res, next) => {
  try {
    const b = req.body;
    if (b.colores) await estilo.setColores(b.colores);
    if (b.font) await estilo.setFuente(b.font);
    if (typeof b.guia === 'string') await estilo.setGuia(b.guia);
    for (const t of b.temas || []) await estilo.setTema(t.path, t.vars);
    if (b.logo) await estilo.setLogo(b.logo.cual, b.logo.data);
    res.json(await estilo.get());
  } catch (e) { next(e); }
});

app.get('/api/ai/status', async (req, res, next) => {
  try { res.json(await ai.status()); } catch (e) { next(e); }
});

app.post('/api/ai', async (req, res, next) => {
  try {
    const b = req.body;
    const relPath = storage.validatePath(b.path);
    // Leer el HTML aquí para no depender de un path absoluto en ai.js
    const deckHtml = await storage.readDeck(relPath).catch(() => '');
    const r = await ai.generateSlide({ deckHtml, slideHtml: b.slideHtml, prompt: b.prompt, mode: b.mode, data: b.data, files: b.files, web: !!b.web });
    console.log(`IA (${r.provider}${r.model ? ' · ' + r.model : ''}) → ${b.path} [${b.mode}]`);
    res.json(r);
  } catch (e) { next(e); }
});

// ── Error handler ──
app.use((err, req, res, _next) => {
  console.error(err.message);
  res.status(err.status || 400).json({ error: err.message });
});

// ── Arranque local ──
if (require.main === module) {
  for (const d of DIRS) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Presentaciones Almabrands → http://localhost:${PORT}\n  IA: ${ai.PROVIDER}\n`);
  });
}

module.exports = app;
