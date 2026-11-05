// Generación de slides con Claude (Fase 2).
// Dos proveedores, mismo contrato: generate({ system, user }) → texto.
//   AI_PROVIDER=claude-code  (por defecto) → CLI de Claude Code con tu cuenta (uso local)
//   AI_PROVIDER=api + ANTHROPIC_API_KEY    → API de Anthropic (producción)
// Modelo: AI_MODEL (por defecto claude-opus-5-5 en modo api; el de tu plan en claude-code).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { expandPdfImages, saveBuffer, resolveWebImages } = require('./imagenes');

const ROOT = __dirname;
const { readFicha, normalize, OPCIONES } = require('./ficha');
const { guiaMarca } = require('./estilo');
// trim(): las variables cargadas con `echo … | vercel env add` pueden traer un salto de línea.
// En Vercel no existe la CLI, así que ahí se usa siempre la API.
const PROVIDER = (process.env.VERCEL ? 'api'
  : ((process.env.AI_PROVIDER || '').trim() || (process.env.ANTHROPIC_API_KEY ? 'api' : 'claude-code'))).toLowerCase();
const API_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.AI_EFFORT || 'medium';
const TIMEOUT_MS = 6 * 60 * 1000;

/* ───────── proveedor: CLI de Claude Code ───────── */
function findClaudeBin() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  const home = os.homedir();
  const fixed = [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.npm-global/bin/claude')];
  for (const p of fixed) if (fs.existsSync(p)) return p;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'claude');
    if (dir && fs.existsSync(p)) return p;
  }
  // CLI que trae la app de escritorio de Claude (la versión más nueva)
  const base = path.join(home, 'Library/Application Support/Claude/claude-code');
  try {
    const versions = fs.readdirSync(base).filter((v) => /^\d/.test(v))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      for (const sub of fs.readdirSync(path.join(base, v))) {
        const p = path.join(base, v, sub, 'claude.app/Contents/MacOS/claude');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}

// el CLI hijo no debe heredar la sesión de un Claude Code que lance el servidor
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|CLAUDECODE|ANTHROPIC_BASE_URL)/.test(k)) env[k] = v;
  return env;
}

// Varias cuentas de Claude Code: CLAUDE_PROFILES=default,~/.claude-gmail (en .env).
// "default" es la sesión normal de la CLI; cada carpeta extra es otra cuenta (CLAUDE_CONFIG_DIR).
// Si una cuenta llega a su límite de uso, se pasa a la siguiente hasta que se renueve.
const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir());
function profiles() {
  const list = (process.env.CLAUDE_PROFILES || 'default').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)].map((p) => (p === 'default' ? { id: 'default', dir: null } : { id: p, dir: expandHome(p) }));
}
const profileEnv = (pr) => ({ ...childEnv(), ...(pr.dir ? { CLAUDE_CONFIG_DIR: pr.dir } : {}) });
const loginCmd = (bin, pr) => `${pr.dir ? `CLAUDE_CONFIG_DIR="${pr.dir}" ` : ''}"${bin}" auth login`;
const LIMIT_RE = /session limit|usage limit|weekly limit|hit your .{0,20}limit|limit reached|out of (extra )?usage|credit balance is too low/i;
const blocked = new Map(); // id → { until, msg }

// "resets 4:10pm" → timestamp de la próxima vez que el reloj marque esa hora (si no se entiende: 1 hora)
function resetTime(msg) {
  const m = String(msg).match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return Date.now() + 3600e3;
  let h = +m[1] % 12 + (/pm/i.test(m[3] || '') ? 12 : 0);
  if (!m[3]) h = +m[1];
  const d = new Date(); d.setHours(h, +(m[2] || 0), 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime() + 60e3;
}
const isBlocked = (pr) => { const b = blocked.get(pr.id); if (b && b.until <= Date.now()) blocked.delete(pr.id); return blocked.has(pr.id); };

function authStatus(bin, pr) {
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'status'], { env: profileEnv(pr), timeout: 20000 }, (err, stdout) => {
      try {
        const j = JSON.parse(stdout);
        resolve({ loggedIn: !!j.loggedIn, email: j.email || j.account || '', plan: j.subscriptionType || '' });
      } catch { resolve({ loggedIn: false }); }
    });
  });
}

