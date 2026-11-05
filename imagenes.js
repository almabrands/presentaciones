// Imágenes de las presentaciones:
//  - media/: banco de imágenes compartido. Las fotos se guardan como archivos (nombre = hash del contenido,
//    así una misma foto se guarda una sola vez) y el HTML las referencia como ../media/<hash>.jpg.
//  - Detección de fotos dentro de un PDF (posición exacta en la página) y recorte, con poppler.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const MEDIA = path.join(ROOT, 'media');
const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
const DATA_URL = /data:(image\/(?:jpeg|jpg|png|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)/gi;

const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024 }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));
function bin(name) {
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) if (fs.existsSync(path.join(d, name))) return path.join(d, name);
  return null;
}

/* ───────── banco media/ ───────── */
function saveBuffer(buf, type) {
  const ext = EXT[type] || 'jpg';
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${ext}`;
  const abs = path.join(MEDIA, name);
  if (!fs.existsSync(abs)) { fs.mkdirSync(MEDIA, { recursive: true }); fs.writeFileSync(abs, buf); }
  return `../media/${name}`;
}

// reemplaza las imágenes base64 del HTML por archivos en media/ (las de menos de 2 KB quedan embebidas)
function externalize(html) {
  return String(html).replace(DATA_URL, (m, type, data) => (data.length < 2700 ? m : saveBuffer(Buffer.from(data, 'base64'), type.toLowerCase())));
}

// versión async: sube a Supabase Storage en modo supabase, escribe en disco en modo local
async function externalizeAsync(html) {
  const storage = require('./storage');
  const matches = [...String(html).matchAll(new RegExp(DATA_URL.source, 'gi'))];
  for (const [fullMatch, type, data] of matches) {
    if (data.length < 2700) continue;
    const buf = Buffer.from(data, 'base64');
    const ext = EXT[type.toLowerCase()] || 'jpg';
    const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${ext}`;
    await storage.writeMedia(name, buf);
    html = html.replace(fullMatch, `../media/${name}`);
  }
  return html;
}

