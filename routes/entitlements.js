const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function syncAiQuotaPremium(supabaseUserId, isPremium) {
  await supabase
    .from('ai_quota')
    .upsert(
      { user_id: supabaseUserId, is_premium: isPremium, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
}

// POST /api/link-account
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

    await syncAiQuotaPremium(supabaseUserId, true);

    res.json({ linked: true });
  } catch (err) {
    console.error('Erreur link-account:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/update-entitlement
router.post('/update-entitlement', async (req, res) => {
  const { stripeCustomerId, status } = req.body;

  if (!stripeCustomerId || !status) {
    return res.status(400).json({ error: 'stripeCustomerId et status requis.' });
  }

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('entitlements')
      .select('supabase_user_id')
      .eq('stripe_customer_id', stripeCustomerId)
      .single();

    if (fetchError) throw fetchError;

    const { error } = await supabase
      .from('entitlements')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('stripe_customer_id', stripeCustomerId);

    if (error) throw error;

    if (existing?.supabase_user_id) {
      await syncAiQuotaPremium(existing.supabase_user_id, status === 'active');
    }

    res.json({ updated: true });
  } catch (err) {
    console.error('Erreur update-entitlement:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/entitlement-status/:supabaseUserId
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
// GET /api/programme-status?email=...
router.get('/programme-status', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email requis.' });

  try {
    const { data: entitlementRows, error: entError } = await supabase
      .from('entitlements')
      .select('supabase_user_id')
      .eq('purchase_email', email.trim().toLowerCase())
      .eq('status', 'active')
      .order('updated_at', { ascending: false })
      .limit(1);

    if (entError || !entitlementRows || entitlementRows.length === 0) {
      return res.json({ found: false });
    }

    const userId = entitlementRows[0].supabase_user_id;

    const { data: completions } = await supabase
      .from('lesson_completions')
      .select('lesson_id, completed_at')
      .eq('user_id', userId);

    const { data: streak } = await supabase
      .from('streaks')
      .select('current_streak, longest_streak')
      .eq('user_id', userId)
      .single();

    res.json({
      found: true,
      lessonsCompleted: completions?.length ?? 0,
      currentStreak: streak?.current_streak ?? 0,
      longestStreak: streak?.longest_streak ?? 0,
      lastActivity: completions?.length
        ? completions.sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0].completed_at
        : null,
    });
  } catch (err) {
    console.error('Erreur programme-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;

