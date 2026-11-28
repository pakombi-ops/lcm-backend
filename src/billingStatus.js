// Statuts d'abonnement Stripe qui donnent le Premium, dans l'app ET dans la formation.
//
// past_due (retard de paiement) garde l'accès : Stripe retente le paiement et le
// membre peut mettre sa carte à jour. L'accès s'arrête au même moment partout,
// quand l'abonnement passe à canceled, unpaid, paused ou incomplete_expired
// (voir SUSPEND_STATUSES dans lmsSync.js).
//
// La même liste existe côté base : fonction SQL public.has_active_entitlement
// (communauté). Les deux doivent rester identiques.
const PREMIUM_STATUSES = ['trialing', 'active', 'past_due'];

module.exports = { PREMIUM_STATUSES };
