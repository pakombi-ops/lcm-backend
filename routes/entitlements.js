const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { requireUser, requireMakeSecret } = require('../src/auth');
const { decideLmsAction, callLms, SUSPEND_STATUSES } = require('../src/lmsSync');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Statuts Stripe considérés comme donnant accès à l'app
const ACTIVE_LIKE_STATUSES = ['trialing', 'active'];

// La Transmission : identifiants des prix Stripe (séparés par des virgules,
// variable d'environnement Railway TRANSMISSION_PRICE_IDS). Les abonnements
// de paiement en 3 fois de La Transmission ne doivent JAMAIS être traités
// comme un abonnement à l'app : l'accès Transmission est géré par une date
// de fin (access_expires_at), pas par le statut de l'abonnement.
const TRANSMISSION_PRICE_IDS = (process.env.TRANSMISSION_PRICE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const TRANSMISSION_PLAN_TYPES = ['transmission_groupe', 'transmission_1a1'];

// Liste fermée des statuts d'abonnement Stripe acceptés par /update-entitlement
// (https://docs.stripe.com/api/subscriptions/object#subscription_object-status).
const STRIPE_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
];

// Comparaison d'emails sans tenir compte des majuscules ni des espaces
// (en début, en fin, ou à l'intérieur : un email valide n'en contient pas).
// Renvoie null pour une valeur absente ou non textuelle : null ne correspond à rien.
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, '').toLowerCase();
  return normalized || null;
}

// Prénom par défaut posé à la création du compte dans l'app : il peut être remplacé.
const PLACEHOLDER_PRENOM = 'utilisateur';

// Make envoie le nom complet saisi dans Stripe Checkout (customer_details.name) :
// on n'en garde que le premier mot, sans espaces. « Jean Dupont » → « Jean »,
// « Jean-Pierre Martin » → « Jean-Pierre ». null si absent, vide ou non textuel.
function firstNameFrom(value) {
  if (typeof value !== 'string') return null;
  const first = value.trim().split(/\s+/)[0];
  return first ? first.slice(0, 50) : null;
}

// Vrai si le prénom actuel du profil peut être remplacé : absent, vide ou « Utilisateur ».
function isReplaceablePrenom(current) {
  if (typeof current !== 'string') return true;
  const trimmed = current.trim().toLowerCase();
  return trimmed === '' || trimmed === PLACEHOLDER_PRENOM;
}