let statusCache = null;
async function claudeCodeStatus() {
  if (statusCache && Date.now() - statusCache.t < 30000) return statusCache.v;
  const bin = findClaudeBin();
  let v;
  if (!bin) v = { ready: false, detail: 'No se encontró la CLI de Claude Code. Instálala (https://claude.com/claude-code) o define CLAUDE_BIN.' };
  else {
    const prs = profiles();
    const cuentas = await Promise.all(prs.map(async (pr) => {
      const a = await authStatus(bin, pr);
      const b = isBlocked(pr) ? blocked.get(pr.id) : null;
      return { perfil: pr.id, ...a, limite: b ? new Date(b.until).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : '', login: a.loggedIn ? '' : loginCmd(bin, pr) };
    }));
    const activa = cuentas.find((c) => c.loggedIn && !c.limite);
    const desc = (c) => `${c.email || c.perfil}${c.plan ? ' · plan ' + c.plan : ''}${c.limite ? ` (sin uso hasta las ${c.limite})` : ''}${c.loggedIn ? '' : ' (sin sesión)'}`;
    const otras = cuentas.filter((c) => c !== activa);
    if (activa) v = { ready: true, detail: `Cuenta: ${desc(activa)}${otras.length ? ' · respaldo: ' + otras.map(desc).join(', ') : ''}` };
    else if (cuentas.some((c) => !c.loggedIn) && cuentas.some((c) => c.loggedIn)) v = { ready: false, needsLogin: true, detail: `${cuentas.filter((c) => c.limite).map(desc).join(', ')}. Inicia sesión en la cuenta de respaldo para seguir.` };
    else if (cuentas.some((c) => c.loggedIn)) v = { ready: false, detail: `Todas las cuentas llegaron a su límite de uso: ${cuentas.map(desc).join(', ')}` };
    else v = { ready: false, needsLogin: true, detail: 'La CLI de Claude Code no tiene sesión iniciada.' };
    const sinSesion = cuentas.find((c) => !c.loggedIn);
    Object.assign(v, { bin, cuentas, loginCmd: sinSesion ? sinSesion.login : '' });
  }
  statusCache = { t: Date.now(), v };
  return v;
}

