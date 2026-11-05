// storage.js — capa de abstracción: local (archivos) o Supabase (producción).
// Modo: se activa Supabase cuando existe SUPABASE_URL en el entorno.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = __dirname;
const HISTORY_KEEP = 25;
const DIRS = ['plantillas', 'presentaciones'];

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const mode = SUPABASE_URL ? 'supabase' : 'local';

let _sb;
function sb() {
  if (!_sb) {
    const { createClient } = require('@supabase/supabase-js');
    _sb = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return _sb;
}

// ── Helpers HTML ──
const titleOf = (html) => ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
const templateOf = (html) => (html.match(/<meta name="deck-template" content="([^"]*)"/i) || [])[1] || '';
const countSlides = (html) => (html.match(/<section class="slide/g) || []).length;

function splitRel(relPath) {
  const i = relPath.indexOf('/');
  return [relPath.slice(0, i), relPath.slice(i + 1)];
}

function validatePath(rel) {
  if (typeof rel !== 'string') throw Object.assign(new Error('ruta inválida'), { status: 400 });
  rel = decodeURIComponent(rel).replace(/^\/+/, '');
  const parts = rel.split('/');
  if (parts.length !== 2 || !DIRS.includes(parts[0]) || !parts[1].endsWith('.html') || parts[1].includes('..'))
    throw Object.assign(new Error('ruta no permitida: ' + rel), { status: 400 });
  return rel;
}

// ── Exists ──
async function deckExists(relPath) {
  if (mode === 'local') return fs.existsSync(path.join(ROOT, relPath));
  const [dir, filename] = splitRel(relPath);
  const { data } = await sb().from('decks').select('id').eq('dir', dir).eq('filename', filename).maybeSingle();
  return !!data;
}

// ── Unique filename ──
async function uniqueName(dir, base) {
  let name = base + '.html', i = 2;
  while (await deckExists(`${dir}/${name}`)) name = `${base}-${i++}.html`;
  return name;
}

// ── Backup ──
async function backupDeck(relPath) {
  if (!(await deckExists(relPath))) return;
  if (mode === 'local') {
    const abs = path.join(ROOT, relPath);
    const hdir = path.join(path.dirname(abs), '.historial');
    await fsp.mkdir(hdir, { recursive: true });
    const base = path.basename(abs, '.html');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(abs, path.join(hdir, `${base}__${stamp}.html`));
    const old = (await fsp.readdir(hdir)).filter((f) => f.startsWith(base + '__')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) await fsp.unlink(path.join(hdir, f));
  } else {
    const [dir, filename] = splitRel(relPath);
    const html = await readDeck(relPath);
    await sb().from('deck_versions').insert({ dir, filename, html });
    const { data } = await sb().from('deck_versions').select('id').eq('dir', dir).eq('filename', filename).order('created_at', { ascending: false });
    if (data && data.length > HISTORY_KEEP) {
      const old = data.slice(HISTORY_KEEP).map((r) => r.id);
      await sb().from('deck_versions').delete().in('id', old);
    }
  }
}

// ── Read ──
async function readDeck(relPath) {
  if (mode === 'local') return fsp.readFile(path.join(ROOT, relPath), 'utf8');
  const [dir, filename] = splitRel(relPath);
  const { data, error } = await sb().from('decks').select('html').eq('dir', dir).eq('filename', filename).single();
  if (error || !data) throw Object.assign(new Error('No encontrado'), { status: 404 });
  return data.html;
}

// ── Write (upsert + backup) ──
async function writeDeck(relPath, html, { backup: doBackup = true } = {}) {
  if (mode === 'local') {
    const abs = path.join(ROOT, relPath);
    if (doBackup) await backupDeck(relPath);
    await fsp.writeFile(abs, html);
    return (await fsp.stat(abs)).mtimeMs;
  }
  const [dir, filename] = splitRel(relPath);
  if (doBackup) await backupDeck(relPath);

  // Extrae metadatos para listado rápido
  const { readFicha, slidesText } = require('./ficha');
  const title = titleOf(html);
  const template = templateOf(html);
  const slides_count = countSlides(html);
  const ficha = readFicha(html);
  const outline = slidesText(html).map((s) => s.titulo).filter(Boolean).slice(0, 40);
  const byte_size = Buffer.byteLength(html, 'utf8');
  const mtime = Date.now();

  const { error } = await sb().from('decks').upsert(
    { dir, filename, html, title, template, slides_count, ficha, outline, byte_size, mtime },
    { onConflict: 'dir,filename' }
  );
  if (error) throw error;
  return mtime;
}

// ── Stat ──
async function statDeck(relPath) {
  if (mode === 'local') {
    const st = await fsp.stat(path.join(ROOT, relPath));
    return { mtime: st.mtimeMs };
  }
  const [dir, filename] = splitRel(relPath);
  const { data, error } = await sb().from('decks').select('mtime').eq('dir', dir).eq('filename', filename).single();
  if (error || !data) throw Object.assign(new Error('No encontrado'), { status: 404 });
  return { mtime: data.mtime };
}

// ── Delete (papelera) ──
async function deleteDeck(relPath) {
  if (mode === 'local') {
    const abs = path.join(ROOT, relPath);
    const [dir] = splitRel(relPath);
    const trash = path.join(ROOT, dir, '.papelera');
    await fsp.mkdir(trash, { recursive: true });
    await fsp.rename(abs, path.join(trash, `${Date.now()}__${path.basename(abs)}`));
    return;
  }
  const [dir, filename] = splitRel(relPath);
  const html = await readDeck(relPath);
  const { readFicha } = require('./ficha');
  await sb().from('deck_trash').insert({ dir, filename, html, ficha: readFicha(html) });
  await sb().from('decks').delete().eq('dir', dir).eq('filename', filename);
}

// ── List (con metadatos para el home) ──
async function listDeckDetails(dir) {
  if (mode === 'local') {
    const abs = path.join(ROOT, dir);
    await fsp.mkdir(abs, { recursive: true });
    const files = (await fsp.readdir(abs)).filter((f) => f.endsWith('.html'));
    const { readFicha, slidesText } = require('./ficha');
    const out = [];
    for (const f of files) {
      const p = path.join(abs, f);
      const [html, st] = await Promise.all([fsp.readFile(p, 'utf8'), fsp.stat(p)]);
      const outline = slidesText(html).map((s) => s.titulo).filter(Boolean).slice(0, 40);
      out.push({
        path: `${dir}/${f}`, file: f,
        title: titleOf(html) || f, template: templateOf(html),
        slides: countSlides(html), mtime: st.mtimeMs, size: st.size,
        ficha: readFicha(html), outline,
      });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }
  const { data, error } = await sb().from('decks')
    .select('dir,filename,title,template,slides_count,ficha,outline,byte_size,mtime')
    .eq('dir', dir).order('mtime', { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    path: `${r.dir}/${r.filename}`, file: r.filename,
    title: r.title || r.filename, template: r.template || '',
    slides: r.slides_count, mtime: r.mtime, size: r.byte_size,
    ficha: r.ficha || {}, outline: r.outline || [],
  }));
}

// ── Media ──
async function writeMedia(name, buffer) {
  if (mode === 'local') {
    const abs = path.join(ROOT, 'media', name);
    if (!fs.existsSync(abs)) {
      await fsp.mkdir(path.join(ROOT, 'media'), { recursive: true });
      await fsp.writeFile(abs, buffer);
    }
    return;
  }
  const ext = name.split('.').pop().toLowerCase();
  const contentType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' }[ext] || 'application/octet-stream';
  const { error } = await sb().storage.from('media').upload(name, buffer, { upsert: false, cacheControl: '31536000', contentType });
  // "already exists" is acceptable (same hash = same content)
  if (error && !error.message?.includes('already') && error.statusCode !== '409') throw error;
}

function mediaPublicUrl(name) {
  if (mode === 'local') return null;
  const { data } = sb().storage.from('media').getPublicUrl(name);
  return data.publicUrl;
}

// Reemplaza '../media/' por la URL pública de Supabase Storage al servir HTML
function rewriteMediaUrls(html) {
  if (mode === 'local') return html;
  const base = SUPABASE_URL.replace(/\/$/, '') + '/storage/v1/object/public/media/';
  return html.replace(/\.\.\/media\//g, base);
}

module.exports = {
  mode, validatePath, deckExists, uniqueName,
  readDeck, writeDeck, statDeck, deleteDeck, listDeckDetails,
  writeMedia, mediaPublicUrl, rewriteMediaUrls,
};
