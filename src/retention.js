// Conservation des données : décision pure, sans effet de bord (testée).
//
// Règle (décision du 2026-11-27) : effacement après 6 mois sans connexion ET sans
// abonnement actif, avec deux avertissements, J-30 et J-7.
//
// Garanties, quelle que soit la date à laquelle la tâche tourne :
//   - au moins 30 jours entre le premier avertissement et l'effacement ;
//   - au moins 7 jours entre l'avertissement J-7 et l'effacement ;
//   - un avertissement envoyé AVANT la dernière activité (connexion ou fin
//     d'abonnement) ne compte plus : tout recommence ;
//   - sans email, pas d'avertissement, donc jamais d'effacement.
//
// Entrée : une ligne de public.retention_candidates().

const DAY_MS = 24 * 60 * 60 * 1000;

function decideRetention(candidate, now = new Date()) {
  if (!candidate || !candidate.email) return { action: 'skip', reason: 'no_email' };
  const t = now.getTime();
  const lastActivity = Date.parse(candidate.last_activity_at);
  const eraseAfter = Date.parse(candidate.erase_after);
  if (Number.isNaN(lastActivity) || Number.isNaN(eraseAfter)) return { action: 'skip', reason: 'invalid_dates' };

  const valid = (value) => {
    const ts = value ? Date.parse(value) : NaN;
    return !Number.isNaN(ts) && ts > lastActivity ? ts : null;
  };
  const warn30 = valid(candidate.warn30_sent_at);
  const warn7 = valid(candidate.warn7_sent_at);

  if (!warn30) {
    if (t < eraseAfter - 30 * DAY_MS) return { action: 'wait' };
    return { action: 'warn30', eraseOn: new Date(Math.max(eraseAfter, t + 30 * DAY_MS)) };
  }

  const planned = Math.max(eraseAfter, warn30 + 30 * DAY_MS);
  if (!warn7) {
    if (t < planned - 7 * DAY_MS) return { action: 'wait' };
    return { action: 'warn7', eraseOn: new Date(Math.max(planned, t + 7 * DAY_MS)) };
  }

  const eraseAt = Math.max(planned, warn7 + 7 * DAY_MS);
  return t >= eraseAt ? { action: 'erase' } : { action: 'wait' };
}

module.exports = { decideRetention, DAY_MS };