async function runClaudeCode(bin, pr, { system, content, web }) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'alma-ai-'));
  const sysFile = path.join(tmp, 'system.md');
  await fsp.writeFile(sysFile, system);
  // con web: solo búsqueda y lectura de páginas (sin archivos ni terminal)
  const tools = web ? ['--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch'] : ['--tools', ''];
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...tools, '--no-session-persistence', '--strict-mcp-config', '--system-prompt-file', sysFile];
  if (process.env.AI_MODEL) args.push('--model', process.env.AI_MODEL);
  try {
    const out = await new Promise((resolve, reject) => {
      // cwd temporal: así no carga CLAUDE.md ni configuración de ningún proyecto
      const p = spawn(bin, args, { cwd: tmp, env: profileEnv(pr) });
      let so = '', se = '';
      const ms = web ? TIMEOUT_MS * 2 : TIMEOUT_MS;
      const timer = setTimeout(() => { p.kill('SIGTERM'); reject(new Error(`Claude tardó demasiado (más de ${Math.round(ms / 60000)} min).`)); }, ms);
      p.stdout.on('data', (d) => (so += d));
      p.stderr.on('data', (d) => (se += d));
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', () => { clearTimeout(timer); resolve({ so, se }); });
      p.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    });
    let j = null;
    for (const line of out.so.split('\n')) {
      try { const ev = JSON.parse(line); if (ev.type === 'result') j = ev; } catch {}
    }
    if (!j) {
      const msg = (out.se || out.so || 'Respuesta inválida de Claude Code').slice(0, 400);
      const e = new Error(msg); e.limit = LIMIT_RE.test(msg); e.auth = /authenticat|login|OAuth/i.test(msg); throw e;
    }
    if (j.is_error) {
      const msg = j.result || 'Error de Claude Code';
      const e = new Error(msg); e.limit = LIMIT_RE.test(msg); e.auth = /authenticat|login|OAuth|api key/i.test(msg); throw e;
    }
    return { text: j.result || '', model: Object.keys(j.modelUsage || {})[0] || 'claude-code', cost: j.total_cost_usd };
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

async function generateClaudeCode(req) {
  const bin = findClaudeBin();
  if (!bin) throw new Error('No se encontró la CLI de Claude Code.');
  const prs = profiles();
  let last = null, limitado = null;
  for (const pr of prs) {
    if (isBlocked(pr)) { limitado = limitado || new Error(blocked.get(pr.id).msg); continue; }
    try {
      return await runClaudeCode(bin, pr, req);
    } catch (e) {
      last = e;
      if (e.limit) {
        blocked.set(pr.id, { until: resetTime(e.message), msg: e.message });
        limitado = e;
        statusCache = null;
        console.log(`Claude Code (${pr.id}): límite de uso → ${prs.length > 1 ? 'pruebo la siguiente cuenta' : 'sin cuentas de respaldo'}`);
        continue;
      }
      if (e.auth) { statusCache = null; continue; }
      throw e;
    }
  }
  if (limitado && last && last.auth) throw new Error(`Tu cuenta de Claude llegó a su límite de uso (${limitado.message.replace(/^.*?(resets?[^·]*)$/i, '$1').trim()}) y la cuenta de respaldo no tiene sesión iniciada: cierra y abre esta ventana para ver cómo iniciarla.`);
  if (last && last.auth && !last.limit) throw new Error('Claude Code no tiene sesión iniciada. Inicia sesión una vez desde la terminal (ver CLAUDE.md).');
  last = last || limitado;
  throw new Error(prs.length > 1 ? `Todas las cuentas de Claude llegaron a su límite de uso. ${last ? last.message : ''}` : (last ? last.message : 'Error de Claude Code'));
}

/* ───────── proveedor: API de Anthropic ───────── */
let client = null;
function apiClient() {
  if (!client) {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod;
    client = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(), timeout: TIMEOUT_MS });
  }
  return client;
}

async function generateApi({ system, content, web }) {
  const Anthropic = require('@anthropic-ai/sdk');
  try {
    // fallbacks "default": si el modelo declina por política, la API reintenta con otro modelo adecuado
    const messages = [{ role: 'user', content }];
    const tools = web ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }, { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 10 }] : undefined;
    let msg;
    // con herramientas web el servidor puede pausar el turno (pause_turn): se reenvía para que continúe
    for (let k = 0; k < 6; k++) {
      msg = await apiClient().beta.messages.stream({
        model: API_MODEL,
        max_tokens: 32000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: EFFORT },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        ...(tools ? { tools } : {}),
        messages,
      }).finalMessage();
      if (msg.stop_reason !== 'pause_turn') break;
      if (messages.length > 1) messages.pop();
      messages.push({ role: 'assistant', content: msg.content });
    }
    if (msg.stop_reason === 'refusal') throw new Error('Claude declinó esta solicitud. Reformula el prompt.');
    if (msg.stop_reason === 'max_tokens') throw new Error('La respuesta quedó incompleta (demasiado larga). Simplifica la slide o el prompt.');
    // con web hay texto antes y después de las búsquedas: lo útil es el último bloque de texto con la respuesta
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { text, model: msg.model, usage: msg.usage };
  } catch (e) {
    const A = Anthropic.default || Anthropic;
    if (e instanceof A.AuthenticationError) throw new Error('ANTHROPIC_API_KEY inválida.');
    if (e instanceof A.RateLimitError) throw new Error('Límite de uso de la API alcanzado; intenta en un momento.');
    if (e instanceof A.APIError) throw new Error(`Error de la API (${e.status}): ${e.message}`);
    throw e;
  }
}