// Profil (upsert idempotent, ne dépend d'aucun trigger existant ou non).
// Le prénom n'est écrit que s'il manque ou vaut encore « Utilisateur » : on
// n'écrase jamais un prénom choisi dans l'app, et un nom vide n'efface rien
// (la colonne absente de l'upsert garde sa valeur).
async function upsertProfile(userId, normalizedEmail, firstName, logTag) {
  const profileRow = {
    id: userId,
    email: normalizedEmail,
    updated_at: new Date().toISOString(),
  };
  if (firstName) {
    const { data: currentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('prenom')
      .eq('id', userId)
      .maybeSingle();
    if (profileError) {
      console.warn(`[${logTag}] Lecture du profil impossible, prénom laissé tel quel : ${profileError.message}`);
    } else if (isReplaceablePrenom(currentProfile?.prenom)) {
      profileRow.prenom = firstName;
    }
  }
  await supabase.from('profiles').upsert(profileRow, { onConflict: 'id' });
}

function isTransmissionSub(sub) {
  return (sub?.items?.data || []).some((item) =>
    TRANSMISSION_PRICE_IDS.includes(item?.price?.id)
  );
}

// Abonnement app le plus récent (actif ou en essai), hors La Transmission.
function pickRelevantAppSub(subscriptions) {
  return subscriptions
    .filter((s) => ACTIVE_LIKE_STATUSES.includes(s.status) && !isTransmissionSub(s))
    .sort((a, b) => b.created - a.created)[0];
}

// Vrai si l'utilisateur a encore un accès à durée fixe en cours.
function hasRunningFixedTermAccess(entitlement) {
  return Boolean(
    entitlement?.access_expires_at &&
    new Date(entitlement.access_expires_at) > new Date() &&
    ACTIVE_LIKE_STATUSES.includes(entitlement.status)
  );
}

async function getEntitlementByUserId(supabaseUserId) {
  const { data, error } = await supabase
    .from('entitlements')
    .select('status, access_expires_at')
    .eq('supabase_user_id', supabaseUserId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

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
router.post('/link-account', requireUser, async (req, res) => {
  const { email } = req.body;
  // L'identité vient du jeton, jamais du corps de la requête.
  const supabaseUserId = req.user.id;

  // typeof : un email non textuel (ex. 42) faisait planter le serveur sur email.trim().
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'email requis.' });
  }

  // Sans preuve de possession de l'email d'achat (code de confirmation, pas encore
  // construit), on ne relie que si l'email du compte connecté est le même.
  // Sinon, n'importe qui connaissant l'email d'un abonné pourrait prendre son accès.
  // L'email du compte doit aussi être confirmé par Supabase (email_confirmed_at),
  // sinon quelqu'un peut créer un compte avec l'email d'un autre sans le posséder.
  if (!req.user.email_confirmed_at) {
    return res.json({ linked: false, reason: 'email_not_verified' });
  }
  if ((req.user.email || '').trim().toLowerCase() !== email.trim().toLowerCase()) {
    return res.json({ linked: false, reason: 'email_mismatch' });
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

    const relevantSub = pickRelevantAppSub(subscriptions.data);

    if (!relevantSub) {
      return res.json({ linked: false, reason: 'no_active_subscription' });
    }

    const trialEndsAt = relevantSub.trial_end
      ? new Date(relevantSub.trial_end * 1000).toISOString()
      : null;

    // Un vrai abonnement app prend le relais : plus de date de fin.
    const { error } = await supabase.from('entitlements').upsert({
      supabase_user_id: supabaseUserId,
      purchase_email: email.trim().toLowerCase(),
      stripe_customer_id: customer.id,
      stripe_subscription_id: relevantSub.id,
      status: relevantSub.status,
      plan_type: relevantSub.items.data[0]?.price?.nickname || null,
      trial_ends_at: trialEndsAt,
      access_expires_at: null,
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
router.post('/provision-account', requireMakeSecret, async (req, res) => {
  const { email, prenom, stripeCustomerId, supabaseUserId } = req.body;

  if (typeof email !== 'string' || !email.trim() || typeof stripeCustomerId !== 'string' || !stripeCustomerId) {
    return res.status(400).json({ error: 'email et stripeCustomerId requis.' });
  }

  try {
    const normalizedEmail = normalizeEmail(email);

    // 0. Le client Stripe doit exister et avoir payé avec CET email. Défense en
    //    profondeur : même avec le secret Make, une erreur de correspondance dans
    //    un scénario (ou une fuite du secret) ne doit pas permettre de rattacher
    //    l'abonnement d'un autre client, ni de rétrograder le compte d'une victime.
    let customer;
    try {
      customer = await stripe.customers.retrieve(stripeCustomerId);
    } catch (stripeErr) {
      if (stripeErr && stripeErr.code === 'resource_missing') {
        return res.status(400).json({ error: 'Client Stripe introuvable.', code: 'unknown_customer' });
      }
      throw stripeErr;
    }
    const customerEmail = customer && !customer.deleted ? normalizeEmail(customer.email) : null;
    if (!customerEmail || customerEmail !== normalizedEmail) {
      console.warn(`[provision-account] Email différent de celui du client Stripe ${stripeCustomerId} : refusé.`);
      return res.status(403).json({ error: "L'email ne correspond pas au client Stripe.", code: 'email_mismatch' });
    }

    // 1. Retrouver l'abonnement app réel (trialing ou active), hors La Transmission
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      limit: 10,
    });

    const relevantSub = pickRelevantAppSub(subscriptions.data);

    // 2. Compte Supabase — retrouver ou créer.
    // Si un supabaseUserId est fourni (tunnel app), on ne lui fait confiance
    // QUE s'il correspond réellement à l'email ayant payé — sinon quelqu'un
    // pourrait payer avec son propre compte tout en indiquant l'ID d'un
    // autre utilisateur pour lui voler l'accès premium.
    let userId = null;
    let created = false;

    if (supabaseUserId) {
      const { data: existingUserData, error: getUserError } = await supabase.auth.admin.getUserById(supabaseUserId);
      if (!getUserError && normalizeEmail(existingUserData?.user?.email) === normalizedEmail) {
        userId = supabaseUserId;
      }
      // Si ça ne correspond pas, on ignore silencieusement l'indice et on
      // retombe sur la recherche/création par email ci-dessous.
    }

    const firstName = firstNameFrom(prenom);

    if (!userId) {
      const result = await findOrCreateSupabaseUser(normalizedEmail, firstName);
      userId = result.userId;
      created = result.created;
    }

    // 3. Profil : prénom écrit seulement s'il est vide ou vaut « Utilisateur ».
    await upsertProfile(userId, normalizedEmail, firstName, 'provision-account');

    // 4. Entitlement.
    // Garde-fou : sans abonnement app, on ne rétrograde JAMAIS un accès à durée
    // fixe encore en cours (ex. membre de La Transmission qui achète le livre).
    const existing = await getEntitlementByUserId(userId);
    const keepFixedTermAccess = !relevantSub && hasRunningFixedTermAccess(existing);

    if (!keepFixedTermAccess) {
      const trialEndsAt = relevantSub?.trial_end
        ? new Date(relevantSub.trial_end * 1000).toISOString()
        : null;

      const entitlementRow = {
        supabase_user_id: userId,
        purchase_email: normalizedEmail,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: relevantSub?.id || null,
        status: relevantSub?.status || 'inactive',
        plan_type: relevantSub?.items?.data?.[0]?.price?.nickname || null,
        trial_ends_at: trialEndsAt,
        updated_at: new Date().toISOString(),
      };
      // Un vrai abonnement app prend le relais : plus de date de fin.
      if (relevantSub) entitlementRow.access_expires_at = null;

      await supabase.from('entitlements').upsert(entitlementRow, { onConflict: 'supabase_user_id' });

      await syncAiQuotaPremium(userId, ACTIVE_LIKE_STATUSES.includes(relevantSub?.status));
    }

    // Note : aucun email de définition de mot de passe n'est déclenché ici.
    // L'utilisateur génère son propre code via l'écran "Mot de passe oublié"
    // de l'app — un appel serveur ici créerait un code redondant et invalidé
    // dès que l'utilisateur en redemande un depuis l'app.

    res.json({
      success: true,
      userId,
      createdNewUser: created,
      status: keepFixedTermAccess ? existing.status : (relevantSub?.status || null),
      fixedTermAccessKept: keepFixedTermAccess,
    });
  } catch (err) {
    console.error('Erreur provision-account:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/grant-access
// La Transmission : accorde un accès premium à durée fixe, indépendant de tout
// abonnement Stripe. Appelé UNIQUEMENT par Make.com (route Transmission), protégé
// par un secret partagé (variable Railway MAKE_SHARED_SECRET, en-tête x-make-secret).
// Corps JSON : { email, prenom, planType, expiresAt, stripeCustomerId? }
router.post('/grant-access', async (req, res) => {
  const expectedSecret = process.env.MAKE_SHARED_SECRET;
  const receivedSecret = req.get('x-make-secret') || '';

  if (
    !expectedSecret ||
    receivedSecret.length !== expectedSecret.length ||
    !crypto.timingSafeEqual(Buffer.from(receivedSecret), Buffer.from(expectedSecret))
  ) {
    return res.status(401).json({ error: 'Non autorisé.' });
  }

  const { email, prenom, planType, expiresAt, stripeCustomerId } = req.body;

  if (!email || !planType || !expiresAt) {
    return res.status(400).json({ error: 'email, planType et expiresAt requis.' });
  }

  if (!TRANSMISSION_PLAN_TYPES.includes(planType)) {
    return res.status(400).json({ error: `planType invalide (attendu : ${TRANSMISSION_PLAN_TYPES.join(' ou ')}).` });
  }

  const expiry = new Date(expiresAt);
  const now = new Date();
  const maxExpiry = new Date(now);
  maxExpiry.setMonth(maxExpiry.getMonth() + 24);

  if (Number.isNaN(expiry.getTime()) || expiry <= now || expiry > maxExpiry) {
    return res.status(400).json({ error: 'expiresAt doit être une date future, à moins de 24 mois.' });
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const firstName = firstNameFrom(prenom);
    const { userId, created } = await findOrCreateSupabaseUser(normalizedEmail, firstName);

    // Profil : prénom écrit seulement s'il est vide ou vaut « Utilisateur ».
    await upsertProfile(userId, normalizedEmail, firstName, 'grant-access');

    // Si un accès à durée fixe plus long existe déjà, on garde la date la plus lointaine.
    const existing = await getEntitlementByUserId(userId);
    let finalExpiry = expiry;
    if (existing?.access_expires_at && new Date(existing.access_expires_at) > finalExpiry) {
      finalExpiry = new Date(existing.access_expires_at);
    }

    const row = {
      supabase_user_id: userId,
      purchase_email: normalizedEmail,
      status: 'active',
      plan_type: planType,
      trial_ends_at: null,
      access_expires_at: finalExpiry.toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (stripeCustomerId) row.stripe_customer_id = stripeCustomerId;

    const { error } = await supabase.from('entitlements').upsert(row, { onConflict: 'supabase_user_id' });
    if (error) throw error;

    await syncAiQuotaPremium(userId, true);

    res.json({
      success: true,
      userId,
      createdNewUser: created,
      planType,
      accessExpiresAt: finalExpiry.toISOString(),
    });
  } catch (err) {
    console.error('Erreur grant-access:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Email du client Stripe, ou null s'il est supprimé ou sans email.
async function getStripeCustomerEmail(stripeCustomerId) {
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    return customer && !customer.deleted ? normalizeEmail(customer.email) : null;
  } catch (err) {
    if (err && err.code === 'resource_missing') return null;
    throw err;
  }
}

// Formation WordPress : suspend ou réinscrit selon le statut RÉEL de l'abonnement
// (relu chez Stripe, l'ordre d'arrivée des webhooks n'étant pas garanti).
// Ne lève jamais : l'entitlement est déjà à jour, le résultat est renvoyé à Make.
async function syncLmsAccess({ stripeCustomerId, subscriptionId, previousStatus, fallbackEmail }) {
  try {
    let sub;
    try {
      sub = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      if (err && err.code === 'resource_missing') return { action: 'none', reason: 'unknown_subscription' };
      throw err;
    }
    const subCustomer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
    if (subCustomer !== stripeCustomerId) {
      console.warn(`[lms-sync] Abonnement ${subscriptionId} d'un autre client que ${stripeCustomerId} : ignoré.`);
      return { action: 'none', reason: 'subscription_customer_mismatch' };
    }

    const isTransmission = isTransmissionSub(sub);
    let hasOtherActiveAppSub = false;
    if (!isTransmission && SUSPEND_STATUSES.includes(sub.status)) {
      const others = await stripe.subscriptions.list({ customer: stripeCustomerId, status: 'all', limit: 100 });
      hasOtherActiveAppSub = others.data.some((s) =>
        s.id !== sub.id && ACTIVE_LIKE_STATUSES.includes(s.status) && !isTransmissionSub(s)
      );
    }

    const decision = decideLmsAction({ liveStatus: sub.status, previousStatus, isTransmission, hasOtherActiveAppSub });
    if (decision.action === 'none') return decision;

    const email = (await getStripeCustomerEmail(stripeCustomerId)) || normalizeEmail(fallbackEmail);
    if (!email) {
      console.error(`[lms-sync] ${decision.action} impossible pour ${stripeCustomerId} : aucun email.`);
      return { ...decision, ok: false, error: 'no_email' };
    }

    return { ...decision, ...(await callLms(decision.action, email)) };
  } catch (err) {
    console.error('[lms-sync] Erreur :', err.message);
    return { action: 'error', ok: false, error: 'sync_failed' };
  }
}

// POST /api/update-entitlement
// Corps : { stripeCustomerId, status, trialEndsAt?, subscriptionId?, previousStatus? }
// subscriptionId (data.object.id) active la synchronisation de la formation WordPress ;
// previousStatus (data.previous_attributes.status) permet de détecter une réactivation.
router.post('/update-entitlement', requireMakeSecret, async (req, res) => {
  const { stripeCustomerId, status, trialEndsAt, subscriptionId, previousStatus } = req.body;

  if (typeof stripeCustomerId !== 'string' || !stripeCustomerId || !status) {
    return res.status(400).json({ error: 'stripeCustomerId et status requis.' });
  }
  if (!STRIPE_SUBSCRIPTION_STATUSES.includes(status)) {
    console.warn(`[update-entitlement] Statut refusé : ${JSON.stringify(status).slice(0, 40)}`);
    return res.status(400).json({
      error: `status invalide (attendu : ${STRIPE_SUBSCRIPTION_STATUSES.join(', ')}).`,
      code: 'invalid_status',
    });
  }

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('entitlements')
      .select('supabase_user_id, status, access_expires_at, purchase_email')
      .eq('stripe_customer_id', stripeCustomerId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;

    // Garde-fou : un événement d'abonnement ne retire jamais un accès à durée
    // fixe encore en cours (ex. fin du paiement en 3 fois de La Transmission).
    if (!ACTIVE_LIKE_STATUSES.includes(status) && hasRunningFixedTermAccess(existing)) {
      return res.json({ updated: false, reason: 'fixed_term_access_running' });
    }

    const updatePayload = { status, updated_at: new Date().toISOString() };
    if (trialEndsAt) updatePayload.trial_ends_at = trialEndsAt;

    // Garde-fou : un statut inactif ne retire pas l'accès si le client a encore
    // un autre abonnement app actif ou en essai (hors La Transmission), relu chez
    // Stripe. L'entitlement bascule alors sur cet abonnement.
    let keptSubscriptionId = null;
    if (!ACTIVE_LIKE_STATUSES.includes(status)) {
      const subscriptions = await stripe.subscriptions.list({ customer: stripeCustomerId, status: 'all', limit: 100 });
      const stillActive = pickRelevantAppSub(subscriptions.data);
      if (stillActive) {
        keptSubscriptionId = stillActive.id;
        updatePayload.status = stillActive.status;
        updatePayload.stripe_subscription_id = stillActive.id;
        updatePayload.trial_ends_at = stillActive.trial_end
          ? new Date(stillActive.trial_end * 1000).toISOString()
          : null;
        console.warn(`[update-entitlement] ${stripeCustomerId} : statut ${status} reçu, accès gardé par l'abonnement ${stillActive.id} (${stillActive.status}).`);
      }
    }

    const { error } = await supabase
      .from('entitlements')
      .update(updatePayload)
      .eq('stripe_customer_id', stripeCustomerId);

    if (error) throw error;

    if (existing?.supabase_user_id) {
      const isPremium = ACTIVE_LIKE_STATUSES.includes(updatePayload.status);
      await syncAiQuotaPremium(existing.supabase_user_id, isPremium);
    }

    const result = { updated: true };
    if (keptSubscriptionId) {
      result.status = updatePayload.status;
      result.keptActiveSubscription = keptSubscriptionId;
    }

    // Sans subscriptionId (ancien mapping Make), pas de synchronisation de la formation.
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      return res.json(result);
    }

    result.lms = await syncLmsAccess({
      stripeCustomerId,
      subscriptionId,
      previousStatus: STRIPE_SUBSCRIPTION_STATUSES.includes(previousStatus) ? previousStatus : undefined,
      fallbackEmail: existing?.purchase_email,
    });
    res.json(result);
  } catch (err) {
    console.error('Erreur update-entitlement:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/entitlement-status/:supabaseUserId
router.get('/entitlement-status/:supabaseUserId', requireUser, async (req, res) => {
  if (req.params.supabaseUserId !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  try {
    const { data, error } = await supabase
      .from('entitlements')
      .select('status, plan_type, trial_ends_at, access_expires_at')
      .eq('supabase_user_id', req.params.supabaseUserId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    res.json({
      active: ACTIVE_LIKE_STATUSES.includes(data?.status),
      trialActive: data?.status === 'trialing',
      trialEndsAt: data?.trial_ends_at || null,
      planType: data?.plan_type || null,
      accessExpiresAt: data?.access_expires_at || null,
    });
  } catch (err) {
    console.error('Erreur entitlement-status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/programme-status?email=...
router.get('/programme-status', requireMakeSecret, async (req, res) => {
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
module.exports.STRIPE_SUBSCRIPTION_STATUSES = STRIPE_SUBSCRIPTION_STATUSES;
module.exports.normalizeEmail = normalizeEmail;
module.exports.firstNameFrom = firstNameFrom;
