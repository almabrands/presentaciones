/* ═══════════════════════════════════════════════════════════════════
   Editor de presentaciones Almabrands
   - ?print=1  → render limpio para PDF (lo usa el servidor)
   - ?thumb=1  → solo primera slide (miniaturas del panel)
   - sin query → modo edición: textos, fotos, slides, guardado y PDF
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var SCRIPT = document.currentScript;
  var BASE = SCRIPT ? SCRIPT.src.replace(/editor\.js[^/]*$/, '') : '../core/';
  var Q = new URLSearchParams(location.search);
  var MODE = Q.has('print') ? 'print' : Q.has('thumb') ? 'thumb' : 'edit';
  var root = document.documentElement;
  var NS = 'http://www.w3.org/2000/svg';
  root.classList.add('m-' + MODE);

  function $(s, el) { return (el || document).querySelector(s); }
  function $$(s, el) { return [].slice.call((el || document).querySelectorAll(s)); }
  function h(tag, attrs, html) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  }

  /* ───────── gráficos: el texto es la fuente de verdad ───────── */
  function num(t) { var m = String(t || '').replace(/\./g, '').replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 0; }
  function renderCharts(scope) {
    $$('.bars', scope).forEach(function (b) {
      var max = parseFloat(b.getAttribute('data-max')) || 100;
      $$('.s', b).forEach(function (s) {
        var i = s.querySelector('i'); if (!i) return;
        var v = num((s.querySelector('b') || s).textContent);
        i.style.setProperty('--v', Math.max(0, Math.min(100, v / max * 100)).toFixed(2));
      });
    });
    $$('.donut', scope).forEach(function (d) {
      var lis = $$('.legend li', d);
      var vals = lis.map(function (li) { return num((li.querySelector('b') || li).textContent); });
      var tot = vals.reduce(function (a, b) { return a + b; }, 0) || 1;
      var svg = d.querySelector('svg');
      if (!svg) { svg = document.createElementNS(NS, 'svg'); d.insertBefore(svg, d.firstChild); }
      svg.setAttribute('viewBox', '0 0 100 100');
      var r = 38, C = 2 * Math.PI * r, off = 0, w = parseFloat(d.getAttribute('data-grosor')) || 20, out = '';
      vals.forEach(function (v, i) {
        var len = v / tot * C, col = getComputedStyle(lis[i]).getPropertyValue('--c').trim() || '#FF0000';
        out += '<circle cx="50" cy="50" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="' + w +
          '" stroke-dasharray="' + Math.max(0, len - .4).toFixed(3) + ' ' + (C - len + .4).toFixed(3) + '" stroke-dashoffset="' + (-off).toFixed(3) + '"/>';
        off += len;
      });
      svg.innerHTML = out;
    });
  }

  var deck = $('.deck');
  function fit() {
    var s = $('.slide');
    if (s) root.style.setProperty('--s', (s.getBoundingClientRect().width / 1920).toFixed(5));
  }

  if (MODE !== 'edit') {
    renderCharts(document);
    fit();
    window.addEventListener('resize', fit);
    return;
  }

  /* ═════════════════════════ MODO EDICIÓN ═════════════════════════ */
  var PATH = decodeURIComponent(location.pathname.replace(/^\/+/, ''));
  var ON_SERVER = /^https?:/.test(location.protocol);
  var IS_TEMPLATE = /^plantillas\//.test(PATH);
  var dirty = false, saving = false, version = 0, baseMtime = 0, saveTimer = null, undo = [], previewing = false;

  root.appendChild(h('link', { rel: 'stylesheet', href: BASE + 'editor.css', class: 'ed-ui' }));

  /* ───────── iconos (trazo tipo Lucide) ───────── */
  var I = {
    up: '<path d="m18 15-6-6-6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeoff: '<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.4 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.1 6.1C3.5 7.9 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4-.9"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>', left: '<path d="m15 18-6-6 6-6"/>', right: '<path d="m9 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>', img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    fit: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>', bw: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', back: '<path d="m12 19-7-7 7-7M19 12H5"/>',
    pdf: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2zM12 11v6M9 14l3 3 3-3"/>',
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    play: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    al: '<path d="M3 6h18M3 12h12M3 18h16"/>', ac: '<path d="M3 6h18M6 12h12M4 18h16"/>', ar: '<path d="M3 6h18M9 12h12M5 18h16"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    clip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    eraser: '<path d="m7 21-4-4 10-10 8 8-6 6zM22 21H7M5 11l8 8"/>'
  };
  function ic(n) { return '<svg viewBox="0 0 24 24" class="ed-i">' + I[n] + '</svg>'; }

  /* ───────── barra superior ───────── */
  var bar = h('div', { class: 'ed-ui ed-bar' },
    '<a class="ed-btn ghost" href="/" title="Volver al panel">' + ic('back') + '<span>Presentaciones</span></a>' +
    '<input class="ed-title" spellcheck="false" title="Nombre de la presentación">' +
    (IS_TEMPLATE ? '<span class="ed-badge">Editando PLANTILLA</span>' : '') +
    '<span class="ed-count"></span><span class="ed-grow"></span>' +
    '<span class="ed-status"></span>' +
    '<button class="ed-btn" data-cmd="undo" title="Deshacer cambio de estructura (⌘Z fuera de un texto)">' + ic('undo') + '</button>' +
    '<button class="ed-btn ai" data-cmd="ai" title="Generar o reescribir la slide actual con Claude">' + ic('spark') + '<span>IA</span></button>' +
    '<button class="ed-btn" data-cmd="add" title="Insertar slide desde una plantilla">' + ic('plus') + '<span>Slide</span></button>' +
    '<button class="ed-btn" data-cmd="preview" title="Ocultar guías de edición">' + ic('play') + '<span>Vista previa</span></button>' +
    '<button class="ed-btn" data-cmd="print" title="Abrir diálogo de impresión del navegador">' + ic('print') + '</button>' +
    '<button class="ed-btn primary" data-cmd="pdf" title="Generar PDF vectorial 16:9">' + ic('pdf') + '<span>Exportar PDF</span></button>');
  document.body.appendChild(bar);
  var titleInput = $('.ed-title', bar), statusEl = $('.ed-status', bar), countEl = $('.ed-count', bar);
  titleInput.value = document.title;
  titleInput.addEventListener('input', function () { document.title = titleInput.value; change(); });

  var toastEl = h('div', { class: 'ed-ui ed-toast' });
  document.body.appendChild(toastEl);
  var toastT;
  function toast(msg, ms) { toastEl.innerHTML = msg; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('on'); }, ms || 3200); }

  function setStatus(t, cls) { statusEl.textContent = t; statusEl.className = 'ed-status ' + (cls || ''); }

  /* ───────── preparar slides ───────── */
  var TXT_TAGS = /^(P|H[1-6]|SPAN|B|STRONG|EM|I|LI|TD|TH|A|BLOCKQUOTE|LABEL|SMALL)$/;
  function editableHost(el) {
    if (el.matches('svg,script,style,img,br,.ed-ui,.foto,.ico,.pincel,.bar .s i')) return false;
    if (el.closest('.gantt') && !el.matches('.lbl,th')) return false;
    if (el.tagName === 'UL' || el.tagName === 'OL') return true;
    if ((el.tagName === 'TD' || el.tagName === 'TH')) return true;
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return !el.firstElementChild && TXT_TAGS.test(el.tagName) && el.tagName !== 'I';
  }
  function walk(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.namespaceURI === NS) continue;
      if (editableHost(c)) { c.setAttribute('contenteditable', previewing ? 'false' : 'true'); c.setAttribute('spellcheck', 'false'); }
      else walk(c);
    }
  }
  function slideTools(slide) {
    $$(':scope > .ed-ui', slide).forEach(function (e) { e.remove(); });
    slide.appendChild(h('div', { class: 'ed-ui ed-num' }));
    slide.appendChild(h('div', { class: 'ed-ui ed-st' },
      '<button data-act="ai" class="ai" title="Reescribir o crear con Claude">' + ic('spark') + '</button>' +
      '<button data-act="up" title="Subir">' + ic('up') + '</button>' +
      '<button data-act="down" title="Bajar">' + ic('down') + '</button>' +
      '<button data-act="add" title="Insertar slide después">' + ic('plus') + '</button>' +
      '<button data-act="dup" title="Duplicar">' + ic('copy') + '</button>' +
      '<button data-act="hide" title="Ocultar en el PDF">' + ic(slide.hasAttribute('data-oculta') ? 'eyeoff' : 'eye') + '</button>' +
      '<button data-act="del" class="danger" title="Eliminar">' + ic('trash') + '</button>'));
  }
  function prepAll() {
    $$('.slide', deck).forEach(function (s, i) {
      walk($('.canvas', s));
      slideTools(s);
      $('.ed-num', s).textContent = String(i + 1).padStart(2, '0');
      $$('.foto', s).forEach(function (f) { if (!f.hasAttribute('data-hint')) f.setAttribute('data-hint', 'Arrastra o haz clic para agregar imagen'); });
    });
    renderCharts(deck);
    fit();
    updateCount();
  }

  /* ───────── HTML limpio (para guardar / deshacer / duplicar) ───────── */
  function clean(el) {
    $$('.ed-ui', el).forEach(function (e) { e.remove(); });
    $$('[contenteditable]', el).forEach(function (e) { e.removeAttribute('contenteditable'); });
    $$('[spellcheck]', el).forEach(function (e) { e.removeAttribute('spellcheck'); });
    $$('.ed-drag,.ed-hover', el).forEach(function (e) { e.classList.remove('ed-drag', 'ed-hover'); });
    return el;
  }
  function serialize() {
    var doc = clean(root.cloneNode(true));
    doc.classList.remove('m-edit', 'm-preview');
    if (!doc.getAttribute('class')) doc.removeAttribute('class');
    doc.style.removeProperty('--s');
    if (!doc.getAttribute('style')) doc.removeAttribute('style');
    return '<!DOCTYPE html>\n' + doc.outerHTML + '\n';
  }

  /* ───────── deshacer (estructura) ───────── */
  function snapshot() { undo.push(clean(deck.cloneNode(true)).innerHTML); if (undo.length > 40) undo.shift(); }
  function doUndo() {
    var prev = undo.pop();
    if (prev == null) return toast('No hay cambios de estructura para deshacer');
    deck.innerHTML = prev; prepAll(); change();
    toast('Deshecho');
  }

  /* ───────── sesión (producción): mantiene al día la cookie que verifica el servidor ───────── */
  if (MODE === 'edit') fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
    if (!cfg.supabaseUrl) return;
    var sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.min.js';
    sc.onload = function () {
      var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      var set = function (s) {
        if (!s) return;
        document.cookie = 'alma_at=' + encodeURIComponent(s.access_token) + '; Path=/; SameSite=Lax; Max-Age=' + Math.max(60, (s.expires_at || 0) - Math.floor(Date.now() / 1000)) + (location.protocol === 'https:' ? '; Secure' : '');
      };
      sb.auth.onAuthStateChange(function (ev, s) { set(s); });
      sb.auth.getSession().then(function (r) { set(r.data && r.data.session); });
    };
    document.head.appendChild(sc);
  }).catch(function () {});

  /* ───────── guardado ───────── */
  function api(method, url, body) {
    return fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || r.statusText); e.status = r.status; throw e; } return j; }); });
  }
  function change() {
    dirty = true; version++;
    setStatus('Cambios sin guardar', 'warn');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1400);
  }
  var savePromise = null;
  function save(force) {
    clearTimeout(saveTimer);
    if (!ON_SERVER) { downloadHtml(); return Promise.resolve(); }
    if (saving) return savePromise.then(function () { if (dirty) return save(force); });
    saving = true; setStatus('Guardando…');
    var v = version;
    savePromise = api('POST', '/api/save', { path: PATH, html: serialize(), baseMtime: force ? 0 : baseMtime, force: !!force })
      .then(function (r) {
        baseMtime = r.mtime;
        if (version === v) { dirty = false; setStatus('Guardado', 'ok'); }
        else saveTimer = setTimeout(save, 600);
      })
      .catch(function (e) {
        if (e.status === 409) conflict();
        else { setStatus('Error al guardar', 'err'); toast(e.message); }
      })
      .then(function () { saving = false; });
    return savePromise;
  }
  function downloadHtml() {
    var a = h('a', { download: (document.title || 'presentacion') + '.html', href: URL.createObjectURL(new Blob([serialize()], { type: 'text/html' })) });
    a.click(); dirty = false; setStatus('Descargado');
  }
  var conflictEl = null;
  function conflict() {
    setStatus('Conflicto', 'err');
    if (conflictEl) return;
    conflictEl = h('div', { class: 'ed-ui ed-conflict' },
      '<b>Este archivo cambió fuera del editor</b> (por ejemplo, Claude Code lo modificó) y tienes cambios sin guardar aquí.' +
      '<button class="ed-btn" data-c="reload">Recargar (descartar mis cambios)</button>' +
      '<button class="ed-btn primary" data-c="force">Sobrescribir con mis cambios</button>');
    document.body.appendChild(conflictEl);
    conflictEl.addEventListener('click', function (e) {
      var c = e.target.closest('[data-c]'); if (!c) return;
      if (c.dataset.c === 'reload') { dirty = false; reloadKeepingScroll(); }
      else { conflictEl.remove(); conflictEl = null; save(true); }
    });
  }
  function reloadKeepingScroll() {
    try { sessionStorage.setItem('ed-scroll:' + PATH, String(window.scrollY)); } catch (e) {}
    location.reload();
  }
  // recarga en vivo si otro proceso (Claude Code) edita el archivo
  function poll() {
    if (!ON_SERVER || saving || document.hidden) return;
    fetch('/api/stat?path=' + encodeURIComponent(PATH)).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.mtime || !baseMtime || Math.abs(j.mtime - baseMtime) < 2 || saving) return;
      if (dirty) conflict(); else { toast('Actualizando: el archivo cambió en disco…'); setTimeout(reloadKeepingScroll, 300); }
    }).catch(function () {});
  }
  if (ON_SERVER) {
    fetch('/api/stat?path=' + encodeURIComponent(PATH)).then(function (r) { return r.json(); }).then(function (j) { baseMtime = j.mtime || 0; setStatus('Guardado', 'ok'); });
    setInterval(poll, 2000);
  } else setStatus('Archivo local (sin servidor)');
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ───────── navegación ───────── */
  var cur = 0;
  function slides() { return $$('.slide', deck); }
  function updateCount() {
    var all = slides(), mid = innerHeight / 2, best = 0, bd = 1e9;
    all.forEach(function (s, i) { var r = s.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - mid); if (d < bd) { bd = d; best = i; } });
    cur = best; countEl.textContent = (all.length ? cur + 1 : 0) + ' / ' + all.length;
  }
  function go(i) { var all = slides(); i = Math.max(0, Math.min(all.length - 1, i)); if (all[i]) all[i].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  var ticking = false;
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(function () { updateCount(); positionFmt(); ticking = false; }); } }, { passive: true });
  window.addEventListener('resize', function () { fit(); positionFmt(); });

  /* ───────── acciones por slide ───────── */
  deck.addEventListener('click', function (e) {
    var b = e.target.closest('.ed-st [data-act]');
    if (!b) return;
    var s = b.closest('.slide'), act = b.dataset.act;
    if (act === 'add') return openLibrary(s);
    if (act === 'ai') return openAi(s);
    snapshot();
    if (act === 'up' && s.previousElementSibling) deck.insertBefore(s, s.previousElementSibling);
    else if (act === 'down' && s.nextElementSibling) deck.insertBefore(s.nextElementSibling, s);
    else if (act === 'dup') { var c = clean(s.cloneNode(true)); s.after(c); }
    else if (act === 'hide') { s.toggleAttribute('data-oculta'); toast(s.hasAttribute('data-oculta') ? 'Slide oculta: no saldrá en el PDF' : 'Slide visible'); }
    else if (act === 'del') { if (!confirm('¿Eliminar esta slide? (puedes deshacer)')) { undo.pop(); return; } s.remove(); toast('Slide eliminada — usa Deshacer para recuperarla'); }
    else { undo.pop(); return; }
    prepAll(); change();
    if (act === 'up' || act === 'down' || act === 'dup') s.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  /* ───────── barra: comandos ───────── */
  bar.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cmd]'); if (!b) return;
    var c = b.dataset.cmd;
    if (c === 'undo') doUndo();
    else if (c === 'add') openLibrary(slides()[cur]);
    else if (c === 'ai') openAi(slides()[cur]);
    else if (c === 'preview') togglePreview(b);
    else if (c === 'print') { (dirty ? save() : Promise.resolve()).then(function () { window.print(); }); }
    else if (c === 'pdf') exportPdf(b);
  });
  function togglePreview(b) {
    previewing = !previewing;
    root.classList.toggle('m-preview', previewing);
    $$('[contenteditable]', deck).forEach(function (e) { e.setAttribute('contenteditable', previewing ? 'false' : 'true'); });
    b.classList.toggle('on', previewing);
    hideFmt();
  }
  function exportPdf(btn) {
    if (!ON_SERVER) return window.print();
    btn.disabled = true; setStatus('Generando PDF…');
    (dirty || saving ? save() : Promise.resolve())
      .then(function () { return fetch('/api/pdf?path=' + encodeURIComponent(PATH)); })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'No se pudo generar el PDF'); });
        return r.blob().then(function (blob) {
          var a = h('a', { href: URL.createObjectURL(blob), download: (document.title || 'presentacion').replace(/[\/\\:*?"<>|]+/g, '-') + '.pdf' });
          document.body.appendChild(a); a.click(); a.remove();
          setStatus(dirty ? 'Cambios sin guardar' : 'Guardado', dirty ? 'warn' : 'ok');
          toast('PDF listo ✓  (revisa tu carpeta de Descargas)');
        });
      })
      .catch(function (e) { setStatus('Error PDF', 'err'); toast(e.message + ' — abriendo diálogo de impresión', 5000); setTimeout(function () { window.print(); }, 600); })
      .then(function () { btn.disabled = false; });
  }

  /* ───────── edición de texto + barra de formato ───────── */
  var fmt = h('div', { class: 'ed-ui ed-fmt' },
    '<button data-f="bold" title="Negrita"><b>B</b></button><button data-f="italic" title="Cursiva"><i>I</i></button><button data-f="underline" title="Subrayado"><u>U</u></button>' +
    '<span class="ed-sep"></span><span class="ed-sw"></span>' +
    '<button data-f="hilite" title="Destacar (fondo menta)"><span class="ed-hl">ab</span></button>' +
    '<span class="ed-sep"></span><button data-f="smaller" title="Achicar texto del bloque">A−</button><button data-f="bigger" title="Agrandar texto del bloque">A+</button>' +
    '<button data-f="al" title="Alinear izquierda">' + ic('al') + '</button><button data-f="ac" title="Centrar">' + ic('ac') + '</button><button data-f="ar" title="Alinear derecha">' + ic('ar') + '</button>' +
    '<button data-f="clear" title="Quitar formato">' + ic('eraser') + '</button>' +
    '<span class="ed-blk"><span class="ed-sep"></span><span class="ed-lbl">Bloque</span>' +
    '<button data-f="bleft" title="Mover antes">' + ic('left') + '</button><button data-f="bright" title="Mover después">' + ic('right') + '</button>' +
    '<button data-f="bdup" title="Duplicar bloque">' + ic('copy') + '</button><button data-f="bdel" class="danger" title="Eliminar bloque">' + ic('trash') + '</button></span>');
  document.body.appendChild(fmt);
  var editing = null;
  function swatches() {
    var cs = getComputedStyle(root), list = [['--accent', 'Color principal'], ['--accent2', 'Color 2'], ['--accent3', 'Color 3'], ['--ink', 'Negro'], ['--gray', 'Gris'], ['#ffffff', 'Blanco']];
    $('.ed-sw', fmt).innerHTML = list.map(function (p) {
      var c = p[0][0] === '#' ? p[0] : cs.getPropertyValue(p[0]).trim();
      return '<button data-f="color" data-c="' + c + '" title="' + p[1] + '" style="--c:' + c + '"></button>';
    }).join('');
  }
  swatches();
  function blockOf(el) { return el && el.closest('.rep > *'); }
  function positionFmt() {
    if (!editing || !document.contains(editing)) return hideFmt();
    var r = editing.getBoundingClientRect(), fw = fmt.offsetWidth, fh = fmt.offsetHeight;
    var top = r.top - fh - 10; if (top < 70) top = r.bottom + 10;
    fmt.style.top = top + 'px';
    fmt.style.left = Math.max(10, Math.min(innerWidth - fw - 10, r.left)) + 'px';
  }
  function showFmt(el) { editing = el; fmt.classList.add('on'); fmt.classList.toggle('has-blk', !!blockOf(el)); positionFmt(); }
  function hideFmt() { editing = null; fmt.classList.remove('on'); }
  document.addEventListener('focusin', function (e) {
    var t = e.target;
    if (t.isContentEditable && t.closest('.canvas') && !previewing) showFmt(t.closest('[contenteditable="true"]'));
  });
  document.addEventListener('focusout', function () {
    setTimeout(function () { var a = document.activeElement; if (!a || !a.isContentEditable) hideFmt(); }, 120);
  });
  fmt.addEventListener('mousedown', function (e) { e.preventDefault(); });
  fmt.addEventListener('click', function (e) {
    var b = e.target.closest('[data-f]'); if (!b || !editing) return;
    var f = b.dataset.f, el = editing;
    document.execCommand('styleWithCSS', false, true);
    if (f === 'bold' || f === 'italic' || f === 'underline') document.execCommand(f);
    else if (f === 'color') document.execCommand('foreColor', false, b.dataset.c);
    else if (f === 'hilite') document.execCommand('hiliteColor', false, getComputedStyle(root).getPropertyValue('--mint').trim() || '#7DE3C4');
    else if (f === 'clear') document.execCommand('removeFormat');
    else if (f === 'bigger' || f === 'smaller') { var fs = parseFloat(getComputedStyle(el).fontSize); el.style.fontSize = Math.round(fs * (f === 'bigger' ? 1.08 : 1 / 1.08)) + 'px'; }
    else if (f === 'al' || f === 'ac' || f === 'ar') el.style.textAlign = { al: 'left', ac: 'center', ar: 'right' }[f];
    else {
      var blk = blockOf(el); if (!blk) return;
      snapshot();
      if (f === 'bdup') { var c = clean(blk.cloneNode(true)); blk.after(c); }
      else if (f === 'bdel') { blk.remove(); hideFmt(); toast('Bloque eliminado — Deshacer para recuperarlo'); }
      else if (f === 'bleft' && blk.previousElementSibling) blk.parentNode.insertBefore(blk, blk.previousElementSibling);
      else if (f === 'bright' && blk.nextElementSibling) blk.parentNode.insertBefore(blk.nextElementSibling, blk);
      prepAll();
    }
    change(); renderCharts(deck); positionFmt();
  });
  deck.addEventListener('input', function (e) {
    change();
    var ch = e.target.closest && e.target.closest('.bars,.donut');
    if (ch) renderCharts(ch.parentNode);
    positionFmt();
  });
  // pegar como texto plano (evita estilos externos); imágenes van al slot bajo el mouse
  document.addEventListener('paste', function (e) {
    var files = [].slice.call(e.clipboardData.files || []).filter(function (f) { return /^image\//.test(f.type); });
    if (files.length && hoverSlot) { e.preventDefault(); return loadInto(hoverSlot, files[0]); }
    if (e.target.isContentEditable) {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    }
  });

  /* ───────── slots de imagen ───────── */
  var picker = h('input', { type: 'file', accept: 'image/*', class: 'ed-ui', hidden: '' });
  document.body.appendChild(picker);
  var pickTarget = null, hoverSlot = null;
  picker.addEventListener('change', function () { if (picker.files[0] && pickTarget) loadInto(pickTarget, picker.files[0]); picker.value = ''; });
  function pick(slot) { pickTarget = slot; picker.click(); }

  function readImage(file, maxSide) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onerror = rej;
      fr.onload = function () {
        var url = fr.result;
        if (/svg|gif/.test(file.type)) return res(url);
        var img = new Image();
        img.onerror = rej;
        img.onload = function () {
          var MAX = maxSide || 2400, w = img.naturalWidth, hgt = img.naturalHeight, k = Math.min(1, MAX / Math.max(w, hgt));
          if (k === 1 && file.size < (maxSide ? 4e6 : 1.5e6)) return res(url);
          var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(hgt * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(file.type === 'image/png' || file.type === 'image/webp' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', .86));
        };
        img.src = url;
      };
      fr.readAsDataURL(file);
    });
  }
  function loadInto(slot, file) {
    setStatus('Procesando imagen…');
    readImage(file).then(function (url) {
      snapshot();
      slot.style.backgroundImage = 'url("' + url + '")';
      slot.style.backgroundPosition = '';
      slot.classList.add('lleno');
      change(); placeSlotBar();
    }).catch(function () { toast('No se pudo leer la imagen'); });
  }

  var slotBar = h('div', { class: 'ed-ui ed-slotbar' },
    '<button data-s="pick" title="Cambiar imagen">' + ic('img') + '</button>' +
    '<button data-s="fit" title="Cubrir / Contener">' + ic('fit') + '</button>' +
    '<button data-s="bw" title="Blanco y negro">' + ic('bw') + '</button>' +
    '<button data-s="clear" class="danger" title="Quitar imagen">' + ic('x') + '</button>');
  document.body.appendChild(slotBar);
  function placeSlotBar() {
    if (!hoverSlot || previewing) return slotBar.classList.remove('on');
    var r = hoverSlot.getBoundingClientRect();
    slotBar.classList.add('on');
    slotBar.classList.toggle('empty', !hoverSlot.classList.contains('lleno'));
    slotBar.style.top = Math.max(64, r.top + 8) + 'px';
    slotBar.style.left = Math.min(innerWidth - slotBar.offsetWidth - 8, Math.max(8, r.right - slotBar.offsetWidth - 8)) + 'px';
  }
  deck.addEventListener('mouseover', function (e) {
    var s = e.target.closest('.foto');
    if (s && s !== hoverSlot && !previewing) { hoverSlot = s; placeSlotBar(); }
  });
  deck.addEventListener('mouseleave', function (e) {
    if (!slotBar.contains(e.relatedTarget)) { hoverSlot = null; placeSlotBar(); }
  });
  deck.addEventListener('mousemove', function (e) {
    if (hoverSlot && !e.target.closest('.foto') && !slotBar.contains(e.target)) { hoverSlot = null; placeSlotBar(); }
  });
  slotBar.addEventListener('click', function (e) {
    var b = e.target.closest('[data-s]'); if (!b || !hoverSlot) return;
    var s = hoverSlot, a = b.dataset.s;
    if (a === 'pick') return pick(s);
    snapshot();
    if (a === 'fit') s.classList.toggle('contain');
    else if (a === 'bw') s.classList.toggle('bw');
    else if (a === 'clear') { s.style.backgroundImage = ''; s.style.backgroundPosition = ''; s.classList.remove('lleno'); }
    change(); placeSlotBar();
  });
  // clic en slot vacío → elegir; arrastrar slot lleno → reencuadrar
  var pan = null;
  deck.addEventListener('pointerdown', function (e) {
    var s = e.target.closest('.foto'); if (!s || previewing || e.button !== 0) return;
    e.preventDefault();
    var bp = (s.style.backgroundPosition || '50% 50%').split(' ').map(parseFloat);
    pan = { s: s, x: e.clientX, y: e.clientY, px: isNaN(bp[0]) ? 50 : bp[0], py: isNaN(bp[1]) ? 50 : bp[1], moved: false };
    s.setPointerCapture(e.pointerId);
  });
  deck.addEventListener('pointermove', function (e) {
    if (!pan) return;
    var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    if (!pan.moved) { pan.moved = true; if (pan.s.classList.contains('lleno')) snapshot(); }
    if (!pan.s.classList.contains('lleno')) return;
    var r = pan.s.getBoundingClientRect();
    var nx = Math.max(0, Math.min(100, pan.px - dx / r.width * 100)), ny = Math.max(0, Math.min(100, pan.py - dy / r.height * 100));
    pan.s.style.backgroundPosition = nx.toFixed(1) + '% ' + ny.toFixed(1) + '%';
  });
  // en táctil, si el navegador toma el gesto para hacer scroll, se cancela el reencuadre
  deck.addEventListener('pointercancel', function () { pan = null; });
  deck.addEventListener('pointerup', function () {
    if (!pan) return;
    var p = pan; pan = null;
    if (!p.moved) pick(p.s); else if (p.s.classList.contains('lleno')) change();
  });
  deck.addEventListener('dragover', function (e) { var s = e.target.closest('.foto'); if (s) { e.preventDefault(); s.classList.add('ed-drag'); } });
  deck.addEventListener('dragleave', function (e) { var s = e.target.closest('.foto'); if (s) s.classList.remove('ed-drag'); });
  deck.addEventListener('drop', function (e) {
    var s = e.target.closest('.foto'); if (!s) return;
    e.preventDefault(); s.classList.remove('ed-drag');
    var f = e.dataTransfer.files[0];
    if (f && /^image\//.test(f.type)) loadInto(s, f);
  });
  // evitar que soltar una imagen fuera de un slot abra el archivo en la pestaña
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { if (!e.target.closest || !e.target.closest('.foto')) { e.preventDefault(); toast('Suelta la imagen sobre un recuadro de foto'); } });

  /* ───────── carta Gantt: clic alterna celdas ───────── */
  deck.addEventListener('click', function (e) {
    var td = e.target.closest('.gantt td'); if (!td || td.classList.contains('lbl') || previewing) return;
    snapshot();
    if (e.altKey || e.shiftKey) { td.classList.add('on'); td.classList.toggle('alt'); }
    else { td.classList.toggle('on'); td.classList.remove('alt'); }
    change();
  });

  /* ───────── biblioteca de slides ───────── */
  var lib = null, libAfter = null;
  function openLibrary(after) {
    libAfter = after || null;
    if (!lib) {
      lib = h('div', { class: 'ed-ui ed-lib' },
        '<div class="ed-lib-box"><div class="ed-lib-hd"><b>Insertar slide</b><div class="ed-tabs"></div><button class="ed-btn ghost" data-l="close">' + ic('x') + '</button></div>' +
        '<div class="ed-lib-grid"></div></div>');
      document.body.appendChild(lib);
      lib.addEventListener('click', function (e) {
        if (e.target === lib || e.target.closest('[data-l="close"]')) return closeLib();
        var t = e.target.closest('[data-tab]'); if (t) return loadTab(t.dataset.tab);
        var c = e.target.closest('.ed-lib-card'); if (c) insertFromLib(c);
      });
    }
    lib.classList.add('on');
    var tabs = $('.ed-tabs', lib);
    if (!ON_SERVER) { tabs.innerHTML = ''; return loadTab(null); }
    api('GET', '/api/list').then(function (j) {
      var mine = (($('meta[name="deck-template"]') || {}).content) || '';
      tabs.innerHTML = '<button data-tab="__self">Esta presentación</button>' + j.plantillas.map(function (p) {
        return '<button data-tab="' + p.path + '">' + p.title.replace(/</g, '&lt;') + '</button>';
      }).join('');
      var first = j.plantillas.filter(function (p) { return p.template === mine; })[0] || j.plantillas[0];
      loadTab(first ? first.path : '__self');
    });
  }
  function closeLib() { lib.classList.remove('on'); }
  var libSlides = [];
  function loadTab(path) {
    $$('[data-tab]', lib).forEach(function (b) { b.classList.toggle('on', b.dataset.tab === path); });
    var grid = $('.ed-lib-grid', lib);
    grid.innerHTML = '<p class="ed-muted">Cargando…</p>';
    var get = path && path !== '__self'
      ? fetch('/' + path).then(function (r) { return r.text(); }).then(function (t) { return new DOMParser().parseFromString(t, 'text/html'); })
      : Promise.resolve({ querySelectorAll: function () { return clean(deck.cloneNode(true)).querySelectorAll('.slide'); } });
    get.then(function (doc) {
      libSlides = [].slice.call(doc.querySelectorAll('.slide'));
      var blank = h('section', { class: 'slide' }, '<div class="canvas"><img class="logo" src="../core/assets/logo-almabrands.png" alt="almabrands"></div>');
      libSlides.push(blank);
      grid.innerHTML = '';
      libSlides.forEach(function (s, i) {
        var card = h('button', { class: 'ed-lib-card', 'data-i': i });
        var frame = h('div', { class: 'ed-lib-frame' });
        var cv = document.importNode(s.querySelector('.canvas'), true);
        frame.appendChild(cv); card.appendChild(frame);
        card.appendChild(h('span', {}, i === libSlides.length - 1 ? 'Slide en blanco' : String(i + 1).padStart(2, '0')));
        grid.appendChild(card);
      });
      renderCharts(grid);
      libScale();
    });
  }
  // en pantallas chicas las miniaturas se adaptan al ancho disponible
  function libScale() {
    var grid = lib && $('.ed-lib-grid', lib), fr = grid && $('.ed-lib-frame', grid);
    if (fr) grid.style.setProperty('--ls', (fr.clientWidth / 1920).toFixed(4));
  }
  window.addEventListener('resize', function () { if (lib && lib.classList.contains('on')) libScale(); });
  function insertFromLib(card) {
    var src = libSlides[+card.dataset.i]; if (!src) return;
    snapshot();
    var s = clean(document.importNode(src, true));
    s.removeAttribute('data-oculta');
    if (libAfter && libAfter.parentNode === deck) libAfter.after(s); else deck.appendChild(s);
    closeLib(); prepAll(); change();
    setTimeout(function () { s.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50);
  }

  /* ───────── IA: generar / reescribir slides con Claude ───────── */
  var aiBox = null, aiSlide = null, aiBusy = false;
  function openAi(slide) {
    if (!ON_SERVER) return toast('La IA necesita el servidor local (npm start)');
    if (!slide) return;
    aiSlide = slide;
    if (!aiBox) {
      aiBox = h('div', { class: 'ed-ui ed-ai' },
        '<form class="ed-ai-box"><div class="ed-ai-hd">' + ic('spark') + '<b>Generar con Claude</b><span class="ed-ai-st"></span><button type="button" class="ed-btn ghost" data-x>' + ic('x') + '</button></div>' +
        '<div class="ed-ai-login" hidden></div>' +
        '<label class="ed-ai-l">¿Qué quieres?</label>' +
        '<textarea class="ed-ai-p" rows="4" placeholder="Ej: Convierte esta slide en 3 tarjetas con los beneficios del programa, con un título rojo y una frase de cierre."></textarea>' +
        '<div class="ed-ai-att"><label class="ed-btn ed-ai-file">' + ic('clip') + '<span>Adjuntar imágenes, PDF o texto</span><input type="file" multiple accept="image/*,application/pdf,.txt,.csv,.md,.json,.tsv,text/*" hidden></label>' +
        '<span class="ed-ai-hint">o arrastra / pega archivos aquí</span><div class="ed-ai-chips"></div></div>' +
        '<div class="ed-ai-modes"><label><input type="radio" name="m" value="replace" checked> Reescribir esta slide</label><label><input type="radio" name="m" value="new"> Crear slide nueva después</label></div>' +
        '<label class="ed-ai-web"><input type="checkbox" class="ed-ai-w"> 🌐 Buscar en internet <small>datos reales y fotos (más lento)</small></label>' +
        '<details class="ed-ai-dt"><summary>Datos de apoyo (opcional)</summary><textarea class="ed-ai-d" rows="5" placeholder="Pega aquí cifras, textos, una tabla copiada desde Excel…"></textarea></details>' +
        '<div class="ed-ai-ft"><span class="ed-ai-msg"></span><button type="button" class="ed-btn" data-x>Cancelar</button><button class="ed-btn primary" type="submit">' + ic('spark') + '<span>Generar</span></button></div></form>');
      document.body.appendChild(aiBox);
      aiBox.addEventListener('click', function (e) { if (!aiBusy && (e.target === aiBox || e.target.closest('[data-x]'))) closeAi(); });
      $('.ed-ai-file input', aiBox).addEventListener('change', function () { addAiFiles(this.files); this.value = ''; });
      var box = $('.ed-ai-box', aiBox);
      box.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); box.classList.add('drag'); });
      box.addEventListener('dragleave', function (e) { if (!box.contains(e.relatedTarget)) box.classList.remove('drag'); });
      box.addEventListener('drop', function (e) { e.preventDefault(); e.stopPropagation(); box.classList.remove('drag'); addAiFiles(e.dataTransfer.files); });
      aiBox.addEventListener('paste', function (e) {
        var fs = [].slice.call(e.clipboardData.files || []);
        if (fs.length) { e.preventDefault(); e.stopPropagation(); addAiFiles(fs); }
      });
      $('.ed-ai-chips', aiBox).addEventListener('click', function (e) {
        var x = e.target.closest('[data-rm]'); if (!x) return;
        aiFiles.splice(+x.dataset.rm, 1); renderAiFiles();
      });
      $('.ed-ai-p', aiBox).addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runAi(); } });
      // si el prompt habla de internet / datos reales, se activa sola la búsqueda (salvo que el usuario la haya tocado)
      var webCk = $('.ed-ai-w', aiBox);
      webCk.addEventListener('change', function () { webCk.dataset.manual = '1'; });
      $('.ed-ai-p', aiBox).addEventListener('input', function () {
        if (!webCk.dataset.manual) webCk.checked = /internet|\bweb\b|busca|online|en l[ií]nea|informaci[oó]n real|datos reales|real(es)? de|actual(es|izad)|noticia|sitio|redes sociales|google/i.test(this.value);
      });
      $('form', aiBox).addEventListener('submit', function (e) { e.preventDefault(); runAi(); });
    }
    aiBox.classList.add('on');
    $('.ed-ai-msg', aiBox).textContent = '';
    setTimeout(function () { $('.ed-ai-p', aiBox).focus(); }, 30);
    var st = $('.ed-ai-st', aiBox), login = $('.ed-ai-login', aiBox);
    st.textContent = 'verificando…'; st.className = 'ed-ai-st';
    api('GET', '/api/ai/status').then(function (j) {
      st.textContent = (j.provider === 'api' ? 'API Anthropic' : 'Tu cuenta de Claude') + (j.ready ? ' · lista' : ' · no disponible');
      st.className = 'ed-ai-st ' + (j.ready ? 'ok' : 'err'); st.title = j.detail || '';
      login.hidden = j.ready;
      if (!j.ready) {
        login.innerHTML = '<b>' + (j.detail || 'IA no disponible') + '</b>' + (j.needsLogin && j.bin
          ? '<br>Inicia sesión una vez abriendo la app <b>Terminal</b> y ejecutando:<code>' + (j.loginCmd || '"' + j.bin + '" auth login').replace(/</g, '&lt;') + '</code>Luego vuelve a abrir esta ventana.'
          : j.provider === 'api' ? '<br>Define <code>ANTHROPIC_API_KEY</code> en el archivo <code>.env</code> y reinicia el servidor.' : '');
      }
    }).catch(function () { st.textContent = 'sin conexión'; st.className = 'ed-ai-st err'; });
  }
  var aiFiles = [];
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function addAiFiles(list) {
    [].slice.call(list || []).forEach(function (f) {
      if (aiFiles.length >= 10) return toast('Máximo 10 adjuntos');
      if (f.type === 'image/svg+xml') return toast('SVG no soportado por Claude: expórtalo como PNG');
      if (/^image\//.test(f.type)) {
        // se reduce a 1600 px: suficiente para que Claude la lea y liviana para insertarla
        readImage(f, 1600).then(function (url) {
          var m = url.match(/^data:([^;]+);base64,(.*)$/);
          aiFiles.push({ name: f.name || 'imagen.png', type: m[1], data: m[2], size: m[2].length * .75, thumb: url }); renderAiFiles();
        }).catch(function () { toast('No se pudo leer ' + f.name); });
      } else if (f.type === 'application/pdf') {
        if (f.size > 20 * 1048576) return toast(f.name + ' supera 20 MB');
        var fr = new FileReader();
        fr.onload = function () { aiFiles.push({ name: f.name, type: f.type, data: fr.result.split(',')[1], size: f.size }); renderAiFiles(); };
        fr.readAsDataURL(f);
      } else if (/^text\/|json|csv/.test(f.type) || /\.(txt|csv|md|json|tsv)$/i.test(f.name)) {
        f.text().then(function (t) {
          var d = $('.ed-ai-d', aiBox); d.value = (d.value ? d.value + '\n\n' : '') + '# ' + f.name + '\n' + t;
          $('.ed-ai-dt', aiBox).open = true; toast(f.name + ' agregado a “Datos de apoyo”');
        });
      } else toast('Tipo no soportado: ' + f.name);
    });
  }
  function renderAiFiles() {
    $('.ed-ai-chips', aiBox).innerHTML = aiFiles.map(function (f, i) {
      var esc = f.name.replace(/[<&"]/g, '');
      return '<span class="ed-chip">' + (f.thumb ? '<img src="' + f.thumb + '" alt="">' : '<b class="pdf">PDF</b>') +
        '<span>' + esc + '<small>' + fmtSize(f.size) + '</small></span><button type="button" data-rm="' + i + '" title="Quitar">' + ic('x') + '</button></span>';
    }).join('');
  }
  function closeAi() { if (aiBox) aiBox.classList.remove('on'); }
  // adjuntos de ✨ en pasos cortos (requests < 4,5 MB para Vercel): las imágenes se suben antes al banco media/
  // y de cada PDF se sacan sus fotos en el navegador (pdf.js, core/pdf-import.js); el PDF va embebido si es liviano, si no su texto.
  var pdfLib = null;
  function loadPdfImport() {
    if (window.AlmaImport) return Promise.resolve(window.AlmaImport);
    if (!pdfLib) pdfLib = new Promise(function (res, rej) {
      var sc = document.createElement('script'); sc.src = '/core/pdf-import.js';
      sc.onload = function () { res(window.AlmaImport); }; sc.onerror = function () { rej(new Error('No se pudo cargar el lector de PDF')); };
      document.head.appendChild(sc);
    });
    return pdfLib;
  }
  function prepAiFiles(list, say) {
    var out = [], extra = [];
    var pdfBytes = list.filter(function (f) { return f.type === 'application/pdf'; }).reduce(function (t, f) { return t + f.data.length; }, 0);
    return list.reduce(function (p, f) {
      return p.then(function () {
        if (/^image\//.test(f.type)) {
          say('Subiendo ' + f.name + '…');
          return api('POST', '/api/media', { type: f.type, data: f.data }).then(function (j) { out.push({ name: f.name, type: f.type, media: j.url }); });
        }
        if (f.type !== 'application/pdf') { out.push({ name: f.name, type: f.type, data: f.data }); return; }
        say('Leyendo ' + f.name + ' y buscando sus fotos…');
        return loadPdfImport().then(function (A) { return A.pdfAttachment(f).then(function (r) {
          out.push(pdfBytes <= 2.5e6 ? { name: f.name, type: f.type, data: f.data } : { name: f.name, type: 'text/plain', text: r.text });
          return r.photos.reduce(function (q, ph) {
            return q.then(function () { return A.upload(ph.canvas, { withType: true }); }).then(function (u) { extra.push({ name: ph.name, type: u.type, media: u.url, extraido: true }); });
          }, Promise.resolve());
        }); });
      });
    }, Promise.resolve()).then(function () { say('Claude está diseñando la slide…'); return out.concat(extra); });
  }
  function runAi() {
    if (aiBusy || !aiSlide) return;
    var prompt = $('.ed-ai-p', aiBox).value.trim();
    if (!prompt) return $('.ed-ai-p', aiBox).focus();
    var mode = $('input[name="m"]:checked', aiBox).value, msg = $('.ed-ai-msg', aiBox), btn = $('button[type="submit"]', aiBox);
    var target = aiSlide, t0 = Date.now();
    aiBusy = true; btn.disabled = true; aiBox.classList.add('busy');
    var tick = setInterval(function () { msg.textContent = 'Claude está diseñando la slide… ' + Math.round((Date.now() - t0) / 1000) + ' s'; }, 1000);
    msg.classList.remove('err'); msg.textContent = 'Claude está diseñando la slide…';
    var web = $('.ed-ai-w', aiBox).checked;
    if (web) { clearInterval(tick); tick = setInterval(function () { msg.textContent = 'Claude está investigando en internet y diseñando la slide… ' + Math.round((Date.now() - t0) / 1000) + ' s'; }, 1000); }
    prepAiFiles(aiFiles, function (t) { msg.textContent = t; })
      .then(function (files) {
        return api('POST', '/api/ai', { path: PATH, slideHtml: clean(target.cloneNode(true)).outerHTML, prompt: prompt, mode: mode, data: $('.ed-ai-d', aiBox).value, web: web, files: files });
      })
      .then(function (r) {
        var tpl = document.createElement('template'); tpl.innerHTML = r.html.trim();
        var s = tpl.content.querySelector('section.slide');
        if (!s || !s.querySelector('.canvas')) throw new Error('Respuesta sin slide válida');
        snapshot();
        if (mode === 'new' || !target.parentNode) (target.parentNode ? target : deck.lastElementChild).after(s);
        else target.replaceWith(s);
        prepAll(); change();
        if (r.fotosWeb && r.fotosWeb.total) toast('Fotos de internet: ' + r.fotosWeb.ok + ' de ' + r.fotosWeb.total + ' descargadas' + (r.fotosWeb.ok < r.fotosWeb.total ? ' (las otras quedaron como slot vacío)' : ''));
        $('.ed-ai-p', aiBox).value = ''; aiFiles = []; renderAiFiles();
        closeAi();
        setTimeout(function () { s.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
        toast('Slide ' + (mode === 'new' ? 'creada' : 'reescrita') + ' con Claude ✓ — ⌘Z o Deshacer para volver atrás', 5000);
      })
      .catch(function (e) { msg.textContent = e.message; msg.classList.add('err'); })
      .then(function () { clearInterval(tick); aiBusy = false; btn.disabled = false; aiBox.classList.remove('busy'); if (!msg.classList.contains('err')) msg.textContent = ''; });
  }

  /* ───────── teclado ───────── */
  document.addEventListener('keydown', function (e) {
    var inText = e.target.isContentEditable || /INPUT|TEXTAREA/.test(e.target.tagName);
    var mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
    if (e.key === 'Escape') { if (aiBox && aiBox.classList.contains('on') && !aiBusy) closeAi(); else if (lib && lib.classList.contains('on')) closeLib(); else if (inText) e.target.blur(); return; }
    if (inText) return;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
    if (['ArrowDown', 'PageDown', 'ArrowRight'].indexOf(e.key) >= 0) { e.preventDefault(); go(cur + 1); }
    else if (['ArrowUp', 'PageUp', 'ArrowLeft'].indexOf(e.key) >= 0) { e.preventDefault(); go(cur - 1); }
  });

  /* ───────── inicio ───────── */
  prepAll();
  if (document.fonts) document.fonts.ready.then(function () { renderCharts(deck); positionFmt(); });
  try {
    var sy = sessionStorage.getItem('ed-scroll:' + PATH);
    if (sy) { sessionStorage.removeItem('ed-scroll:' + PATH); setTimeout(function () { window.scrollTo(0, +sy); }, 30); }
  } catch (e) {}
  if (window.ResizeObserver) new ResizeObserver(fit).observe(deck);
})();
