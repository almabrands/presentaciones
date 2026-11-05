// Acceso en producción (modo Supabase): el navegador guarda el access token de Supabase Auth (login con Google)
// en la cookie "alma_at" (ver index.html y core/editor.js). El servidor lo verifica contra Supabase y exige que
// el correo esté en ALLOWED_EMAILS (si la lista está vacía, basta con haber iniciado sesión).
// El servidor usa SUPABASE_SERVICE_ROLE_KEY para la base: la base queda cerrada al público (RLS) y solo
// se entra a través de esta API. En modo local (sin SUPABASE_URL) no hay control de acceso.
const COOKIE = 'alma_at';
const cache = new Map(); // token → { email, until }

function allowed() {
  return (process.env.ALLOWED_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

let _client;
function client() {
  if (!_client) {
    const { createClient } = require('@supabase/supabase-js');
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _client;
}

// → email del usuario si el token es válido y tiene acceso; si no, null
async function userOf(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.email;
  const { data, error } = await client().auth.getUser(token);
  const email = !error && data && data.user && data.user.email ? data.user.email.toLowerCase() : null;
  const list = allowed();
  const ok = email && (!list.length || list.includes(email)) ? email : null;
  cache.set(token, { email: ok, until: Date.now() + (ok ? 5 * 60e3 : 30e3) });
  if (cache.size > 500) for (const [k, v] of cache) if (v.until < Date.now()) cache.delete(k);
  return ok;
}

// middleware: API → 401 JSON; páginas → redirige al inicio (donde está el login)
function guard({ page = false } = {}) {
  return async (req, res, next) => {
    if (!process.env.SUPABASE_URL) return next();
    try {
      const email = await userOf(req);
      if (email) { req.user = email; return next(); }
    } catch (e) { console.error('auth:', e.message); }
    if (page) return res.redirect(302, '/');
    res.status(401).json({ error: 'Tu sesión expiró o no tienes acceso. Recarga la página e inicia sesión con Google.' });
  };
}

module.exports = { guard, userOf, COOKIE };
