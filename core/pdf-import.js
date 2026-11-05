// Importar plantilla desde un archivo, en el navegador (funciona igual en local y en Vercel).
// pdf.js lee el PDF: miniaturas, texto, posición exacta de cada imagen (lista de operaciones de dibujo) y la imagen
// original (sin los textos que tenga encima). El servidor solo recibe pasos cortos:
//   /api/plantillas/analizar → /api/plantillas/replicar (una por página) → /api/media (cada foto) → /api/plantillas/guardar
// Expone window.AlmaImport = { run, detectBoxes }.
(function (root) {
  'use strict';
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/';
  var W = 1920, H = 1080;
  var CONCURRENCY = 3;
  var MAX_BODY = 3.4e6; // margen bajo el límite de 4,5 MB por request de Vercel

  var lib = null;
  function pdfjs() {
    if (!lib) lib = import(PDFJS + 'pdf.min.mjs').then(function (m) { m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs'; return m; });
    return lib;
  }

  /* ───────── geometría ───────── */
  function mul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function bbox(m, x0, y0, x1, y1) {
    var xs = [], ys = [];
    [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].forEach(function (p) { xs.push(m[0] * p[0] + m[2] * p[1] + m[4]); ys.push(m[1] * p[0] + m[3] * p[1] + m[5]); });
    var x = Math.min.apply(0, xs), y = Math.min.apply(0, ys);
    return { x: x, y: y, w: Math.max.apply(0, xs) - x, h: Math.max.apply(0, ys) - y };
  }
  function inter(a, b) {
    if (!a || !b) return null;
    var x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    var w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x: x, y: y, w: w, h: h } : null;
  }
  function iou(a, b) { var i = inter(a, b); return i ? (i.w * i.h) / (a.w * a.h + b.w * b.h - i.w * i.h) : 0; }
  var near0 = function (v) { return Math.abs(v) < 1e-6; };

  // caja de un trazado (constructPath: [ops, coords, minMax]). El minMax de pdf.js ignora las curvas,
  // así que se calcula con todos los puntos (incluidos los de control: caja conservadora).
  function pathMinMax(args, OPS) {
    var ops = args[0] || [], c = args[1] || [], j = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    var pt = function (x, y) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (o === OPS.rectangle) { pt(c[j], c[j + 1]); pt(c[j] + c[j + 2], c[j + 1] + c[j + 3]); j += 4; }
      else if (o === OPS.moveTo || o === OPS.lineTo) { pt(c[j], c[j + 1]); j += 2; }
      else if (o === OPS.curveTo) { pt(c[j], c[j + 1]); pt(c[j + 2], c[j + 3]); pt(c[j + 4], c[j + 5]); j += 6; }
      else if (o === OPS.curveTo2 || o === OPS.curveTo3) { pt(c[j], c[j + 1]); pt(c[j + 2], c[j + 3]); j += 4; }
    }
    if (!isFinite(x0)) { var mm = args[2]; return mm && mm.length === 4 && isFinite(mm[0]) ? [mm[0], mm[1], mm[2], mm[3]] : null; }
    return [x0, y0, x1, y1];
  }

  // cajas (px del lienzo 1920×1080) de las imágenes que dibuja una página, desde su lista de operaciones.
  // base: transformación de la página al lienzo. Cada caja: {x,y,w,h, raw?: {id, x,y,w,h en px de la imagen original}}
  function detectBoxes(ol, OPS, base) {
    var ctm = base.slice(), clip = { x: 0, y: 0, w: W, h: H }, masked = false, stack = [], lastPath = null, out = [];
    function push() { stack.push([ctm, clip, masked]); }
    function pop() { var s = stack.pop(); if (s) { ctm = s[0]; clip = s[1]; masked = s[2]; } }
    for (var i = 0; i < ol.fnArray.length; i++) {
      var fn = ol.fnArray[i], args = ol.argsArray[i] || [];
      if (fn === OPS.save) push();
      else if (fn === OPS.restore) pop();
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.constructPath) {
        var mm = pathMinMax(args, OPS);
        lastPath = mm ? bbox(ctm, mm[0], mm[1], mm[2], mm[3]) : null;
      } else if (fn === OPS.clip || fn === OPS.eoClip) { if (lastPath) clip = inter(clip, lastPath) || { x: 0, y: 0, w: 0, h: 0 }; }
      else if (fn === OPS.setGState) {
        (args[0] || []).forEach(function (kv) { if (kv && kv[0] === 'SMask') masked = !!kv[1]; });
      } else if (fn === OPS.paintFormXObjectBegin) {
        push();
        if (args[0] && args[0].length === 6) ctm = mul(ctm, args[0]);
        var fb = args[1];
        if (fb && fb.length === 4) clip = inter(clip, bbox(ctm, fb[0], fb[1], fb[2], fb[3])) || { x: 0, y: 0, w: 0, h: 0 };
      } else if (fn === OPS.paintFormXObjectEnd) pop();
      else if (fn === OPS.beginGroup) {
        push();
        var g = args[0] || {};
        if (g.matrix && g.matrix.length === 6) ctm = mul(ctm, g.matrix);
        if (g.bbox && g.bbox.length === 4) clip = inter(clip, bbox(ctm, g.bbox[0], g.bbox[1], g.bbox[2], g.bbox[3])) || { x: 0, y: 0, w: 0, h: 0 };
        if (g.smask) masked = true;
      } else if (fn === OPS.endGroup) pop();
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        var full = bbox(ctm, 0, 0, 1, 1);
        var box = inter(inter(full, clip), { x: 0, y: 0, w: W, h: H });
        if (!box || box.w < 60 || box.h < 60) continue;
        box = { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) };
        // imagen derecha (sin rotar ni espejar) y sin máscara suave: se puede usar el original
        var id = fn === OPS.paintImageXObject ? args[0] : null, iw = +args[1], ih = +args[2];
        if (id && iw && ih && !masked && near0(ctm[1]) && near0(ctm[2]) && ctm[0] > 0 && ctm[3] < 0) {
          var fx = ctm[4], fy = ctm[5] + ctm[3], fw = ctm[0], fh = -ctm[3];
          box.raw = { id: id, iw: iw, ih: ih, x: (box.x - fx) / fw * iw, y: (box.y - fy) / fh * ih, w: box.w / fw * iw, h: box.h / fh * ih };
        }
        var dup = -1;
        for (var k = 0; k < out.length; k++) if (iou(out[k], box) > 0.85) dup = k;
        if (dup < 0) out.push(box); else out[dup] = box; // la de encima manda
      }
    }
    return out;
  }
  // quita las que se repiten en muchas páginas (logos, pies)
  function dropRepeated(res, nPages) {
    var all = [];
    Object.keys(res).forEach(function (n) { all = all.concat(res[n]); });
    Object.keys(res).forEach(function (n) {
      res[n] = res[n].filter(function (b) {
        var rep = all.filter(function (o) { return iou(o, b) > 0.9; }).length >= Math.max(3, nPages * 0.4);
        return !(rep && b.w * b.h < W * H * 0.08);
      });
    });
    return res;
  }

  /* ───────── lienzos e imágenes ───────── */
  function canvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  function b64(c, type, q) { return c.toDataURL(type || 'image/jpeg', q || 0.85).split(',')[1]; }
  function scaled(src, w, h) { var c = canvas(w, h), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height); return c; }
  function hasAlpha(c) {
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, step = Math.max(4, Math.floor(d.length / 4 / 40000) * 4);
    for (var i = 3; i < d.length; i += step) if (d[i] < 250) return true;
    return false;
  }
  function loadImg(url) { return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { rej(new Error('No se pudo leer la imagen')); }; i.src = url; }); }

  // fuente PDF: páginas renderizadas a demanda (se guarda solo la última en alta resolución)
  function PdfSource(doc, m) {
    this.doc = doc; this.m = m; this.n = doc.numPages; this.kind = 'pdf'; this.hi = null; this.lock = Promise.resolve();
  }
  PdfSource.prototype.page = function (n) { return this.doc.getPage(n); };
  PdfSource.prototype.render = function (n, w) {
    return this.page(n).then(function (p) {
      var vp0 = p.getViewport({ scale: 1 }), vp = p.getViewport({ scale: w / vp0.width });
      var c = canvas(vp.width, vp.height);
      return p.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise.then(function () { return { page: p, canvas: c }; });
    });
  };
  PdfSource.prototype.image = function (n, w, h) { return this.render(n, w).then(function (r) { return scaled(r.canvas, w, h); }); };
  PdfSource.prototype.text = function (n) {
    return this.page(n).then(function (p) { return p.getTextContent(); }).then(function (tc) {
      return tc.items.map(function (i) { return (i.str || '') + (i.hasEOL ? '\n' : ' '); }).join('').replace(/[ \t]+/g, ' ').trim();
    });
  };
  PdfSource.prototype.boxes = function (n) {
    var m = this.m;
    return this.page(n).then(function (p) {
      var vp0 = p.getViewport({ scale: 1 }), vp = p.getViewport({ scale: W / vp0.width });
      var base = mul([1, 0, 0, H / vp.height, 0, 0], vp.transform);
      return p.getOperatorList().then(function (ol) { return detectBoxes(ol, m.OPS, base); });
    });
  };
  // página n a 2× (3840×2160) para recortar; una a la vez
  PdfSource.prototype.hiRes = function (n) {
    var self = this;
    if (self.hi && self.hi.n === n) return Promise.resolve(self.hi);
    return self.render(n, W * 2).then(function (r) {
      self.hi = { n: n, page: r.page, canvas: scaled(r.canvas, W * 2, H * 2) };
      return self.hi;
    });
  };
  PdfSource.prototype.original = function (page, id) {
    var objs = /^g_/.test(id) ? page.commonObjs : page.objs;
    try { return objs.has(id) ? objs.get(id) : null; } catch (e) { return null; }
  };
  // foto de una caja: la imagen original recortada a la zona visible, o el recorte de la página renderizada
  PdfSource.prototype.photo = function (n, box) {
    var self = this;
    return self.hiRes(n).then(function (hi) {
      var r = box.raw, img = r && self.original(hi.page, r.id);
      if (img && (img.bitmap || img.data) && img.width && img.height) {
        var full = canvas(img.width, img.height), fx = full.getContext('2d');
        if (img.bitmap) fx.drawImage(img.bitmap, 0, 0);
        else {
          var px = img.data, id = fx.createImageData(img.width, img.height), d = id.data, nPx = img.width * img.height;
          if (px.length >= nPx * 4) d.set(px.subarray(0, nPx * 4));
          else if (px.length >= nPx * 3) for (var i = 0, j = 0; i < nPx; i++, j += 3) { d[i * 4] = px[j]; d[i * 4 + 1] = px[j + 1]; d[i * 4 + 2] = px[j + 2]; d[i * 4 + 3] = 255; }
          else img = null;
          if (img) fx.putImageData(id, 0, 0);
        }
        if (img) {
          var x = Math.max(0, Math.round(r.x * img.width / r.iw)), y = Math.max(0, Math.round(r.y * img.height / r.ih));
          var w = Math.min(Math.round(r.w * img.width / r.iw), img.width - x), h = Math.min(Math.round(r.h * img.height / r.ih), img.height - y);
          if (w >= 30 && h >= 30) {
            var k = Math.min(1, 2600 / Math.max(w, h)), c = canvas(w * k, h * k);
            c.getContext('2d').drawImage(full, x, y, w, h, 0, 0, c.width, c.height);
            return c;
          }
        }
      }
      return cropCanvas(hi.canvas, box, 2);
    });
  };
  PdfSource.prototype.crop = function (n, box) { return this.hiRes(n).then(function (hi) { return cropCanvas(hi.canvas, box, 2); }); };

  // fuente de imágenes (una por slide)
  function ImgSource(imgs) { this.imgs = imgs; this.n = imgs.length; this.kind = 'img'; }
  ImgSource.prototype.image = function (n, w, h) { return Promise.resolve(scaled(this.imgs[n - 1], w, h)); };
  ImgSource.prototype.text = function () { return Promise.resolve(''); };
  ImgSource.prototype.boxes = function () { return Promise.resolve([]); };
  ImgSource.prototype.crop = function (n, box) {
    var im = this.imgs[n - 1], k = Math.max(im.naturalWidth / W, 1);
    return Promise.resolve(cropCanvas(scaled(im, W * k, H * k), box, k));
  };
  ImgSource.prototype.photo = ImgSource.prototype.crop;

  function cropCanvas(src, box, k) {
    var x = Math.max(0, Math.round(box.x)), y = Math.max(0, Math.round(box.y));
    var w = Math.min(Math.round(box.w), W - x), h = Math.min(Math.round(box.h), H - y);
    if (!(w >= 40 && h >= 40)) return null;
    var c = canvas(w * k, h * k), cx = c.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(src, x * k, y * k, w * k, h * k, 0, 0, c.width, c.height);
    return c;
  }

  /* ───────── servidor ───────── */
  function post(url, body) {
    var json = JSON.stringify(body);
    if (json.length > 4.4e6) return Promise.reject(new Error('Envío demasiado grande (' + Math.round(json.length / 1e6) + ' MB).'));
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json }).then(function (r) {
      return r.text().then(function (t) {
        var j; try { j = JSON.parse(t); } catch (e) { j = null; }
        if (!r.ok || !j) {
          var msg = (j && j.error) || (r.status === 413 ? 'El envío supera el límite del servidor.' : r.status === 504 ? 'El servidor tardó demasiado (timeout).' : 'Error ' + r.status + ': ' + t.slice(0, 120));
          throw new Error(msg);
        }
        return j;
      });
    });
  }
  // sube una foto al banco media/ → "../media/<hash>.<ext>"
  function upload(c) {
    if (!c) return Promise.resolve(null);
    var png = hasAlpha(c), data = png ? b64(c, 'image/png') : b64(c, 'image/jpeg', 0.88);
    var k = 1;
    while (data.length > MAX_BODY && k > 0.3) { k *= 0.75; var s = scaled(c, c.width * k, c.height * k); png = false; data = b64(s, 'image/jpeg', 0.85); }
    return post('/api/media', { type: png ? 'image/png' : 'image/jpeg', data: data }).then(function (j) { return j.url; });
  }

  /* ───────── completar los slots de imagen de una slide ───────── */
  var SLOT = /<div\b[^>]*\bdata-(?:img|crop)="[^"]*"[^>]*>/g;
  function boxOf(tag) {
    var g = function (k) { var m = tag.match(new RegExp('(?:^|[;"\\s])' + k + ':\\s*(-?[\\d.]+)px')); return m ? +m[1] : NaN; };
    var b = { x: g('left'), y: g('top'), w: g('width'), h: g('height') };
    return [b.x, b.y, b.w, b.h].every(isFinite) ? b : null;
  }
  function withBg(tag, url) { return /style="/.test(tag) ? tag.replace(/style="/, 'style="background-image:url(' + url + ');') : tag.replace(/>$/, ' style="background-image:url(' + url + ')">'); }
  function fillImages(src, n, html, boxes) {
    var tags = html.match(SLOT) || [], used = {}, placed = [];
    var jobs = tags.map(function (tag) {
      var id = (tag.match(/data-img="(\d+)"/) || [])[1], b = id && boxes[+id - 1];
      if (b) { used[+id - 1] = 1; placed.push(b); return function () { return src.photo(n, b); }; }
      var cb = (tag.match(/data-crop="([^"]+)"/) || [])[1];
      if (cb) {
        var v = cb.split(',').map(Number), box = { x: v[0], y: v[1], w: v[2], h: v[3] };
        if ([box.x, box.y, box.w, box.h].every(isFinite)) { placed.push(box); return function () { return src.crop(n, box); }; }
      }
      return null;
    });
    var urls = [];
    // en serie: comparten el render en alta resolución de la página
    var chain = jobs.reduce(function (p, job) {
      return p.then(function () { return job ? job().then(upload).catch(function () { return null; }) : null; }).then(function (u) { urls.push(u); });
    }, Promise.resolve());
    return chain.then(function () {
      var i = 0;
      html = html.replace(SLOT, function (tag) {
        var url = urls[i++];
        tag = tag.replace(/\sdata-(?:img|crop)="[^"]*"/g, '').replace(/\s{2,}/g, ' ');
        return url ? withBg(tag, url) : tag.replace(/\bfoto lleno\b/, 'foto');
      });
      // fotos originales grandes que la IA no usó: se agregan en su lugar exacto (detrás del contenido)
      var slots = (html.match(/<div\b[^>]*class="[^"]*\bfoto\b[^>]*>/g) || []).map(boxOf).filter(Boolean);
      var extra = boxes.filter(function (b, k) {
        return !used[k] && b.raw && b.w * b.h >= W * H * 0.03 && !placed.concat(slots).some(function (o) { return iou(o, b) > 0.3; });
      });
      var add = [];
      return extra.reduce(function (p, b) {
        return p.then(function () { return src.photo(n, b).then(upload).catch(function () { return null; }); }).then(function (u) {
          if (u) add.push('<div class="foto lleno" data-hint="imagen del original" style="left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px;background-image:url(' + u + ')"></div>');
        });
      }, Promise.resolve()).then(function () {
        if (add.length) html = html.replace(/(<div class="canvas"[^>]*>)/, '$1\n' + add.join('\n'));
        return html;
      });
    });
  }

  function pool(items, n, fn) {
    var i = 0;
    function go() { if (i >= items.length) return Promise.resolve(); var k = i++; return fn(items[k], k).then(go); }
    var ws = []; for (var w = 0; w < Math.min(n, items.length); w++) ws.push(go());
    return Promise.all(ws);
  }

  /* ───────── HTML del sistema ───────── */
  function importHtml(file, nombre, job, say) {
    job.fase = 'analizando';
    var html = new TextDecoder().decode(Uint8Array.from(atob(file.data), function (c) { return c.charCodeAt(0); }));
    var re = /data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)/g, found = [], m;
    while ((m = re.exec(html))) if (m[2].length >= 2700) found.push(m);
    say(found.length ? 'Subiendo ' + found.length + ' imágenes del HTML…' : 'Claude está leyendo la presentación para generar su ficha…');
    return found.reduce(function (p, mm) {
      return p.then(function () {
        if (mm[2].length > MAX_BODY) return loadImg(mm[0]).then(function (im) { return upload(scaled(im, im.naturalWidth, im.naturalHeight)); }).then(function (u) { html = html.split(mm[0]).join(u); });
        return post('/api/media', { type: mm[1], data: mm[2] }).then(function (j) { html = html.split(mm[0]).join(j.url); });
      });
    }, Promise.resolve()).then(function () {
      if (found.length) say('Claude está leyendo la presentación para generar su ficha…');
      if (html.length > 4.3e6) throw new Error('El HTML es demasiado grande (' + Math.round(html.length / 1e6) + ' MB) incluso sin imágenes.');
      return post('/api/plantillas/html', { html: html, nombre: nombre });
    });
  }

  /* ───────── trabajo completo ───────── */
  // files: [{name, type, data(base64)}] · onProgress(job) se llama en cada cambio
  function run(opt) {
    var files = opt.files || [], nombre = (opt.nombre || '').trim(), notas = (opt.notas || '').trim();
    var job = { fase: 'preparando', pasos: [], slides: [], total: 0, hechas: 0, inicio: Date.now() };
    var draw = function () { try { opt.onProgress(job); } catch (e) {} };
    var say = function (t) { job.pasos.push(t); draw(); };
    var tick = setInterval(draw, 1000);

    var work = (function () {
      var h = files.filter(function (f) { return /html/.test(f.type) || /\.html?$/i.test(f.name); })[0];
      if (h) return importHtml(h, nombre, job, say).then(function (r) { job.path = r.path; job.titulo = r.titulo; });
      var pdf = files.filter(function (f) { return f.type === 'application/pdf'; })[0];
      var imgs = files.filter(function (f) { return /^image\/(png|jpeg|webp)$/.test(f.type); });
      if (!pdf && !imgs.length) return Promise.reject(new Error('Adjunta un PDF de la presentación, imágenes de sus slides o un HTML.'));
      say(pdf ? 'Leyendo el PDF y generando miniaturas de cada página…' : 'Preparando ' + imgs.length + ' imágenes…');
      var srcP = pdf
        ? pdfjs().then(function (m) {
            var bytes = Uint8Array.from(atob(pdf.data), function (c) { return c.charCodeAt(0); });
            return m.getDocument({ data: bytes, isEvalSupported: false }).promise.then(function (doc) { return new PdfSource(doc, m); });
          })
        : Promise.all(imgs.map(function (f) { return loadImg('data:' + f.type + ';base64,' + f.data); })).then(function (l) { return new ImgSource(l); });
      var src, a, pages = [];
      return srcP.then(function (s) {
        src = s;
        var nums = []; for (var i = 1; i <= Math.min(src.n, 100); i++) nums.push(i);
        // miniaturas que quepan en un request: se achican si el PDF es largo
        var tw = src.n > 60 ? 300 : src.n > 30 ? 360 : 420;
        return nums.reduce(function (p, n) {
          return p.then(function () { return Promise.all([src.image(n, tw, tw * H / W), src.text(n)]); })
            .then(function (r) { pages.push({ n: n, thumb: b64(r[0], 'image/jpeg', 0.7), text: r[1] }); });
        }, Promise.resolve()).then(function () {
          var size = function () { return pages.reduce(function (t, p) { return t + p.thumb.length + p.text.slice(0, 500).length; }, 0); };
          if (size() > MAX_BODY) {
            // segunda pasada más liviana
            return pages.reduce(function (p, pg) {
              return p.then(function () { return src.image(pg.n, 260, 260 * H / W); }).then(function (c) { pg.thumb = b64(c, 'image/jpeg', 0.55); });
            }, Promise.resolve());
          }
        });
      }).then(function () {
        say(src.n + ' páginas. Claude está analizando colores, tipos de slide y contenido…');
        job.fase = 'analizando'; draw();
        return post('/api/plantillas/analizar', { nombre: nombre, notas: notas, pages: pages.map(function (p) { return { n: p.n, thumb: p.thumb, text: p.text.slice(0, 500) }; }) });
      }).then(function (r) {
        a = r;
        job.titulo = a.nombre; job.estructura = a.estilo; job.total = a.paginas.length;
        job.slides = a.paginas.map(function (p) { return { proposito: 'Página ' + p.n + ' · ' + p.tipo, accion: 'replicar', origen: p.nota, estado: 'pendiente' }; });
        say('Análisis listo: replicaré ' + a.paginas.length + ' páginas representativas. Tema: ' + a.tema.accent + ' · ' + a.tema.accent2 + ' · ' + a.tema.accent3 + '.');
        // posición exacta de las fotos de cada página elegida
        var boxes = {};
        return a.paginas.reduce(function (p, pg) {
          return p.then(function () { return src.boxes(pg.n).catch(function () { return []; }); }).then(function (b) { boxes[pg.n] = b; });
        }, Promise.resolve()).then(function () { return dropRepeated(boxes, a.paginas.length); });
      }).then(function (boxes) {
        var nFotos = 0; Object.keys(boxes).forEach(function (k) { nFotos += boxes[k].length; });
        if (nFotos) say('Encontré ' + nFotos + ' imágenes en las páginas elegidas; se guardarán en el banco de imágenes.');
        job.fase = 'generando';
        say('Replicando ' + a.paginas.length + ' slides (' + CONCURRENCY + ' en paralelo)…');
        var out = new Array(a.paginas.length);
        var imgLock = Promise.resolve(); // las fotos se procesan de a una página (render en alta resolución)
        var aLite = { nombre: a.nombre, estilo: a.estilo, ficha: a.ficha, tema: a.tema };
        return pool(a.paginas, CONCURRENCY, function (page, k) {
          job.slides[k].estado = 'generando'; draw();
          var bx = boxes[page.n] || [];
          return Promise.all([src.image(page.n, 1600, 900), src.text(page.n)]).then(function (r) {
            return post('/api/plantillas/replicar', { a: aLite, page: page, idx: k, total: a.paginas.length, image: b64(r[0], 'image/jpeg', 0.82), text: r[1].slice(0, 4000),
              boxes: bx.map(function (b) { return { x: b.x, y: b.y, w: b.w, h: b.h }; }) });
          }).then(function (r) {
            var mine = imgLock.then(function () { return fillImages(src, page.n, r.html, bx); });
            imgLock = mine.catch(function () {});
            return mine;
          }).then(function (html) {
            out[k] = html; job.slides[k].estado = 'listo';
          }).catch(function (e) {
            out[k] = ''; job.slides[k].estado = 'error';
            say('Página ' + page.n + ': no se pudo replicar (' + e.message + ').');
          }).then(function () { job.hechas++; draw(); });
        }).then(function () {
          var ok = out.filter(Boolean);
          if (!ok.length) throw new Error('No se pudo replicar ninguna página.');
          job.fase = 'armando'; say('Armando la plantilla…');
          return post('/api/plantillas/guardar', { a: aLite, slides: ok });
        });
      }).then(function (r) { job.path = r.path; job.titulo = r.titulo || job.titulo; });
    })();

    return work.then(function () {
      job.fase = 'listo'; say('¡Plantilla lista! Revísala en el editor y ajusta lo que haga falta.');
    }, function (e) {
      job.fase = 'error'; job.error = e.message; say('Error: ' + e.message);
    }).then(function () { clearInterval(tick); draw(); return job; });
  }

  var api = { run: run, detectBoxes: detectBoxes, dropRepeated: dropRepeated, mul: mul };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AlmaImport = api;
})(this);