/* ───────── prompt ───────── */
async function buildSystem(deckHtml) {
  const f = readFicha(deckHtml || '');
  const ctx = [f.cliente && `Cliente: ${f.cliente}`, f.tipo && `Tipo: ${f.tipo}`, f.rubros.length && `Rubros: ${f.rubros.join(', ')}`,
    f.segmentos.length && `Segmentos: ${f.segmentos.join(', ')}`, f.fondo && `Fondo: ${f.fondo}`, f.forma && `Forma: ${f.forma}`].filter(Boolean).join('\n');
  const [guide, css] = await Promise.all([
    fsp.readFile(path.join(ROOT, 'CLAUDE.md'), 'utf8'),
    fsp.readFile(path.join(ROOT, 'core/alma.css'), 'utf8'),
  ]);
  const rules = (guide.match(/## Convenciones[\s\S]*?(?=\n## )/) || [guide])[0];
  const theme = ((deckHtml || '').match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  const guia = await guiaMarca();
  return `Eres el diseñador de presentaciones de Almabrands, consultora chilena de marca, propósito y cultura. Editas y creas slides HTML dentro de un sistema visual fijo.

# Formato de respuesta (obligatorio)
- Responde SOLO con un único elemento <section class="slide" data-layout="…"><div class="canvas">…</div></section>. Sin markdown, sin \`\`\`, sin explicaciones antes ni después.
- Usa exclusivamente las clases de alma.css y del tema; estilos inline solo para posición/tamaño (left/top/width/height en px) y ajustes puntuales. Nada de <script> ni <style>.
- El lienzo es 1920×1080 px. Todo el contenido debe caber dentro, con márgenes de al menos ~60 px y sin textos superpuestos. Si el contenido no cabe, resume.
- Conserva el logo/pie de la slide y las imágenes existentes salvo que la instrucción pida cambiarlos. Las URLs "data:IMG_n", "../media/…" y "../core/assets/…" son imágenes ya cargadas: cópialas tal cual (puedes moverlas o reubicarlas en otro slot).
- Archivos adjuntos (imágenes, PDF): úsalos como fuente de contenido y referencia. Cada imagen adjunta (incluidas las fotos extraídas de los PDF) está disponible como "data:ADJ_n": cuando sea pertinente para la slide (fotos de producto, personas, lugares, logos, gráficos del cliente), insértala en un slot <div class="foto lleno" style="background-image:url(data:ADJ_n);…"> (añade "contain" para logos o gráficos); si la slide tiene slots .foto vacíos, llénalos con las imágenes adjuntas que calcen. Nunca transcribas el base64.
- Para imágenes nuevas usa slots vacíos <div class="foto" data-hint="…"> (el usuario sube la foto después). Nunca inventes URLs de imágenes.
- Idioma: español de Chile, tono profesional y claro. No inventes cifras ni nombres: si faltan datos usa marcadores como [cifra] o [nombre].

# Guía de marca (definida por Almabrands; respétala)
${guia || '(sin guía)'}

# Reglas del sistema
${rules}

# alma.css (sistema visual compartido)
${css}

# Tema de esta presentación
${theme}${ctx ? `

# Ficha de esta presentación (contexto de fondo y forma; respétalo)
${ctx}` : ''}`;
}

function stripImages(html) {
  const imgs = [];
  const out = html.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (m) => { imgs.push(m); return `data:IMG_${imgs.length - 1}`; });
  return { out, imgs };
}
const restoreImages = (html, imgs) => html.replace(/data:IMG_(\d+)/g, (m, i) => imgs[+i] || '');

function extractSection(text) {
  const a = text.indexOf('<section'), b = text.lastIndexOf('</section>');
  if (a < 0 || b < a) throw new Error('Claude no devolvió una slide válida. Intenta de nuevo o precisa la instrucción.');
  let s = text.slice(a, b + '</section>'.length);
  if (!/class="slide/.test(s) || !/class="canvas/.test(s)) throw new Error('La respuesta no respeta la estructura de slide.');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+="[^"]*"/gi, '');
  return s;
}

const IMG_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILES = 10, MAX_BYTES = 25 * 1024 * 1024;
// files: adjuntos del usuario + fotos extraídas de sus PDF (extraido: true, no cuentan para los límites).
// only: índices de las imágenes a enviar (las demás se omiten; los índices data:ADJ_n no cambian).
function attachmentBlocks(files, { only } = {}) {
  files = files || [];
  if (files.filter((f) => !f.extraido).length > MAX_FILES) throw new Error(`Máximo ${MAX_FILES} archivos adjuntos.`);
  let total = 0;
  const blocks = [], notes = [];
  files.forEach((f, i) => {
    const data = String(f.data || '').replace(/^data:[^,]*,/, '');
    if (!f.extraido) total += data.length * 0.75;
    if (total > MAX_BYTES) throw new Error('Los adjuntos superan 25 MB en total. Usa menos archivos o más livianos.');
    if (only && !only.has(i)) return;
    if (IMG_TYPES.includes(f.type)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: f.type, data } });
      notes.push(`${i + 1}. ${f.name} — imagen${f.extraido ? ' extraída del PDF' : ''}, disponible como data:ADJ_${i}`);
    } else if (f.type === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: f.name });
      notes.push(`${i + 1}. ${f.name} — PDF (fuente de contenido; sus fotos van como imágenes adjuntas aparte)`);
    } else throw new Error(`Tipo de archivo no soportado: ${f.name}`);
  });
  return { blocks, notes };
}
// las imágenes adjuntas que quedan en la slide se guardan en el banco media/
const restoreAttachments = (html, files) => html.replace(/data:ADJ_(\d+)/g, (m, i) => {
  const f = (files || [])[+i];
  return f && IMG_TYPES.includes(f.type) ? saveBuffer(Buffer.from(String(f.data).replace(/^data:[^,]*,/, ''), 'base64'), f.type) : '';
});

