const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// POST /api/link-account
// Appelé depuis l'app quand l'homme saisit son email d'achat
router.post('/link-account', async (req, res) => {
  const { email, supabaseUserId } = req.body;

  if (!email || !supabaseUserId) {
    return res.status(400).json({ error: 'email et supabaseUserId requis.' });
  }

  try {
    const customers = await stripe.customers.list({ email: email.trim().toLowerCase(), limit: 1 });

    if (!customers.data.length) {
      return res.json({ linked: false, reason: 'no_customer' });
    }

    const customer = customers.data[0];
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 1,
    });

    if (!subscriptions.data.length) {
      return res.json({ linked: false, reason: 'no_active_subscription' });
    }

    const subscription = subscriptions.data[0];

    const { error } = await supabase.from('entitlements').upsert({
      supabase_user_id: supabaseUserId,
      purchase_email: email.trim().toLowerCase(),
      stripe_customer_id: customer.id,
      stripe_subscription_id: subscription.id,
      status: 'active',
      plan_type: subscription.items.data[0]?.price?.nickname || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'supabase_user_id' });

    if (error) throw error;

    res.json({ linked: true });
  } catch (err) {
    console.error('Erreur link-account:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/update-entitlement
// Appelé par Make.com quand un webhook Stripe change le statut d'abonnement
router.post('/update-entitlement', async (req, res) => {
  const { stripeCustomerId, status } = req.body;

  if (!stripeCustomerId || !status) {
    return res.status(400).json({ error: 'stripeCustomerId et status requis.' });
  }

  try {
    const { error } = await supabase
      .from('entitlements')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('stripe_customer_id', stripeCustomerId);

    if (error) throw error;

    res.json({ updated: true });
  } catch (err) {
    console.error('Erreur update-entitlement:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/entitlement-status/:supabaseUserId
// Appelé par l'app pour vérifier l'accès avant d'ouvrir COURS
router.get('/entitlement-status/:supabaseUserId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('entitlements')
      .select('status, plan_type')
      .eq('supabase_user_id', req.params.supabaseUserId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    res.json({
      active: data?.status === 'active',
      planType: data?.plan_type || null,
    });
  } catch (err) {
    console.error('Erreur entitlement-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;