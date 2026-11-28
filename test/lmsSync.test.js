const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakes, resetSupabase, resetStripe, supabaseState } = require('./support/fakes');
const { listen, postJson } = require('./support/http');

installFakes();
const SECRET = 'secret-make-de-test-0123456789';
const LMS_SECRET = 'secret-wordpress-de-test-0123456789';
process.env.MAKE_SHARED_SECRET = SECRET;
process.env.TRANSMISSION_PRICE_IDS = 'price_transmission';
process.env.PC_LMS_BASE_URL = 'https://wp.test/';

const express = require('express');
const entitlementsRoutes = require('../routes/entitlements');
const lmsSync = require('../src/lmsSync');
const { decideLmsAction } = lmsSync;

const MAKE = { 'x-make-secret': SECRET };
const sub = (id, status, price = 'price_app') => ({
  id, status, created: 1, trial_end: null, items: { data: [{ price: { id: price } }] },
});

// Appels WordPress interceptés (le fetch global sert aux requêtes de test).
let wpCalls;
let wpResponse;
const realFetch = lmsSync.deps.fetch;
beforeEach(() => {
  wpCalls = [];
  wpResponse = { status: 200, body: { success: true, found: true, courses: { 393: 'suspended' } } };
  lmsSync.deps.fetch = async (url, init) => {
    wpCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (wpResponse instanceof Error) throw wpResponse;
    return { status: wpResponse.status, json: async () => wpResponse.body };
  };
  process.env.PC_LMS_SECRET = LMS_SECRET;
  resetSupabase({ tables: { entitlements: [{ supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'active', purchase_email: 'achat@exemple.fr' }] } });
  resetStripe({ customers: [{ id: 'cus_1', email: 'Homme@Exemple.fr' }], subscriptions: {} });
});