async function complete({ system, content, web }) {
  return PROVIDER === 'api' ? generateApi({ system, content, web }) : generateClaudeCode({ system, content, web });
}

// reglas para cuando la búsqueda en internet está activada (van en el mensaje, no en el system: así se mantiene la caché)
const WEB_RULES = `# Búsqueda en internet (activada)
- Antes de diseñar, investiga en internet (búsqueda web y lectura de páginas) para usar datos reales y actuales: sitio oficial, prensa, redes y fuentes confiables. Reemplaza los marcadores [..] por datos verificados cuando los encuentres; si un dato no aparece, deja el marcador.
- Cita las fuentes en la slide en una línea pequeña (clase p-xs), por ejemplo "Fuentes: sanhenuss.cl, latercera.com".
- Fotos reales: busca imágenes del sitio oficial, prensa o fichas de producto. Al leer una página, pide explícitamente las URLs de sus imágenes (og:image y <img src>). Para insertarlas usa un slot <div class="foto lleno" data-web="URL" data-hint="qué muestra · fuente" style="left:..;top:..;width:..;height:.."> (agrega "contain" a logos o productos recortados). URL: la dirección directa del archivo de imagen (o, si no la tienes, la de la página: el sistema toma su imagen principal). No la pongas en background-image: el sistema descarga la foto y la guarda. Nunca inventes URLs: solo las que viste en páginas consultadas.
- Tu respuesta final sigue siendo SOLO el <section> (sin resumen de la investigación).`;

function extractJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('La IA no devolvió un resultado válido. Intenta de nuevo.');
  try { return JSON.parse(text.slice(a, b + 1)); } catch { throw new Error('No se pudo leer la respuesta de la IA. Intenta de nuevo.'); }
}

async function status() {
  if (PROVIDER === 'api') {
    return { provider: 'api', model: API_MODEL, ready: !!process.env.ANTHROPIC_API_KEY, detail: process.env.ANTHROPIC_API_KEY ? `API de Anthropic · ${API_MODEL}` : 'Falta ANTHROPIC_API_KEY' };
  }
  return { provider: 'claude-code', ...(await claudeCodeStatus()) };
}