// guarda un buffer en el banco (disco local o Supabase Storage) → "../media/<hash>.<ext>"
async function saveBufferAsync(buf, type) {
  const storage = require('./storage');
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${EXT[type] || 'jpg'}`;
  await storage.writeMedia(name, buf);
  return `../media/${name}`;
}

/* ───────── fotos dentro de un PDF ───────── */
const nums = (s) => (String(s).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) || []).map(Number);
const inter = (a, b) => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
};
const iou = (a, b) => { const i = inter(a, b); return i ? (i.w * i.h) / (a.w * a.h + b.w * b.h - i.w * i.h) : 0; };

// cajas (en px del lienzo 1920×1080) de las imágenes dibujadas en una página, leyendo su SVG (pdftocairo)
function boxesFromSvg(svg) {
  const vb = nums((svg.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 720 405');
  const sx = 1920 / (vb[2] || 720), sy = 1080 / (vb[3] || 405);
  const srcs = {}, clips = {}, masked = new Set();
  for (const m of svg.matchAll(/<image\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const t = m[0];
    srcs[m[1]] = { w: +(t.match(/\bwidth="([\d.]+)"/) || [])[1] || 0, h: +(t.match(/\bheight="([\d.]+)"/) || [])[1] || 0,
      href: (t.match(/xlink:href="(data:image\/(?:jpeg|png);base64,[^"]+)"/) || [])[1] || '' };
  }
  // imágenes con máscara/transparencia compuesta: se recortan del render, no del original
  for (const m of svg.matchAll(/<mask\b[\s\S]*?<\/mask>/g)) for (const u of m[0].matchAll(/xlink:href="#([^"]+)"/g)) masked.add(u[1]);
  for (const m of svg.matchAll(/<(?:g|use)\b[^>]*mask="url\(#[^)]+\)"[^>]*>(?:\s*<use\b[^>]*xlink:href="#([^"]+)")?/g)) if (m[1]) masked.add(m[1]);
  for (const m of svg.matchAll(/<clipPath id="([^"]+)">\s*<path[^>]*\bd="([^"]+)"/g)) {
    const n = nums(m[2]), xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
    if (xs.length) clips[m[1]] = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  const defsEnd = svg.lastIndexOf('</defs>');
  const body = defsEnd > 0 ? svg.slice(defsEnd) : svg;
  const out = [], stack = [];
  for (const m of body.matchAll(/<g\b[^>]*>|<\/g>|<use\b[^>]*>|<image\b[^>]*>/g)) {
    const t = m[0];
    if (t === '</g>') { stack.pop(); continue; }
    if (t.startsWith('<g')) { stack.push((t.match(/clip-path="url\(#([^)]+)\)"/) || [])[1] || null); continue; }
    let w, h, src = null;
    if (t.startsWith('<use')) {
      const id = (t.match(/xlink:href="#([^"]+)"/) || [])[1];
      if (!srcs[id] || /filter=/.test(t)) continue;
      ({ w, h } = srcs[id]);
      src = srcs[id].href && !masked.has(id) && !/mask=/.test(t) ? srcs[id] : null;
    } else {
      w = +(t.match(/\bwidth="([\d.]+)"/) || [])[1] || 0; h = +(t.match(/\bheight="([\d.]+)"/) || [])[1] || 0;
      const href = (t.match(/xlink:href="(data:image\/(?:jpeg|png);base64,[^"]+)"/) || [])[1];
      if (href && !/mask=/.test(t)) src = { w, h, href };
    }
    const [a, b, c, d, e, f] = nums((t.match(/transform="matrix\(([^)]+)\)"/) || [])[1] || '1 0 0 1 0 0');
    if (b || c || a <= 0 || d <= 0) src = null; // rotada o espejada: mejor desde el render
    const xs = [e, e + a * w, e + c * h, e + a * w + c * h], ys = [f, f + b * w, f + d * h, f + b * w + d * h];
    const full = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    let box = full;
    for (const cid of [...stack, (t.match(/clip-path="url\(#([^)]+)\)"/) || [])[1]]) if (cid && clips[cid] && box) box = inter(box, clips[cid]);
    if (!box) continue;
    box = inter({ x: box.x * sx, y: box.y * sy, w: box.w * sx, h: box.h * sy }, { x: 0, y: 0, w: 1920, h: 1080 });
    if (!box || box.w < 60 || box.h < 60) continue;
    const fullPx = { x: full.x * sx, y: full.y * sy, w: full.w * sx, h: full.h * sy };
    box = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
    // zona visible dentro de la imagen original (px de la imagen)
    if (src) box.raw = { href: src.href, x: ((box.x - fullPx.x) / fullPx.w) * src.w, y: ((box.y - fullPx.y) / fullPx.h) * src.h, w: (box.w / fullPx.w) * src.w, h: (box.h / fullPx.h) * src.h };
    const dup = out.findIndex((o) => iou(o, box) > 0.85);
    if (dup < 0) out.push(box); else out[dup] = box; // la de encima manda
  }
  return out;
}

// cajas de imágenes por página: { [n]: [{x,y,w,h}] }. Quita las que se repiten en muchas páginas (logos, pies).
async function pdfImageBoxes(pdf, pages, tmp) {
  const cairo = bin('pdftocairo');
  if (!cairo) return {};
  const res = {};
  for (const n of pages) {
    const out = path.join(tmp, `svg-${n}.svg`);
    try {
      await run(cairo, ['-svg', '-f', String(n), '-l', String(n), pdf, out]);
      res[n] = boxesFromSvg(await fsp.readFile(out, 'utf8'));
    } catch { res[n] = []; }
    fs.rm(out, { force: true }, () => {});
  }
  const all = Object.values(res).flat();
  const repeated = (b) => all.filter((o) => iou(o, b) > 0.9).length >= Math.max(3, pages.length * 0.4);
  for (const n of Object.keys(res)) res[n] = res[n].filter((b) => !(repeated(b) && b.w * b.h < 1920 * 1080 * 0.08));
  return res;
}

// recorta una zona (px del lienzo 1920×1080) de la página n del PDF; scale 2 = el doble de resolución
async function cropPdf(pdf, n, box, tmp, scale = 2) {
  const ppm = bin('pdftoppm');
  let { x, y, w, h } = box;
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.round(Math.min(w, 1920 - x)); h = Math.round(Math.min(h, 1080 - y));
  if (!ppm || !(w >= 40 && h >= 40)) return null;
  const out = path.join(tmp, `crop-${n}-${crypto.randomBytes(4).toString('hex')}`);
  await run(ppm, ['-jpeg', '-jpegopt', 'quality=86', '-singlefile', '-f', String(n), '-l', String(n), '-scale-to-x', String(1920 * scale), '-scale-to-y', String(1080 * scale),
    '-x', String(x * scale), '-y', String(y * scale), '-W', String(w * scale), '-H', String(h * scale), pdf, out]);
  const buf = await fsp.readFile(out + '.jpg');
  fs.rm(out + '.jpg', { force: true }, () => {});
  return buf;
}

// foto de una caja detectada: la imagen original del PDF (sin textos encima, a su resolución) recortada a la zona
// visible; si no se puede (máscaras, rotación), el recorte del render de la página. → { buf, type }
async function photoFromBox(pdf, n, box, tmp, scale = 2) {
  const sips = fs.existsSync('/usr/bin/sips') ? '/usr/bin/sips' : null;
  if (box.raw && sips) {
    try {
      const m = box.raw.href.match(/^data:image\/(jpeg|png);base64,(.*)$/);
      const ext = m[1] === 'png' ? 'png' : 'jpg';
      const id = crypto.randomBytes(4).toString('hex');
      const inp = path.join(tmp, `raw-${id}.${ext}`), out = path.join(tmp, `rawc-${id}.${ext}`);
      await fsp.writeFile(inp, Buffer.from(m[2], 'base64'));
      const meta = await run(sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', inp]);
      const W = +(meta.match(/pixelWidth:\s*(\d+)/) || [])[1], H = +(meta.match(/pixelHeight:\s*(\d+)/) || [])[1];
      const x = Math.max(0, Math.round(box.raw.x)), y = Math.max(0, Math.round(box.raw.y));
      const w = Math.min(Math.round(box.raw.w), W - x), h = Math.min(Math.round(box.raw.h), H - y);
      if (w >= 30 && h >= 30) {
        const args = (x > 1 || y > 1 || w < W - 1 || h < H - 1) ? ['-c', String(h), String(w), '--cropOffset', String(y), String(x)] : [];
        if (Math.max(w, h) > 2600) args.push('-Z', '2600');
        if (args.length) await run(sips, [...args, inp, '--out', out]);
        const buf = await fsp.readFile(args.length ? out : inp);
        fs.rm(inp, { force: true }, () => {}); fs.rm(out, { force: true }, () => {});
        return { buf, type: ext === 'png' ? 'image/png' : 'image/jpeg' };
      }
    } catch {}
  }
  const buf = await cropPdf(pdf, n, box, tmp, scale);
  return buf ? { buf, type: 'image/jpeg' } : null;
}

// recorta una zona (px del lienzo 1920×1080) de una imagen de slide (macOS sips)
async function cropImage(file, box, tmp) {
  const sips = fs.existsSync('/usr/bin/sips') ? '/usr/bin/sips' : null;
  if (!sips) return null;
  const meta = await run(sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const W = +(meta.match(/pixelWidth:\s*(\d+)/) || [])[1], H = +(meta.match(/pixelHeight:\s*(\d+)/) || [])[1];
  if (!W || !H) return null;
  const kx = W / 1920, ky = H / 1080;
  const x = Math.max(0, Math.round(box.x * kx)), y = Math.max(0, Math.round(box.y * ky));
  const w = Math.min(Math.round(box.w * kx), W - x), h = Math.min(Math.round(box.h * ky), H - y);
  if (w < 30 || h < 30) return null;
  const out = path.join(tmp, `crop-${crypto.randomBytes(4).toString('hex')}.jpg`);
  await run(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '86', '-c', String(h), String(w), '--cropOffset', String(y), String(x), file, '--out', out]);
  const buf = await fsp.readFile(out);
  fs.rm(out, { force: true }, () => {});
  return buf;
}

// fotos de un PDF adjunto (para usarlas dentro de las slides): [{name, type, data(base64), extraido}]
async function imagesFromPdf(file, { maxPages = 40, max = 16 } = {}) {
  const info = bin('pdfinfo');
  if (!info || !bin('pdftocairo') || !bin('pdftoppm')) return [];
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'alma-pdfimg-'));
  try {
    const pdf = path.join(tmp, 'src.pdf');
    await fsp.writeFile(pdf, Buffer.from(String(file.data).replace(/^data:[^,]*,/, ''), 'base64'));
    const n = +((await run(info, [pdf])).match(/Pages:\s+(\d+)/) || [])[1] || 0;
    const pages = Array.from({ length: Math.min(n, maxPages) }, (_, i) => i + 1);
    const boxes = await pdfImageBoxes(pdf, pages, tmp);
    const list = [];
    // solo fotos de cierto tamaño (≥ 1,5 % de la slide): los íconos chicos no aportan como adjunto
    for (const p of pages) for (const [k, b] of (boxes[p] || []).entries()) if (b.w * b.h >= 1920 * 1080 * 0.015) list.push({ p, k, b });
    // las más grandes primero, conservando el orden de páginas entre las elegidas
    const pick = list.sort((a, b) => b.b.w * b.b.h - a.b.w * a.b.h).slice(0, max).sort((a, b) => a.p - b.p || a.k - b.k);
    const out = [];
    for (const { p, k, b } of pick) {
      const ph = await photoFromBox(pdf, p, b, tmp, 1).catch(() => null);
      if (ph) out.push({ name: `${file.name} · pág. ${p} · imagen ${k + 1}`, type: ph.type, data: ph.buf.toString('base64'), extraido: true });
    }
    return out;
  } catch { return []; } finally { fs.rm(tmp, { recursive: true, force: true }, () => {}); }
}

// agrega a la lista de adjuntos las fotos encontradas dentro de cada PDF
async function expandPdfImages(files) {
  const out = [...(files || [])];
  for (const f of files || []) if (f && f.type === 'application/pdf') out.push(...await imagesFromPdf(f));
  return out;
}

/* ───────── fotos de internet ───────── */
const dns = require('dns').promises;
const net = require('net');
const privada = (ip) => net.isIPv6(ip)
  ? /^(::1?$|f[cd]|fe[89ab]|::ffff:(127|10|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\.)/i.test(ip)
  : /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(ip);
async function urlPublica(u) {
  const url = new URL(u);
  if (!/^https?:$/.test(url.protocol)) throw new Error('URL no permitida');
  const { address } = await dns.lookup(url.hostname);
  if (privada(address)) throw new Error('URL no permitida');
  return url;
}

// descarga una imagen pública (sigue redirecciones; si la URL es una página, usa su og:image) → URL en media/
async function fetchImage(u, depth = 0) {
  let url = await urlPublica(u);
  let res;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', Accept: 'image/avif,image/webp,image/*,text/html;q=0.8,*/*;q=0.5' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = await urlPublica(new URL(res.headers.get('location'), url).href); continue; }
    break;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (/^text\/html/.test(type) && depth === 0) {
    const html = (await res.text()).slice(0, 500000);
    const og = (html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/i) || [])[0];
    const src = og && (og.match(/content=["']([^"']+)["']/i) || [])[1];
    if (!src) throw new Error('la página no tiene imagen principal');
    return fetchImage(new URL(src.replace(/&amp;/g, '&'), url).href, 1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error('imagen demasiado grande');
  const sniff = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf.slice(1, 4).toString() === 'PNG' ? 'image/png'
    : buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : buf.slice(0, 3).toString() === 'GIF' ? 'image/gif'
    : /^image\/svg/.test(type) || /^\s*<(\?xml|svg)/.test(buf.slice(0, 200).toString()) ? 'image/svg+xml' : '';
  if (!sniff) throw new Error('no es una imagen');
  if (buf.length < 3000 && sniff !== 'image/svg+xml') throw new Error('imagen demasiado pequeña');
  return saveBuffer(buf, sniff);
}

// slots <div class="foto" data-web="URL"> → descarga la foto a media/; si falla, el slot queda vacío con la URL en la pista
async function resolveWebImages(html) {
  const tags = [...String(html).matchAll(/<div\b[^>]*\bdata-web="([^"]+)"[^>]*>/g)];
  const urls = await Promise.all(tags.map((m) => fetchImage(m[1].replace(/&amp;/g, '&')).catch((e) => { console.log(`Foto web no descargada (${e.message}): ${m[1]}`); return null; })));
  let i = 0, ok = 0;
  const out = String(html).replace(/<div\b[^>]*\bdata-web="([^"]+)"[^>]*>/g, (tag, src) => {
    const url = urls[i++];
    tag = tag.replace(/\sdata-web="[^"]*"/, '');
    if (!url) return tag.replace(/\blleno\b\s?/, '').replace(/data-hint="([^"]*)"/, (m, h) => `data-hint="${h} · no se pudo descargar: ${src.replace(/"/g, '')}"`);
    ok++;
    tag = tag.replace(/background-image:\s*url\([^)]*\);?/g, '');
    if (!/\blleno\b/.test(tag)) tag = tag.replace(/class="([^"]*)"/, 'class="$1 lleno"');
    return /style="/.test(tag) ? tag.replace(/style="/, `style="background-image:url(${url});`) : tag.replace(/>$/, ` style="background-image:url(${url})">`);
  });
  return { html: out, total: tags.length, ok };
}

module.exports = { saveBufferAsync, fetchImage, resolveWebImages, MEDIA, saveBuffer, externalize, externalizeAsync, boxesFromSvg, pdfImageBoxes, cropPdf, photoFromBox, cropImage, imagesFromPdf, expandPdfImages, iou };