async function update(t, body) {
  const app = express();
  app.use(express.json());
  app.use('/api', entitlementsRoutes);
  const ctx = await listen(app);
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/update-entitlement`, { stripeCustomerId: 'cus_1', ...body }, MAKE);
  return { status: res.status, body: await res.json() };
}

// ------------------------------------------------------------ décision (fonction pure)

test('decideLmsAction : table des règles', () => {
  const d = (liveStatus, previousStatus, extra = {}) =>
    decideLmsAction({ liveStatus, previousStatus, isTransmission: false, hasOtherActiveAppSub: false, ...extra }).action;
  for (const s of ['canceled', 'unpaid', 'paused', 'incomplete_expired']) assert.equal(d(s), 'suspend', s);
  for (const prev of ['unpaid', 'paused', 'incomplete', 'incomplete_expired', 'canceled']) {
    assert.equal(d('active', prev), 'enroll', prev);
    assert.equal(d('trialing', prev), 'enroll', prev);
  }
  assert.equal(d('active', undefined), 'none', 'renouvellement ou cancel_at_period_end');
  assert.equal(d('active', 'trialing'), 'none', 'fin d’essai payée');
  assert.equal(d('past_due', 'active'), 'none', 'past_due : Stripe retente');
  assert.equal(d('active', 'past_due'), 'none', 'paiement rattrapé : la formation n’a jamais été suspendue');
  assert.equal(d('incomplete', undefined), 'none');
  assert.equal(d('canceled', undefined, { isTransmission: true }), 'none', 'Transmission');
  assert.equal(d('canceled', undefined, { hasOtherActiveAppSub: true }), 'none', 'autre abonnement actif');
  assert.equal(d('active', 'unpaid', { isTransmission: true }), 'none', 'Transmission réactivée');
});

// ------------------------------------------------------------ compatibilité

test('sans subscriptionId : réponse et comportement inchangés, aucun appel WordPress', async (t) => {
  const { status, body } = await update(t, { status: 'canceled' });
  assert.equal(status, 200);
  assert.deepEqual(body, { updated: true });
  assert.equal(wpCalls.length, 0);
});

test('accès à durée fixe en cours : rien n’est modifié, aucun appel WordPress', async (t) => {
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  resetSupabase({ tables: { entitlements: [{ supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'active', access_expires_at: future }] } });
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'canceled')] } });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.deepEqual(body, { updated: false, reason: 'fixed_term_access_running' });
  assert.equal(wpCalls.length, 0);
});

// ------------------------------------------------------------ suspension

for (const liveStatus of ['canceled', 'unpaid', 'paused', 'incomplete_expired']) {
  test(`abonnement ${liveStatus} : entitlement mis à jour puis /suspend avec l’email du client Stripe`, async (t) => {
    resetStripe({ customers: [{ id: 'cus_1', email: ' Homme@Exemple.fr ' }], subscriptions: { cus_1: [sub('sub_1', liveStatus)] } });
    const { status, body } = await update(t, { status: liveStatus, subscriptionId: 'sub_1' });
    assert.equal(status, 200);
    assert.equal(supabaseState.tables.entitlements[0].status, liveStatus);
    assert.equal(body.lms.action, 'suspend');
    assert.equal(body.lms.ok, true);
    assert.equal(wpCalls.length, 1);
    assert.equal(wpCalls[0].url, 'https://wp.test/wp-json/pc-lms/v1/suspend');
    assert.equal(wpCalls[0].headers['X-PC-Secret'], LMS_SECRET);
    assert.deepEqual(wpCalls[0].body, { email: 'homme@exemple.fr' });
  });
}

test('statut réel relu chez Stripe : Make dit « canceled » mais l’abonnement est actif → rien', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'active')] } });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.equal(body.lms.action, 'none');
  assert.equal(wpCalls.length, 0);
});

test('un autre abonnement app actif ou en essai : pas de suspension', async (t) => {
  resetStripe({
    customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }],
    subscriptions: { cus_1: [sub('sub_1', 'canceled'), sub('sub_2', 'trialing')] },
  });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.deepEqual([body.lms.action, body.lms.reason], ['none', 'other_active_subscription']);
  assert.equal(wpCalls.length, 0);
});

test('seul un abonnement Transmission reste actif : il ne compte pas, suspension', async (t) => {
  resetStripe({
    customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }],
    subscriptions: { cus_1: [sub('sub_1', 'canceled'), sub('sub_t', 'active', 'price_transmission')] },
  });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.equal(body.lms.action, 'suspend');
  assert.equal(wpCalls.length, 1);
});

test('fin d’un abonnement Transmission (paiement en 3 fois) : aucun appel WordPress', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_t', 'canceled', 'price_transmission')] } });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_t' });
  assert.deepEqual([body.lms.action, body.lms.reason], ['none', 'transmission_subscription']);
  assert.equal(wpCalls.length, 0);
});

test('client Stripe supprimé : repli sur purchase_email de l’entitlement', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', deleted: true }], subscriptions: { cus_1: [sub('sub_1', 'canceled')] } });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.equal(body.lms.ok, true);
  assert.deepEqual(wpCalls[0].body, { email: 'achat@exemple.fr' });
});

test('aucun email disponible : pas d’appel, erreur signalée', async (t) => {
  resetSupabase({ tables: { entitlements: [{ supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'active' }] } });
  resetStripe({ customers: [{ id: 'cus_1', deleted: true }], subscriptions: { cus_1: [sub('sub_1', 'canceled')] } });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.deepEqual([body.lms.ok, body.lms.error], [false, 'no_email']);
  assert.equal(wpCalls.length, 0);
});

test('abonnement d’un autre client : ignoré', async (t) => {
  resetStripe({
    customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }],
    subscriptions: { cus_autre: [sub('sub_x', 'canceled')] },
  });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_x' });
  assert.equal(body.lms.reason, 'subscription_customer_mismatch');
  assert.equal(wpCalls.length, 0);
});

test('abonnement inconnu chez Stripe : ignoré, entitlement quand même mis à jour', async (t) => {
  const { status, body } = await update(t, { status: 'canceled', subscriptionId: 'sub_inconnu' });
  assert.equal(status, 200);
  assert.equal(body.lms.reason, 'unknown_subscription');
  assert.equal(supabaseState.tables.entitlements[0].status, 'canceled');
});

// ------------------------------------------------------------ réinscription

for (const prev of ['unpaid', 'paused', 'incomplete', 'canceled']) {
  test(`retour à active depuis ${prev} : /enroll`, async (t) => {
    resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'active')] } });
    const { body } = await update(t, { status: 'active', subscriptionId: 'sub_1', previousStatus: prev });
    assert.equal(body.lms.action, 'enroll');
    assert.equal(wpCalls[0].url, 'https://wp.test/wp-json/pc-lms/v1/enroll');
    assert.deepEqual(wpCalls[0].body, { email: 'homme@exemple.fr' });
  });
}

for (const [label, previousStatus] of [['renouvellement (pas de previousStatus)', undefined], ['cancel_at_period_end', undefined], ['fin d’essai', 'trialing'], ['paiement rattrapé après past_due', 'past_due'], ['statut précédent invalide', 'nimporte']]) {
  test(`active, ${label} : aucun appel WordPress`, async (t) => {
    resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'active')] } });
    const body = { status: 'active', subscriptionId: 'sub_1' };
    if (previousStatus) body.previousStatus = previousStatus;
    const res = await update(t, body);
    assert.equal(res.body.lms.action, 'none');
    assert.equal(wpCalls.length, 0);
  });
}

test('past_due : aucun appel WordPress (Stripe retente le paiement)', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'past_due')] } });
  const { body } = await update(t, { status: 'past_due', subscriptionId: 'sub_1', previousStatus: 'active' });
  assert.equal(body.lms.action, 'none');
  assert.equal(wpCalls.length, 0);
});

// ------------------------------------------------------------ pannes côté WordPress

test('PC_LMS_SECRET absent : aucun appel, erreur signalée, entitlement mis à jour', async (t) => {
  delete process.env.PC_LMS_SECRET;
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'canceled')] } });
  const { status, body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.equal(status, 200);
  assert.deepEqual([body.lms.ok, body.lms.error], [false, 'secret_not_configured']);
  assert.equal(wpCalls.length, 0);
  assert.equal(supabaseState.tables.entitlements[0].status, 'canceled');
});

for (const [label, response, expected] of [
  ['401 (secret refusé)', { status: 401, body: { code: 'pc_unauthorized' } }, { ok: false, httpStatus: 401 }],
  ['503 (secret non configuré côté WordPress)', { status: 503, body: {} }, { ok: false, httpStatus: 503 }],
  ['207 (suspension partielle)', { status: 207, body: { success: false, courses: { 393: 'failed' } } }, { ok: false, httpStatus: 207 }],
  ['compte WordPress introuvable', { status: 200, body: { success: true, found: false } }, { ok: true, found: false }],
]) {
  test(`WordPress répond ${label} : résultat renvoyé, la route répond 200`, async (t) => {
    wpResponse = response;
    resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'canceled')] } });
    const { status, body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
    assert.equal(status, 200);
    for (const [k, v] of Object.entries(expected)) assert.equal(body.lms[k], v, k);
  });
}

test('WordPress injoignable : erreur réseau signalée, la route répond 200', async (t) => {
  wpResponse = new Error('ECONNREFUSED');
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'canceled')] } });
  const { status, body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.equal(status, 200);
  assert.deepEqual([body.lms.ok, body.lms.error], [false, 'network_error']);
});

test.after(() => { lmsSync.deps.fetch = realFetch; });

// ------------------------------------------------------------ entitlement : aucun autre abonnement app actif

for (const status of ['canceled', 'unpaid', 'paused', 'incomplete_expired']) {
  test(`entitlement : ${status} reçu mais un autre abonnement app est en essai → accès gardé sur cet abonnement`, async (t) => {
    resetStripe({
      customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }],
      subscriptions: { cus_1: [sub('sub_1', status), { ...sub('sub_2', 'trialing'), created: 2, trial_end: 1796400000 }] },
    });
    const { status: http, body } = await update(t, { status }); // ancien mapping, sans subscriptionId
    assert.equal(http, 200);
    assert.deepEqual(body, { updated: true, status: 'trialing', keptActiveSubscription: 'sub_2' });
    const ent = supabaseState.tables.entitlements[0];
    assert.deepEqual([ent.status, ent.stripe_subscription_id, ent.trial_ends_at], ['trialing', 'sub_2', new Date(1796400000 * 1000).toISOString()]);
    const quota = supabaseState.writes.find((w) => w.table === 'ai_quota');
    assert.equal(quota.row.is_premium, true);
  });
}

test('entitlement : past_due reçu → Premium gardé (app alignée sur la formation), pas de relecture Stripe', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'past_due')] } });
  const { stripeState } = require('./support/fakes');
  const { body } = await update(t, { status: 'past_due' });
  assert.deepEqual(body, { updated: true });
  assert.equal(supabaseState.tables.entitlements[0].status, 'past_due');
  assert.equal(supabaseState.writes.find((w) => w.table === 'ai_quota').row.is_premium, true);
  assert.equal(stripeState.calls.filter((c) => c.fn === 'subscriptions.list').length, 0);
});

test('entitlement : canceled reçu, un autre abonnement est en retard de paiement → accès gardé sur celui-ci', async (t) => {
  resetStripe({
    customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }],
    subscriptions: { cus_1: [sub('sub_1', 'canceled'), { ...sub('sub_2', 'past_due'), created: 2 }] },
  });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.equal(body.status, 'past_due');
  assert.equal(body.keptActiveSubscription, 'sub_2');
  assert.equal(body.lms.reason, 'other_active_subscription');
  assert.equal(supabaseState.writes.find((w) => w.table === 'ai_quota').row.is_premium, true);
  assert.equal(wpCalls.length, 0);
});

test('entitlement : un abonnement à jour passe avant un plus récent en retard de paiement', async (t) => {
  resetStripe({
    customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }],
    subscriptions: { cus_1: [sub('sub_1', 'canceled'), { ...sub('sub_old', 'active'), created: 1 }, { ...sub('sub_new', 'past_due'), created: 5 }] },
  });
  const { body } = await update(t, { status: 'canceled' });
  assert.deepEqual([body.status, body.keptActiveSubscription], ['active', 'sub_old']);
});

test('entitlement : seul un abonnement Transmission reste actif → il ne garde pas l’accès app', async (t) => {
  resetStripe({
    customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }],
    subscriptions: { cus_1: [sub('sub_1', 'canceled'), sub('sub_t', 'active', 'price_transmission')] },
  });
  const { body } = await update(t, { status: 'canceled' });
  assert.deepEqual(body, { updated: true });
  assert.equal(supabaseState.tables.entitlements[0].status, 'canceled');
  assert.equal(supabaseState.writes.find((w) => w.table === 'ai_quota').row.is_premium, false);
});

test('entitlement : aucun autre abonnement actif → statut reçu appliqué (comportement inchangé)', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'canceled'), sub('sub_0', 'canceled')] } });
  const { body } = await update(t, { status: 'canceled' });
  assert.deepEqual(body, { updated: true });
  assert.equal(supabaseState.tables.entitlements[0].status, 'canceled');
});

test('entitlement : statut actif reçu → pas de relecture des abonnements', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [sub('sub_1', 'active')] } });
  const { stripeState } = require('./support/fakes');
  const { body } = await update(t, { status: 'active', trialEndsAt: '2026-12-04T00:00:00.000Z' });
  assert.deepEqual(body, { updated: true });
  assert.equal(stripeState.calls.filter((c) => c.fn === 'subscriptions.list').length, 0);
  assert.equal(supabaseState.tables.entitlements[0].trial_ends_at, '2026-12-04T00:00:00.000Z');
});

test('entitlement + formation : un essai reste → accès app gardé ET pas de suspension', async (t) => {
  resetStripe({
    customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }],
    subscriptions: { cus_1: [sub('sub_1', 'canceled'), sub('sub_2', 'trialing')] },
  });
  const { body } = await update(t, { status: 'canceled', subscriptionId: 'sub_1' });
  assert.equal(body.status, 'trialing');
  assert.equal(body.lms.reason, 'other_active_subscription');
  assert.equal(wpCalls.length, 0);
});