// mode: "replace" (reescribir la slide) | "new" (crear slide nueva usando la actual como referencia de estilo)
async function generateSlide({ deckPath, deckHtml: deckHtmlArg, slideHtml, prompt, mode, data, files, web }) {
  if (!prompt || !prompt.trim()) throw new Error('Escribe una instrucción.');
  const deckHtml = deckHtmlArg ?? (deckPath ? await fsp.readFile(deckPath, 'utf8').catch(() => '') : '');
  const system = await buildSystem(deckHtml);
  const { out: cleanSlide, imgs } = stripImages(slideHtml || '');
  attachmentBlocks(files); // valida antes de extraer
  files = await expandPdfImages(files);
  const att = attachmentBlocks(files);
  const user = (mode === 'new'
    ? `Crea una slide NUEVA para esta presentación. Usa esta slide vecina solo como referencia de estilo (no la copies):\n\n${cleanSlide}\n\n`
    : `Esta es la slide actual:\n\n${cleanSlide}\n\nReescríbela aplicando la instrucción.\n\n`) +
    (data ? `Datos aportados por el usuario (úsalos como fuente; no inventes otros):\n<datos>\n${data.slice(0, 60000)}\n</datos>\n\n` : '') +
    (att.notes.length ? `Archivos adjuntos (van antes de este mensaje):\n${att.notes.join('\n')}\n\n` : '') +
    `Instrucción: ${prompt.trim()}` + (web ? `\n\n${WEB_RULES}` : '');
  const content = [...att.blocks, { type: 'text', text: user }];
  const r = await complete({ system, content, web });
  let html = restoreAttachments(restoreImages(extractSection(r.text), imgs), files);
  let fotosWeb = null;
  if (web) ({ html, ...fotosWeb } = await resolveWebImages(html));
  return { html, model: r.model, provider: PROVIDER, fotosWeb };
}

/* ───────── ficha automática ───────── */
async function suggestFicha({ title, slides, ficha }) {
  let budget = 24000;
  const body = slides.map((sl, i) => {
    const t = `${i + 1}.${sl.oculta ? ' (oculta)' : ''} ${sl.titulo ? '[' + sl.titulo + '] ' : ''}${sl.texto.slice(0, 700)}`;
    budget -= t.length; return budget > 0 ? t : '';
  }).filter(Boolean).join('\n');
  const system = `Eres analista de Almabrands (consultora chilena de marca, propósito, investigación y cultura). Completas la ficha de una presentación comercial para poder clasificarla y encontrarla después.
Responde SOLO un objeto JSON, sin texto adicional, con estas claves:
{"cliente": string, "tipo": uno de ${JSON.stringify(OPCIONES.tipo)}, "rubros": [string], "segmentos": [string], "servicios": [subconjunto de ${JSON.stringify(OPCIONES.servicios)}], "estudios": [string], "productos": [string], "etiquetas": [string], "fondo": string, "forma": string}
- rubros: industria del cliente (ej. "Transporte público", "Retail de calzado", "Banca").
- segmentos: públicos o segmentos a los que apunta (ej. "Consumidores NSE C1 35-55", "Líderes y jefaturas").
- estudios: metodologías y estudios incluidos (ej. "Focus groups", "Encuesta cuantitativa", "Purpose Index", "Benchmark").
- productos: entregables o productos ofrecidos (ej. "Manual de identidad", "Programa de talleres", "Arquitectura de marca").
- etiquetas: 3 a 6 palabras clave útiles para buscar.
- fondo: 4 a 7 líneas de qué trata: contexto y desafío del cliente, propuesta, etapas, estudios, entregables, plazos y valores si aparecen.
- forma: 2 a 4 líneas de cómo está construida: estructura de secciones, número de slides, tipos de slide destacados (cifras, gantt, gráficos…), estilo visual y tono.
Usa solo información presente en la presentación; si un dato no aparece, deja "" o [].
Contexto de la marca (servicios y vocabulario):
${(await guiaMarca()).slice(0, 4000)} Respeta los valores que el usuario ya ingresó (no los borres; puedes complementarlos). Español de Chile.`;
  const user = `Título: ${title}\nFicha actual (ingresada por el usuario):\n${JSON.stringify(ficha)}\n\nContenido por slide:\n${body}`;
  const r = await complete({ system, content: [{ type: 'text', text: user }] });
  const j = extractJson(r.text);
  const merged = normalize({ ...ficha, ...Object.fromEntries(Object.entries(normalize(j)).filter(([k, v]) => (Array.isArray(v) ? v.length : v) && !['estado', 'fecha', 'valor', 'responsable', 'plantilla'].includes(k))) });
  for (const k of ['rubros', 'segmentos', 'servicios', 'estudios', 'productos', 'etiquetas']) merged[k] = [...new Set([...(ficha[k] || []), ...merged[k]])];
  if (ficha.cliente) merged.cliente = ficha.cliente;
  if (ficha.tipo) merged.tipo = ficha.tipo;
  return merged;
}

