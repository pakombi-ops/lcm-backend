const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakes, resetSupabase, resetStripe, stripeState } = require('./support/fakes');
const { listen, postJson } = require('./support/http');

installFakes();
process.env.TRANSMISSION_PRICE_IDS = 'price_transmission';

const express = require('express');
const billingPortalRoutes = require('../routes/billingPortal');

const USER = { id: 'u1', email: 'homme@exemple.fr' };
const OTHER = { id: 'u2', email: 'autre@exemple.fr' };
const sub = (id, status, price = 'price_app') => ({ id, status, created: 1, items: { data: [{ price: { id: price } }] } });

beforeEach(() => {
  delete process.env.PORTAL_RETURN_URL;
  delete process.env.STRIPE_PORTAL_CONFIG_TRANSMISSION;
  resetSupabase({
    tokens: { 'jeton-u1': USER, 'jeton-u2': OTHER },
    tables: { entitlements: [
      { supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'active' },
      { supabase_user_id: 'u2', stripe_customer_id: 'cus_2', status: 'active' },
    ] },
  });
  resetStripe({ customers: [{ id: 'cus_1' }, { id: 'cus_2' }], subscriptions: { cus_1: [sub('sub_1', 'active')] } });
});

async function call(t, { token = 'jeton-u1', body = {} } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api', billingPortalRoutes);
  const ctx = await listen(app);
  t.after(ctx.close);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await postJson(`${ctx.baseUrl}/api/billing-portal`, body, headers);
  return { status: res.status, body: await res.json() };
}

const portalCalls = () => stripeState.calls.filter((c) => c.fn === 'billingPortal.sessions.create');

test('billing-portal : 401 sans jeton ou avec un jeton invalide, Stripe jamais appelé', async (t) => {
  for (const token of [null, 'faux']) {
    const { status } = await call(t, { token });
    assert.equal(status, 401);
  }
  assert.equal(stripeState.calls.length, 0);
});

test('billing-portal : session pour le client Stripe de l’utilisateur connecté, retour vers l’app', async (t) => {
  const { status, body } = await call(t);
  assert.equal(status, 200);
  assert.equal(body.url, 'https://billing.stripe.test/session/cus_1');
  assert.deepEqual(portalCalls()[0].params, { customer: 'cus_1', return_url: 'lecodemasculin://billing-return' });
});

test('billing-portal : un identifiant client ou une URL de retour dans le corps sont ignorés', async (t) => {
  const { status } = await call(t, { body: { customer: 'cus_2', stripeCustomerId: 'cus_2', supabaseUserId: 'u2', return_url: 'https://pirate.test' } });
  assert.equal(status, 200);
  assert.deepEqual(portalCalls()[0].params, { customer: 'cus_1', return_url: 'lecodemasculin://billing-return' });
});

test('billing-portal : PORTAL_RETURN_URL remplace l’URL de retour par défaut', async (t) => {
  process.env.PORTAL_RETURN_URL = 'https://pilierconscient.com/retour-app';
  await call(t);
  assert.equal(portalCalls()[0].params.return_url, 'https://pilierconscient.com/retour-app');
});

for (const [label, row] of [
  ['aucune ligne entitlements', null],
  ['fondateur ou accès offert (pas de client Stripe)', { supabase_user_id: 'u1', stripe_customer_id: null, status: 'active' }],
  ['identifiant client invalide', { supabase_user_id: 'u1', stripe_customer_id: 'n’importe quoi', status: 'active' }],
]) {
  test(`billing-portal : 404 no_customer, ${label}`, async (t) => {
    resetSupabase({ tokens: { 'jeton-u1': USER }, tables: { entitlements: row ? [row] : [] } });
    const { status, body } = await call(t);
    assert.deepEqual([status, body.code], [404, 'no_customer']);
    assert.equal(portalCalls().length, 0);
  });
}

test('billing-portal : client supprimé chez Stripe → 404 no_customer', async (t) => {
  stripeState.portalError = Object.assign(new Error('No such customer'), { code: 'resource_missing' });
  const { status, body } = await call(t);
  assert.deepEqual([status, body.code], [404, 'no_customer']);
});

test('billing-portal : erreur Stripe → 500 sans détail', async (t) => {
  stripeState.portalError = new Error('clé invalide sk_live_xxx');
  const { status, body } = await call(t);
  assert.deepEqual([status, body], [500, { error: 'portal_failed' }]);
});

for (const status of ['active', 'past_due', 'trialing']) {
  test(`billing-portal : Transmission ${status} en cours → 409 transmission_plan, pas de portail`, async (t) => {
    resetStripe({ customers: [{ id: 'cus_1' }], subscriptions: { cus_1: [sub('sub_1', 'active'), sub('sub_t', status, 'price_transmission')] } });
    const res = await call(t);
    assert.deepEqual([res.status, res.body.code], [409, 'transmission_plan']);
    assert.equal(portalCalls().length, 0);
  });
}

test('billing-portal : Transmission en cours + configuration dédiée → portail avec cette configuration', async (t) => {
  process.env.STRIPE_PORTAL_CONFIG_TRANSMISSION = 'bpc_sans_annulation';
  resetStripe({ customers: [{ id: 'cus_1' }], subscriptions: { cus_1: [sub('sub_t', 'active', 'price_transmission')] } });
  const { status } = await call(t);
  assert.equal(status, 200);
  assert.equal(portalCalls()[0].params.configuration, 'bpc_sans_annulation');
});

test('billing-portal : Transmission terminée → portail normal', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1' }], subscriptions: { cus_1: [sub('sub_1', 'active'), sub('sub_t', 'canceled', 'price_transmission')] } });
  const { status } = await call(t);
  assert.equal(status, 200);
  assert.equal(portalCalls()[0].params.configuration, undefined);
});

// ------------------------------------------------------------ entitlement-status : hasSubscription
const { hasManageableSubscription } = require('../routes/entitlements');

test('hasSubscription : vrai seulement avec un client Stripe et un abonnement en cours', () => {
  for (const status of ['trialing', 'active', 'past_due', 'unpaid', 'paused', 'incomplete']) {
    assert.equal(hasManageableSubscription({ stripe_customer_id: 'cus_1', status }), true, status);
  }
  for (const status of ['canceled', 'incomplete_expired', null]) {
    assert.equal(hasManageableSubscription({ stripe_customer_id: 'cus_1', status }), false, String(status));
  }
  assert.equal(hasManageableSubscription({ stripe_customer_id: null, status: 'active' }), false);
  assert.equal(hasManageableSubscription({ stripe_customer_id: 'founder', status: 'active' }), false);
  assert.equal(hasManageableSubscription(null), false);
});
