// Crear presentación completa con IA, orquestada desde el navegador (funciona igual en local y en Vercel).
// Pasos cortos contra el servidor (cada request < 4,5 MB, sin trabajos en memoria):
//   adjuntos → /api/media (imágenes y fotos sacadas de los PDF con pdf.js)
//   /api/crear/plan → /api/crear/fotos (si hay búsqueda web) → /api/crear/slide (una por slide, 3 en paralelo) → /api/crear/guardar
// Requiere core/pdf-import.js (window.AlmaImport). Expone window.AlmaCrear = { run }.
(function (root) {
  'use strict';
  var CONCURRENCY = 3;
  var PDF_INLINE = 2.5e6; // PDFs adjuntos (base64) que se envían tal cual a Claude; si suman más, van como texto

  function run(opt) {
    var A = root.AlmaImport;
    var job = { fase: 'preparando', pasos: [], slides: [], total: 0, hechas: 0, inicio: Date.now() };
    var draw = function () { try { opt.onProgress(job); } catch (e) {} };
    var say = function (t) { job.pasos.push(t); draw(); };
    var tick = setInterval(draw, 1000);
    var brief = String(opt.brief || '').trim(), data = String(opt.data || '');
    var files = [], plan;

    var work = Promise.resolve().then(function () {
      if (!brief) throw new Error('Describe la presentación que quieres crear.');
      var src = opt.files || [];
      var pdfs = src.filter(function (f) { return f.type === 'application/pdf'; });
      var pdfBytes = pdfs.reduce(function (t, f) { return t + f.data.length; }, 0);
      var extra = [];
      if (src.length) say('Preparando ' + src.length + ' adjunto' + (src.length > 1 ? 's' : '') + '…');
      // en orden: los adjuntos del usuario conservan su número (data:ADJ_n); las fotos extraídas van al final
      return src.reduce(function (p, f) {
        return p.then(function () {
          if (/^image\//.test(f.type)) {
            return A.post('/api/media', { type: f.type, data: f.data }).then(function (j) { files.push({ name: f.name, type: f.type, media: j.url }); });
          }
          if (f.type === 'application/pdf') {
            say('Leyendo ' + f.name + ' y buscando sus fotos…');
            return A.pdfAttachment(f).then(function (r) {
              files.push(pdfBytes <= PDF_INLINE ? { name: f.name, type: f.type, data: f.data } : { name: f.name, type: 'text/plain', text: r.text });
              return r.photos.reduce(function (q, ph) {
                return q.then(function () { return A.upload(ph.canvas, { withType: true }); }).then(function (u) { extra.push({ name: ph.name, type: u.type, media: u.url, extraido: true }); });
              }, Promise.resolve()).then(function () {
                if (r.photos.length) say('Extraje ' + r.photos.length + ' imágenes de ' + f.name + '; Claude podrá usarlas en las slides.');
              });
            });
          }
        });
      }, Promise.resolve()).then(function () {
        files = files.concat(extra);
        if (pdfBytes > PDF_INLINE) say('Los PDF son pesados: Claude leerá su texto y sus fotos (no el diseño de cada página).');
      });
    }).then(function () {
      job.fase = 'planificando';
      say('Revisando la biblioteca de slides… Claude está ' + (opt.web ? 'investigando en internet y ' : '') + 'diseñando la estructura…');
      return A.post('/api/crear/plan', { brief: brief, data: data, files: files, base: opt.base || '', largo: +opt.largo || 0, web: !!opt.web });
    }).then(function (p) {
      plan = p;
      say('Biblioteca: ' + p.biblioteca.slides + ' slides de ' + p.biblioteca.decks + ' presentaciones y plantillas.');
      if (p.investigacion) say('Investigación lista: las slides usarán esos datos con sus fuentes.');
      var urls = [];
      p.items.forEach(function (it) { (it.fotosWeb || []).forEach(function (f) { if (urls.indexOf(f.url) < 0) urls.push(f.url); }); });
      if (!urls.length) return;
      say('Descargando ' + urls.length + ' fotos encontradas en internet…');
      return A.post('/api/crear/fotos', { urls: urls.slice(0, 24) }).then(function (r) {
        var ok = 0;
        p.items.forEach(function (it) {
          it.web = (it.fotosWeb || []).filter(function (f) { return r.fotos[f.url]; }).map(function (f) { return { media: r.fotos[f.url], desc: f.desc }; });
        });
        Object.keys(r.fotos).forEach(function (u) { if (r.fotos[u]) ok++; });
        say(ok + ' de ' + urls.length + ' fotos descargadas.');
      }).catch(function (e) { say('No se pudieron descargar las fotos de internet (' + e.message + ').'); });
    }).then(function () {
      var p = plan;
      job.titulo = String(opt.titulo || '').trim() || p.titulo;
      job.estructura = p.estructura;
      job.total = p.items.length;
      job.slides = p.items.map(function (it) { return { proposito: it.proposito, accion: it.accion, origen: it.src.title + ' · slide ' + it.src.n, estado: it.accion === 'reusar' ? 'listo' : 'pendiente' }; });
      say('Estructura lista: ' + p.items.length + ' slides sobre la base “' + p.base.title + '”.');
      var outline = p.items.map(function (it, k) { return (k + 1) + '. ' + it.proposito; }).join('\n');
      var out = p.items.map(function (it) { return { src: it.src }; }); // reusadas (y respaldo si una falla)
      var toAdapt = [];
      p.items.forEach(function (it, k) { if (it.accion !== 'reusar') toAdapt.push(k); });
      job.hechas = p.items.length - toAdapt.length;
      job.fase = 'generando';
      say('Generando ' + toAdapt.length + ' slides (' + CONCURRENCY + ' en paralelo)…');
      return A.pool(toAdapt, CONCURRENCY, function (k) {
        var it = p.items[k];
        job.slides[k].estado = 'generando'; draw();
        // PDFs embebidos solo si esta slide lee los adjuntos (los índices se conservan)
        var fs = files.map(function (f) { return it.usa_adjuntos || f.type !== 'application/pdf' ? f : { name: f.name, type: 'text/plain', text: '' }; });
        return A.post('/api/crear/slide', { item: it, idx: k, total: p.items.length, brief: brief, data: data, files: fs, outline: outline, investigacion: p.investigacion, base: p.base.path, ficha: p.ficha })
          .then(function (r) { out[k] = { html: r.html }; job.slides[k].estado = 'listo'; })
          .catch(function (e) { job.slides[k].estado = 'error'; say('Slide ' + (k + 1) + ': no se pudo adaptar (' + e.message + '); quedó la slide de origen para editar a mano.'); })
          .then(function () { job.hechas++; draw(); });
      }).then(function () {
        job.fase = 'armando'; say('Armando la presentación…');
        return A.post('/api/crear/guardar', { titulo: job.titulo, base: p.base.path, ficha: p.ficha, slides: out });
      });
    }).then(function (r) { job.path = r.path; });

    return work.then(function () { job.fase = 'listo'; say('¡Presentación lista!'); },
      function (e) { job.fase = 'error'; job.error = e.message; say('Error: ' + e.message); })
      .then(function () { clearInterval(tick); draw(); return job; });
  }

  root.AlmaCrear = { run: run };
})(this);
