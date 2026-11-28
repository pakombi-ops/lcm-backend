// POST /api/billing-portal : session du Stripe Customer Portal pour l'utilisateur CONNECTÉ.
//
// Sécurité :
//   - identité prise dans le jeton Supabase (requireUser), jamais dans le corps ;
//   - client Stripe lu dans SA ligne entitlements (supabase_user_id = jeton) : aucun
//     identifiant client n'est accepté de l'app, on ne peut pas ouvrir le portail d'un autre ;
//   - URL de retour fixée par le serveur (variable PORTAL_RETURN_URL), jamais fournie
//     par l'app : pas de redirection ouverte.
//
// La Transmission (paiement en 3 fois) : le portail permettrait d'annuler les échéances.
// Tant qu'un abonnement Transmission est en cours, on refuse (409 transmission_plan),
// sauf si STRIPE_PORTAL_CONFIG_TRANSMISSION désigne une configuration du portail sans
// annulation (bpc_…), créée dans Stripe.
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { requireUser } = require('../src/auth');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DEFAULT_RETURN_URL = 'lecodemasculin://billing-return';
// Abonnements qui engagent encore des paiements (canceled et incomplete_expired sont terminés).
const RUNNING_STATUSES = ['trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete'];

const transmissionPriceIds = () => (process.env.TRANSMISSION_PRICE_IDS || '')
  .split(',').map((id) => id.trim()).filter(Boolean);

function isRunningTransmission(sub, priceIds) {
  return RUNNING_STATUSES.includes(sub.status)
    && (sub?.items?.data || []).some((item) => priceIds.includes(item?.price?.id));
}

router.post('/billing-portal', requireUser, async (req, res) => {
  try {
    const { data: entitlement, error } = await supabase
      .from('entitlements')
      .select('stripe_customer_id')
      .eq('supabase_user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;

    const customerId = entitlement?.stripe_customer_id;
    if (typeof customerId !== 'string' || !customerId.startsWith('cus_')) {
      // Aucun achat Stripe relié (compte gratuit, fondateur, accès offert).
      return res.status(404).json({ error: 'Aucun abonnement à gérer.', code: 'no_customer' });
    }

    const params = { customer: customerId, return_url: process.env.PORTAL_RETURN_URL || DEFAULT_RETURN_URL };

    const priceIds = transmissionPriceIds();
    if (priceIds.length) {
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
      if (subs.data.some((s) => isRunningTransmission(s, priceIds))) {
        const config = process.env.STRIPE_PORTAL_CONFIG_TRANSMISSION;
        if (!config) {
          return res.status(409).json({ error: 'Paiement de La Transmission en cours : contacte le support.', code: 'transmission_plan' });
        }
        params.configuration = config;
      }
    }

    let session;
    try {
      session = await stripe.billingPortal.sessions.create(params);
    } catch (err) {
      if (err && err.code === 'resource_missing') {
        return res.status(404).json({ error: 'Aucun abonnement à gérer.', code: 'no_customer' });
      }
      throw err;
    }
    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur billing-portal:', err.message);
    res.status(500).json({ error: 'portal_failed' });
  }
});

module.exports = router;
