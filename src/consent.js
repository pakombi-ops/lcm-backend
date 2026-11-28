// Consentement explicite (données pouvant révéler la santé) : contrôle serveur.
//
// L'app demande l'accord au premier usage du coach ; la base l'enregistre
// (table user_consents, fonction has_consent — migration 2026-11-28-consents.sql
// du dépôt de l'app). Ici, le serveur refuse le coach sans accord en cours :
//   - 403 { error: 'consent_required', purpose } : pas d'accord, ou accord retiré ;
//   - 503 { error: 'consent_check_failed' } : vérification impossible (on refuse
//     plutôt que de traiter le message sans preuve d'accord).
// À placer APRÈS requireUser (req.user.id vient du jeton, jamais du corps).
const CONSENT_PURPOSES = ['journal', 'coach'];

function createRequireConsent(supabase, purpose) {
  if (!CONSENT_PURPOSES.includes(purpose)) throw new Error(`purpose inconnu : ${purpose}`);
  return async function requireConsent(req, res, next) {
    try {
      const { data, error } = await supabase.rpc('has_consent', { p_user_id: req.user.id, p_purpose: purpose });
      if (error) {
        console.error('Erreur has_consent:', error.message);
        return res.status(503).json({ error: 'consent_check_failed' });
      }
      if (data !== true) return res.status(403).json({ error: 'consent_required', purpose });
      next();
    } catch (err) {
      console.error('Erreur has_consent:', err.message);
      res.status(503).json({ error: 'consent_check_failed' });
    }
  };
}

module.exports = { createRequireConsent, CONSENT_PURPOSES };
