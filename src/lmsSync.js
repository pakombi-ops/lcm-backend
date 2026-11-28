// Synchronisation de l'accès à la formation WordPress (LifterLMS) avec l'abonnement Stripe.
// Appelée par /api/update-entitlement APRÈS la mise à jour de l'entitlement.
//
// Règles (statut RÉEL de l'abonnement, relu chez Stripe) :
//   canceled, unpaid, paused, incomplete_expired → suspendre (/pc-lms/v1/suspend),
//       sauf si le client a un autre abonnement app actif, en essai ou en retard de paiement ;
//   active / trialing, venant d'un statut suspendu (previousStatus) → réinscrire (/enroll) ;
//   past_due (accès gardé, comme dans l'app), retour de past_due à active,
//   cancel_at_period_end, renouvellement (pas de changement de statut) → rien ;
//   abonnement La Transmission → rien.
//
// Variables Railway : PC_LMS_SECRET (en-tête X-PC-Secret, même valeur que l'option
// WordPress de pc-enrollment) et, en option, PC_LMS_BASE_URL.

const SUSPEND_STATUSES = ['canceled', 'unpaid', 'paused', 'incomplete_expired'];
const ACTIVE_LIKE_STATUSES = ['trialing', 'active'];
// past_due n'en fait pas partie : pendant un retard de paiement la formation n'est
// pas suspendue, il n'y a donc rien à réinscrire quand le paiement passe.
const INACTIVE_PREVIOUS_STATUSES = ['unpaid', 'paused', 'incomplete', 'incomplete_expired', 'canceled'];
const DEFAULT_BASE_URL = 'https://pilierconscient.com';
const TIMEOUT_MS = 10000;

// Remplaçable dans les tests (le fetch global sert aussi aux requêtes de test).
const deps = { fetch: (...args) => fetch(...args) };

/**
 * Décision pure, sans effet de bord.
 * @returns {{ action: 'suspend' | 'enroll' | 'none', reason: string }}
 */
function decideLmsAction({ liveStatus, previousStatus, isTransmission, hasOtherActiveAppSub }) {
  if (isTransmission) return { action: 'none', reason: 'transmission_subscription' };

  if (SUSPEND_STATUSES.includes(liveStatus)) {
    if (hasOtherActiveAppSub) return { action: 'none', reason: 'other_active_subscription' };
    return { action: 'suspend', reason: `status_${liveStatus}` };
  }

  if (ACTIVE_LIKE_STATUSES.includes(liveStatus)) {
    if (INACTIVE_PREVIOUS_STATUSES.includes(previousStatus)) {
      return { action: 'enroll', reason: `reactivated_from_${previousStatus}` };
    }
    // Renouvellement, cancel_at_period_end, ou statut précédent inconnu : rien.
    return { action: 'none', reason: 'no_reactivation' };
  }

  // past_due (Stripe retente le paiement, accès gardé), incomplete : on attend.
  return { action: 'none', reason: `status_${liveStatus}_wait` };
}

/**
 * Appelle /pc-lms/v1/suspend ou /enroll. Ne lève jamais : renvoie un résultat.
 */
async function callLms(action, email) {
  const secret = process.env.PC_LMS_SECRET || '';
  if (!secret) {
    console.warn(`[lms-sync] PC_LMS_SECRET non défini : ${action} non envoyé.`);
    return { ok: false, error: 'secret_not_configured' };
  }
  const baseUrl = (process.env.PC_LMS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await deps.fetch(`${baseUrl}/wp-json/pc-lms/v1/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PC-Secret': secret },
      body: JSON.stringify({ email }),
      signal: controller.signal,
    });
    let body = null;
    try { body = await response.json(); } catch { /* corps non JSON */ }
    const ok = response.status === 200 && body?.success === true;
    if (!ok) console.error(`[lms-sync] ${action} : HTTP ${response.status}`);
    return { ok, httpStatus: response.status, found: body?.found, courses: body?.courses };
  } catch (err) {
    console.error(`[lms-sync] ${action} : ${err.name === 'AbortError' ? 'délai dépassé' : err.message}`);
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { decideLmsAction, callLms, deps, SUSPEND_STATUSES, INACTIVE_PREVIOUS_STATUSES };
