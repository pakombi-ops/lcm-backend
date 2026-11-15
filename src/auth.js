// Authentification des appels : jeton Supabase (app) et secret partagé (Make / WordPress).
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Exige un jeton de session Supabase valide : Authorization: Bearer <access_token>.
async function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Connexion requise.' });
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Session invalide.' });
    req.user = data.user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Session invalide.' });
  }
}

// Exige le secret partagé Make (en-tête x-make-secret), comme grant-access.
function requireMakeSecret(req, res, next) {
  if (!safeEqual(req.get('x-make-secret'), process.env.MAKE_SHARED_SECRET)) {
    return res.status(401).json({ error: 'Non autorisé.' });
  }
  next();
}

module.exports = { requireUser, requireMakeSecret };