/* ───────── buscador con IA ───────── */
async function searchDecks({ query, decks }) {
  if (!query || !query.trim()) throw new Error('Describe la presentación que necesitas.');
  if (!decks.length) return { resumen: 'Aún no hay presentaciones para comparar.', resultados: [] };
  const catalog = decks.map((d, i) => {
    const f = d.ficha || {};
    const line = (k, v) => (Array.isArray(v) ? v.length : v) ? `${k}: ${Array.isArray(v) ? v.join(', ') : v}` : '';
    return [`### [${i}] ${d.title} (${d.path.startsWith('plantillas/') ? 'plantilla' : 'presentación'}, ${d.slides} slides)`,
      line('Cliente', f.cliente), line('Tipo', f.tipo), line('Estado', f.estado), line('Rubros', f.rubros), line('Segmentos', f.segmentos),
      line('Servicios', f.servicios), line('Estudios', f.estudios), line('Productos', f.productos), line('Etiquetas', f.etiquetas),
      line('Fondo', f.fondo), line('Forma', f.forma), line('Slides', (d.outline || []).join(' · ').slice(0, 700))].filter(Boolean).join('\n');
  }).join('\n\n');
  const system = `Eres el asistente de Almabrands que ayuda a reutilizar presentaciones. Comparas lo que el usuario necesita con un catálogo de presentaciones y plantillas, y recomiendas desde cuál partir.
Calce (0-100): qué tan buena base es para lo pedido, ponderando tipo de presentación, servicios, estudios y productos, rubro y segmento, y estructura. 90+ casi lista; 70-89 buena base con ajustes; 50-69 sirve parcialmente; <50 poco útil.
Responde SOLO un objeto JSON:
{"resumen": "2-3 frases con tu recomendación principal y por qué (nombra las presentaciones por su título, nunca por su número)", "resultados": [{"id": número del catálogo, "calce": entero, "razon": "por qué calza (1-2 frases concretas)", "ajustes": "qué habría que cambiar o agregar (1-2 frases)", "slides_utiles": [títulos de slides que conviene reutilizar, máx. 4]}]}
Incluye como máximo 5 resultados, ordenados de mayor a menor calce, y omite los de calce < 30. No inventes presentaciones. Español de Chile.`;
  const r = await complete({ system, content: [{ type: 'text', text: `Catálogo:\n\n${catalog}\n\n---\nLo que necesito:\n${query.trim()}` }] });
  const j = extractJson(r.text);
  const resultados = (Array.isArray(j.resultados) ? j.resultados : [])
    .map((x) => ({ ...x, deck: decks[+x.id] }))
    .filter((x) => x.deck)
    .map((x) => ({ path: x.deck.path, title: x.deck.title, slides: x.deck.slides, mtime: x.deck.mtime, ficha: x.deck.ficha,
      calce: Math.max(0, Math.min(100, Math.round(+x.calce || 0))), razon: String(x.razon || ''), ajustes: String(x.ajustes || ''),
      slides_utiles: Array.isArray(x.slides_utiles) ? x.slides_utiles.slice(0, 4).map(String) : [] }))
    .sort((a, b) => b.calce - a.calce)
    .slice(0, 5);
  const resumen = String(j.resumen || '').replace(/\s*\[(\d+)\]/g, (m, i) => (decks[+i] ? ` «${decks[+i].title}»` : ''));
  return { resumen, resultados };
}

module.exports = {
  generateSlide, suggestFicha, searchDecks, status, PROVIDER,
  // piezas reutilizadas por crear.js
  complete, extractJson, buildSystem, WEB_RULES, stripImages, restoreImages, extractSection, attachmentBlocks, restoreAttachments,
};
