const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Statuts Stripe considérés comme donnant accès à l'app
const ACTIVE_LIKE_STATUSES = ['trialing', 'active'];

async function syncAiQuotaPremium(supabaseUserId, isPremium) {
  await supabase
    .from('ai_quota')
    .upsert(
      { user_id: supabaseUserId, is_premium: isPremium, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    );
}

// Retrouve un utilisateur Supabase par email (via la fonction RPC get_user_id_by_email),
// ou le crée avec un mot de passe aléatoire s'il n'existe pas encore.
async function findOrCreateSupabaseUser(email, prenom) {
  const normalizedEmail = email.trim().toLowerCase();

  const { data: existingId, error: rpcError } = await supabase.rpc('get_user_id_by_email', {
    p_email: normalizedEmail,
  });

  if (rpcError) throw rpcError;

  if (existingId) {
    return { userId: existingId, created: false };
  }

  const randomPassword = crypto.randomBytes(24).toString('hex');
  const { data, error } = await supabase.auth.admin.createUser({
    email: normalizedEmail,
    password: randomPassword,
    email_confirm: true,
    user_metadata: { prenom: prenom || null },
  });

  if (error) throw error;

  return { userId: data.user.id, created: true };
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
      status: 'all',
      limit: 10,
    });

    const relevantSub = subscriptions.data
      .filter((s) => ACTIVE_LIKE_STATUSES.includes(s.status))
      .sort((a, b) => b.created - a.created)[0];

    if (!relevantSub) {
      return res.json({ linked: false, reason: 'no_active_subscription' });
    }

    const trialEndsAt = relevantSub.trial_end
      ? new Date(relevantSub.trial_end * 1000).toISOString()
      : null;

    const { error } = await supabase.from('entitlements').upsert({
      supabase_user_id: supabaseUserId,
      purchase_email: email.trim().toLowerCase(),
      stripe_customer_id: customer.id,
      stripe_subscription_id: relevantSub.id,
      status: relevantSub.status,
      plan_type: relevantSub.items.data[0]?.price?.nickname || null,
      trial_ends_at: trialEndsAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'supabase_user_id' });

    if (error) throw error;

    await syncAiQuotaPremium(supabaseUserId, true);

    res.json({ linked: true, status: relevantSub.status });
  } catch (err) {
    console.error('Erreur link-account:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/provision-account
// Appelé par Make.com juste après un enrollment WordPress réussi (paiement site,
// scénario 1). Crée le compte Supabase s'il n'existe pas, l'inscrit dans
// entitlements avec le vrai statut Stripe (trialing/active), et déclenche
// l'email de définition de mot de passe pour un nouveau compte.
router.post('/provision-account', async (req, res) => {
  const { email, prenom, stripeCustomerId } = req.body;

  if (!email || !stripeCustomerId) {
    return res.status(400).json({ error: 'email et stripeCustomerId requis.' });
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();

    // 1. Retrouver l'abonnement réel (trialing ou active) pour ce client Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 10,
    });

    const relevantSub = subscriptions.data
      .filter((s) => ACTIVE_LIKE_STATUSES.includes(s.status))
      .sort((a, b) => b.created - a.created)[0];

    // 2. Compte Supabase — retrouver ou créer
    const { userId, created } = await findOrCreateSupabaseUser(normalizedEmail, prenom);

    // 3. Profil (upsert idempotent, ne dépend d'aucun trigger existant ou non)
    await supabase.from('profiles').upsert({
      id: userId,
      email: normalizedEmail,
      prenom: prenom || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    // 4. Entitlement — création immédiate, ne dépend plus d'une connexion app
    const trialEndsAt = relevantSub?.trial_end
      ? new Date(relevantSub.trial_end * 1000).toISOString()
      : null;

    await supabase.from('entitlements').upsert({
      supabase_user_id: userId,
      purchase_email: normalizedEmail,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: relevantSub?.id || null,
      status: relevantSub?.status || 'inactive',
      plan_type: relevantSub?.items?.data?.[0]?.price?.nickname || null,
      trial_ends_at: trialEndsAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'supabase_user_id' });

    // Note : aucun email de définition de mot de passe n'est déclenché ici.
    // L'utilisateur génère son propre code via l'écran "Mot de passe oublié"
    // de l'app — un appel serveur ici créerait un code redondant et invalidé
    // dès que l'utilisateur en redemande un depuis l'app.

    await syncAiQuotaPremium(userId, ACTIVE_LIKE_STATUSES.includes(relevantSub?.status));

    res.json({
      success: true,
      userId,
      createdNewUser: created,
      status: relevantSub?.status || null,
    });
  } catch (err) {
    console.error('Erreur provision-account:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/update-entitlement
router.post('/update-entitlement', async (req, res) => {
  const { stripeCustomerId, status, trialEndsAt } = req.body;

  if (!stripeCustomerId || !status) {
    return res.status(400).json({ error: 'stripeCustomerId et status requis.' });
  }

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('entitlements')
      .select('supabase_user_id')
      .eq('stripe_customer_id', stripeCustomerId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

    const updatePayload = { status, updated_at: new Date().toISOString() };
    if (trialEndsAt) updatePayload.trial_ends_at = trialEndsAt;

    const { error } = await supabase
      .from('entitlements')
      .update(updatePayload)
      .eq('stripe_customer_id', stripeCustomerId);

    if (error) throw error;

    if (existing?.supabase_user_id) {
      const isPremium = ACTIVE_LIKE_STATUSES.includes(status);
      await syncAiQuotaPremium(existing.supabase_user_id, isPremium);
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
      .select('status, plan_type, trial_ends_at')
      .eq('supabase_user_id', req.params.supabaseUserId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    res.json({
      active: ACTIVE_LIKE_STATUSES.includes(data?.status),
      trialActive: data?.status === 'trialing',
      trialEndsAt: data?.trial_ends_at || null,
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
      .in('status', ACTIVE_LIKE_STATUSES)
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
