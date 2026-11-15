// Quota de messages gratuits : compté PAR LE SERVEUR (clé service), jamais par le client.
// Réservation atomique par comparaison-échange : on n'écrit messages_used = n+1 que si la
// valeur lue n est encore celle de la base. Deux requêtes simultanées ne peuvent pas
// consommer le même message. Aucune modification de base nécessaire.
const FREE_LIMIT = 10;
const ACTIVE_LIKE_STATUSES = ['trialing', 'active'];
const MAX_TRIES = 6;

function createQuota(supabase, { freeLimit = FREE_LIMIT } = {}) {
  async function isEntitled(userId) {
    const { data, error } = await supabase
      .from('entitlements')
      .select('status, access_expires_at')
      .eq('supabase_user_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!ACTIVE_LIKE_STATUSES.includes(data?.status)) return false;
    // Accès à durée fixe (La Transmission) : une date de fin dépassée ne donne plus accès,
    // même si la tâche expire_fixed_term_access n'est pas encore passée.
    if (data.access_expires_at && new Date(data.access_expires_at) <= new Date()) return false;
    return true;
  }

  async function readUsed(userId) {
    const { data, error } = await supabase
      .from('ai_quota').select('messages_used').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data ? data.messages_used ?? 0 : null;
  }

  // Retourne { ok, premium, used, limit } ou { ok:false, reason: 'limit' | 'busy' }.
  async function reserve(userId) {
    if (await isEntitled(userId)) return { ok: true, premium: true, used: null, limit: null };
    for (let i = 0; i < MAX_TRIES; i++) {
      const used = await readUsed(userId);
      if (used === null) {
        const { error } = await supabase.from('ai_quota')
          .insert({ user_id: userId, messages_used: 1, is_premium: false, updated_at: new Date().toISOString() });
        if (!error) return { ok: true, premium: false, used: 1, limit: freeLimit };
        if (error.code !== '23505') throw error; // conflit = ligne créée entre-temps : on relit
        continue;
      }
      if (used >= freeLimit) return { ok: false, reason: 'limit', used, limit: freeLimit };
      const { data, error } = await supabase.from('ai_quota')
        .update({ messages_used: used + 1, updated_at: new Date().toISOString() })
        .eq('user_id', userId).eq('messages_used', used).select('messages_used');
      if (error) throw error;
      if (Array.isArray(data) && data.length === 1) return { ok: true, premium: false, used: used + 1, limit: freeLimit };
      // quelqu'un a modifié la valeur entre la lecture et l'écriture : on recommence
    }
    return { ok: false, reason: 'busy', used: null, limit: freeLimit };
  }

  // Rend le message si le fournisseur (Claude) a échoué. Au mieux : ne lève jamais.
  async function refund(userId) {
    try {
      for (let i = 0; i < MAX_TRIES; i++) {
        const used = await readUsed(userId);
        if (!used) return;
        const { data, error } = await supabase.from('ai_quota')
          .update({ messages_used: used - 1, updated_at: new Date().toISOString() })
          .eq('user_id', userId).eq('messages_used', used).select('messages_used');
        if (!error && Array.isArray(data) && data.length === 1) return;
      }
    } catch (e) { console.error('refund quota:', e.message); }
  }

  return { reserve, refund, isEntitled, freeLimit };
}

module.exports = { createQuota, FREE_LIMIT };
