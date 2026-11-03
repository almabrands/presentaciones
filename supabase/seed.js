#!/usr/bin/env node
// Seed inicial: importa las plantillas locales a Supabase.
// Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node supabase/seed.js
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ROOT = path.join(__dirname, '..');
const { readFicha, slidesText } = require(path.join(ROOT, 'ficha'));

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const titleOf = (html) => ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
const templateOf = (html) => (html.match(/<meta name="deck-template" content="([^"]*)"/i) || [])[1] || '';
const countSlides = (html) => (html.match(/<section class="slide/g) || []).length;

async function seedDir(dir) {
  const dirPath = path.join(ROOT, dir);
  if (!fs.existsSync(dirPath)) return;
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.html'));
  console.log(`\n${dir}: ${files.length} archivos`);
  for (const filename of files) {
    const html = fs.readFileSync(path.join(dirPath, filename), 'utf8');
    const title = titleOf(html) || filename;
    const template = templateOf(html);
    const slides_count = countSlides(html);
    const ficha = readFicha(html);
    const outline = slidesText(html).map((s) => s.titulo).filter(Boolean).slice(0, 40);
    const byte_size = Buffer.byteLength(html, 'utf8');
    const mtime = fs.statSync(path.join(dirPath, filename)).mtimeMs;

    const { error } = await sb.from('decks').upsert(
      { dir, filename, html, title, template, slides_count, ficha, outline, byte_size, mtime },
      { onConflict: 'dir,filename' }
    );
    if (error) console.error(`  ✗ ${filename}: ${error.message}`);
    else console.log(`  ✓ ${filename} (${slides_count} slides, ${Math.round(byte_size / 1024)} KB)`);
  }
}

async function seedMedia() {
  const mediaPath = path.join(ROOT, 'media');
  if (!fs.existsSync(mediaPath)) return;
  const files = fs.readdirSync(mediaPath);
  if (!files.length) return;
  console.log(`\nmedia: ${files.length} archivos`);
  for (const f of files) {
    const buf = fs.readFileSync(path.join(mediaPath, f));
    const mime = f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const { error } = await sb.storage.from('media').upload(f, buf, { upsert: false, contentType: mime });
    if (error && !error.message?.includes('already') && error.statusCode !== '409')
      console.error(`  ✗ ${f}: ${error.message}`);
    else console.log(`  ✓ ${f}`);
  }
}

(async () => {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.');
    process.exit(1);
  }
  await seedDir('plantillas');
  await seedDir('presentaciones');
  await seedMedia();
  console.log('\n✓ Seed completado');
})();
