// Diseño & estilo: elementos transversales de todas las presentaciones.
// - Colores de marca y tipografía → variables en core/alma.css (afectan a todas las presentaciones)
// - Tema de cada plantilla (--accent, --accent2, --accent3) → <style> de cada plantilla
// - Logos → core/assets/logo-almabrands(.png|-blanco.png)
// - Guía de marca para la IA → core/marca.md (contexto de todo lo que genera Claude)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ROOT = __dirname;
const CSS = path.join(ROOT, 'core/alma.css');
const GUIA = path.join(ROOT, 'core/marca.md');
const ASSETS = path.join(ROOT, 'core/assets');

const COLORES = [
  ['--red', 'Rojo marca'], ['--purple', 'Morado'], ['--teal', 'Turquesa'], ['--mint', 'Menta (destacados)'],
  ['--lila', 'Lila'], ['--ink', 'Texto'], ['--gray', 'Texto secundario'],
];
const FUENTES = {
  'Poppins': 'ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,500;1,600;1,700',
  'Montserrat': 'ital,wght@0,300..900;1,300..900',
  'Raleway': 'ital,wght@0,300..900;1,300..900',
  'Work Sans': 'ital,wght@0,300..900;1,300..900',
  'DM Sans': 'ital,wght@0,300..900;1,300..900',
  'Rubik': 'ital,wght@0,300..900;1,300..900',
  'Nunito Sans': 'ital,wght@0,300..900;1,300..900',
  'Inter': 'wght@300..900',
  'Lato': 'ital,wght@0,300;0,400;0,700;0,900;1,400;1,700',
};
const LOGOS = { color: 'logo-almabrands.png', blanco: 'logo-almabrands-blanco.png' };
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const THEME_RE = /(<style>\s*\/\*[^\n]*\*\/\s*:root\{)([^}]*)(\})/;

async function backup(file) {
  const dir = path.join(path.dirname(file), '.historial');
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.copyFile(file, path.join(dir, `${path.basename(file)}__${stamp}`)).catch(() => {});
}

const rootBlock = (css) => css.match(/:root\{([\s\S]*?)\n\}/);
function readVar(css, name) {
  const m = rootBlock(css)[1].match(new RegExp(name.replace(/-/g, '\\-') + ':\\s*([^;]+);'));
  return m ? m[1].trim() : '';
}

function parseTheme(html) {
  const m = html.match(THEME_RE);
  const vars = {};
  if (m) for (const d of m[2].split(';')) { const [k, v] = d.split(':').map((s) => s && s.trim()); if (k && v) vars[k] = v; }
  return vars;
}

async function get() {
  const css = await fsp.readFile(CSS, 'utf8');
  const colores = COLORES.map(([k, label]) => ({ k, label, v: readVar(css, k) }));
  const font = (readVar(css, '--font').match(/^"([^"]+)"/) || [])[1] || 'Poppins';
  const guia = await fsp.readFile(GUIA, 'utf8').catch(() => '');
  const temas = [];
  for (const f of (await fsp.readdir(path.join(ROOT, 'plantillas'))).filter((x) => x.endsWith('.html'))) {
    const html = await fsp.readFile(path.join(ROOT, 'plantillas', f), 'utf8');
    temas.push({ path: `plantillas/${f}`, title: ((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || f).trim(), vars: parseTheme(html) });
  }
  const logos = {};
  for (const [k, f] of Object.entries(LOGOS)) logos[k] = { url: `/core/assets/${f}`, mtime: (await fsp.stat(path.join(ASSETS, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs };
  return { colores, font, fuentes: Object.keys(FUENTES), guia, temas, logos };
}

async function setColores(colores) {
  let css = await fsp.readFile(CSS, 'utf8');
  await backup(CSS);
  for (const [k, v] of Object.entries(colores || {})) {
    if (!COLORES.some((c) => c[0] === k) || !HEX.test(v)) continue;
    css = css.replace(new RegExp('(' + k.replace(/-/g, '\\-') + ':\\s*)[^;]+;'), `$1${v};`);
  }
  await fsp.writeFile(CSS, css);
}

async function setFuente(font) {
  if (!FUENTES[font]) throw new Error('Fuente no disponible');
  let css = await fsp.readFile(CSS, 'utf8');
  await backup(CSS);
  const fam = font.replace(/ /g, '+');
  css = css.replace(/@import url\('https:\/\/fonts\.googleapis\.com[^']*'\);/,
    `@import url('https://fonts.googleapis.com/css2?family=${fam}:${FUENTES[font]}&family=Caveat:wght@400;700&display=block');`);
  css = css.replace(/(--font:\s*)"[^"]+"/, `$1"${font}"`);
  await fsp.writeFile(CSS, css);
}

async function setTema(rel, vars) {
  const abs = path.resolve(ROOT, rel);
  if (path.relative(ROOT, path.dirname(abs)) !== 'plantillas' || !abs.endsWith('.html')) throw new Error('Ruta no permitida');
  const html = await fsp.readFile(abs, 'utf8');
  const cur = parseTheme(html);
  for (const k of ['--accent', '--accent2', '--accent3']) {
    const v = String(vars?.[k] || '').trim();
    if (HEX.test(v) || /^var\(--(red|purple|teal|mint|lila|ink|gray)\)$/.test(v)) cur[k] = v;
  }
  const body = Object.entries(cur).map(([k, v]) => `${k}:${v}`).join(';');
  if (!THEME_RE.test(html)) throw new Error('La plantilla no tiene bloque de tema');
  await fsp.writeFile(abs, html.replace(THEME_RE, `$1${body}$3`));
}

async function setGuia(text) {
  await backup(GUIA);
  await fsp.writeFile(GUIA, String(text || ''));
}

async function setLogo(cual, dataUrl) {
  const f = LOGOS[cual];
  if (!f) throw new Error('Logo desconocido');
  const m = String(dataUrl || '').match(/^data:image\/png;base64,(.+)$/);
  if (!m) throw new Error('El logo debe ser PNG (idealmente con fondo transparente)');
  const file = path.join(ASSETS, f);
  await backup(file);
  await fsp.writeFile(file, Buffer.from(m[1], 'base64'));
}

async function guiaMarca() {
  return (await fsp.readFile(GUIA, 'utf8').catch(() => '')).trim();
}

module.exports = { get, setColores, setFuente, setTema, setGuia, setLogo, guiaMarca };
