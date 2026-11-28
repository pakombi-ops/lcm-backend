const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakes, resetSupabase, resetStripe, supabaseState, stripeState, fakeSupabase, fakeStripe } = require('./support/fakes');

installFakes();
const { createAccountErasure } = require('../src/accountErasure');

const USER = 'u1';
const sub = (id, status, price = 'price_app') => ({ id, status, created: 1, items: { data: [{ price: { id: price } }] } });

let wpCalls, brevoCalls, wpResult, brevoResult;
function build() {
  return createAccountErasure({
    supabase: fakeSupabase,
    stripe: fakeStripe,
    callLms: async (action, email) => { wpCalls.push({ action, email }); return wpResult; },
    brevo: { deleteContact: async (email) => { brevoCalls.push(email); return brevoResult; } },
    transmissionPriceIds: () => ['price_transmission'],
  });
}

// erase_user_data simulé : efface profil, entitlement et compte auth, ou refuse le fondateur.
function installEraseRpc() {
  supabaseState.rpcHandlers.erase_user_data = async ({ p_user_id }) => {
    const profile = (supabaseState.tables.profiles || []).find((p) => p.id === p_user_id);
    if (profile?.is_founder) return { data: null, error: { message: 'founder_protected' } };
    supabaseState.tables.profiles = (supabaseState.tables.profiles || []).filter((p) => p.id !== p_user_id);
    supabaseState.tables.entitlements = (supabaseState.tables.entitlements || []).filter((e) => e.supabase_user_id !== p_user_id);
    supabaseState.authUsers = supabaseState.authUsers.filter((u) => u.id !== p_user_id);
    return { data: { profiles: 1 }, error: null };
  };
}

beforeEach(() => {
  wpCalls = []; brevoCalls = [];
  wpResult = { ok: true, found: true };
  brevoResult = { ok: true };
  resetSupabase({
    authUsers: [{ id: USER, email: 'Homme@Exemple.fr' }],
    tables: {
      profiles: [{ id: USER, is_founder: false, email: 'homme@exemple.fr' }],
      entitlements: [{ supabase_user_id: USER, stripe_customer_id: 'cus_1', status: 'active' }],
      account_erasures: [],
    },
  });
  resetStripe({ customers: [{ id: 'cus_1' }], subscriptions: { cus_1: [sub('sub_1', 'active')] } });
  installEraseRpc();
});

const journal = () => supabaseState.tables.account_erasures[0];
const rpcNames = () => supabaseState.rpcCalls.map((c) => c.name);
const cancels = () => stripeState.calls.filter((c) => c.fn === 'subscriptions.cancel');

test('suppression demandée : Stripe résilié, Supabase effacé, WordPress puis Brevo, journal terminé sans email', async () => {
  const result = await build().eraseAccount({ userId: USER, reason: 'user_request', eraseCommunityText: false });
  assert.deepEqual([result.ok, result.canceledSubscriptions, result.pending], [true, ['sub_1'], []]);
  assert.deepEqual(cancels()[0].params, { prorate: false, invoice_now: false });
  assert.deepEqual(supabaseState.rpcCalls[0], { name: 'erase_user_data', params: { p_user_id: USER, p_erase_community_text: false } });
  assert.deepEqual(wpCalls, [{ action: 'delete-user', email: 'homme@exemple.fr' }]);
  assert.deepEqual(brevoCalls, ['homme@exemple.fr']);
  const j = journal();
  assert.equal(j.reason, 'user_request');
  assert.ok(j.supabase_erased_at && j.wordpress_done_at && j.brevo_done_at && j.completed_at);
  assert.equal(j.email, null);
  assert.equal(supabaseState.authUsers.length, 0);
});

test('ordre : Stripe, puis Supabase, puis WordPress, puis Brevo', async () => {
  const order = [];
  const erasure = createAccountErasure({
    supabase: { ...fakeSupabase, rpc: async (n, p) => { order.push(n); return fakeSupabase.rpc(n, p); } },
    stripe: {
      subscriptions: {
        list: async (p) => { order.push('stripe.list'); return fakeStripe.subscriptions.list(p); },
        cancel: async (id, p) => { order.push('stripe.cancel'); return fakeStripe.subscriptions.cancel(id, p); },
      },
    },
    callLms: async () => { order.push('wordpress'); return { ok: true }; },
    brevo: { deleteContact: async () => { order.push('brevo'); return { ok: true }; } },
    transmissionPriceIds: () => ['price_transmission'],
  });
  await erasure.eraseAccount({ userId: USER, reason: 'user_request' });
  assert.deepEqual(order, ['stripe.list', 'stripe.cancel', 'erase_user_data', 'wordpress', 'brevo']);
});

test('texte de la communauté effacé par défaut', async () => {
  await build().eraseAccount({ userId: USER, reason: 'user_request' });
  assert.equal(supabaseState.rpcCalls[0].params.p_erase_community_text, true);
});

test('compte fondateur : refusé, rien n’est touché', async () => {
  supabaseState.tables.profiles[0].is_founder = true;
  const result = await build().eraseAccount({ userId: USER, reason: 'user_request' });
  assert.deepEqual(result, { ok: false, code: 'founder_protected' });
  assert.equal(stripeState.calls.length, 0);
  assert.equal(supabaseState.rpcCalls.length, 0);
  assert.equal(supabaseState.tables.account_erasures.length, 0);
});

test('fondateur refusé aussi par la base (erase_user_data)', async () => {
  supabaseState.rpcHandlers.erase_user_data = async () => ({ data: null, error: { message: 'founder_protected' } });
  const result = await build().eraseAccount({ userId: USER, reason: 'user_request' });
  assert.deepEqual(result, { ok: false, code: 'founder_protected' });
  assert.equal(wpCalls.length, 0);
  assert.equal(brevoCalls.length, 0);
});

test('La Transmission en cours : refus, aucune résiliation, rien effacé', async () => {
  resetStripe({ customers: [{ id: 'cus_1' }], subscriptions: { cus_1: [sub('sub_1', 'active'), sub('sub_t', 'past_due', 'price_transmission')] } });
  const result = await build().eraseAccount({ userId: USER, reason: 'user_request' });
  assert.deepEqual(result, { ok: false, code: 'transmission_plan' });
  assert.equal(cancels().length, 0);
  assert.equal(supabaseState.rpcCalls.length, 0);
});

test('conservation : un abonnement en cours (réabonné) annule l’effacement, sans résilier', async () => {
  const result = await build().eraseAccount({ userId: USER, reason: 'retention_expired' });
  assert.deepEqual(result, { ok: false, code: 'active_subscription' });
  assert.equal(cancels().length, 0);
  assert.equal(supabaseState.rpcCalls.length, 0);
});

test('conservation : abonnements terminés → effacement', async () => {
  resetStripe({ customers: [{ id: 'cus_1' }], subscriptions: { cus_1: [sub('sub_1', 'canceled'), sub('sub_0', 'incomplete_expired')] } });
  const result = await build().eraseAccount({ userId: USER, reason: 'retention_expired' });
  assert.equal(result.ok, true);
  assert.equal(journal().reason, 'retention_expired');
});

test('compte gratuit sans client Stripe : aucun appel Stripe', async () => {
  supabaseState.tables.entitlements = [];
  const result = await build().eraseAccount({ userId: USER, reason: 'retention_expired' });
  assert.equal(result.ok, true);
  assert.equal(stripeState.calls.length, 0);
});

test('erreur Stripe : exception, rien n’est effacé', async () => {
  const erasure = createAccountErasure({
    supabase: fakeSupabase,
    stripe: { subscriptions: { list: async () => { throw new Error('Stripe indisponible'); } } },
    callLms: async () => ({ ok: true }),
    brevo: { deleteContact: async () => ({ ok: true }) },
  });
  await assert.rejects(erasure.eraseAccount({ userId: USER, reason: 'user_request' }), /Stripe indisponible/);
  assert.equal(supabaseState.rpcCalls.length, 0);
  assert.equal(supabaseState.tables.profiles.length, 1);
});

test('WordPress et Brevo en panne : Supabase effacé quand même, étapes en attente, email gardé pour la reprise', async () => {
  wpResult = { ok: false, httpStatus: 503 };
  brevoResult = { ok: false, error: 'network_error' };
  const result = await build().eraseAccount({ userId: USER, reason: 'user_request' });
  assert.deepEqual([result.ok, result.pending], [true, ['wordpress', 'brevo']]);
  const j = journal();
  assert.ok(j.supabase_erased_at);
  assert.equal(j.completed_at, undefined);
  assert.equal(j.email, 'homme@exemple.fr');
  assert.match(j.last_error, /wordpress:503/);
});

test('reprise : seules les étapes manquantes sont rejouées, puis le journal se termine', async () => {
  brevoResult = { ok: false, error: 'timeout' };
  const erasure = build();
  await erasure.eraseAccount({ userId: USER, reason: 'user_request' });
  brevoResult = { ok: true };
  const report = await erasure.resumePending();
  assert.deepEqual(report, { resumed: 1, completed: 1, stillPending: 0 });
  assert.equal(wpCalls.length, 1, 'WordPress déjà fait : pas rejoué');
  assert.equal(brevoCalls.length, 2);
  assert.ok(journal().completed_at);
  assert.equal(journal().email, null);
  assert.equal(rpcNames().filter((n) => n === 'erase_user_data').length, 1);
});

test('reprise : effacement Supabase interrompu → rejoué', async () => {
  supabaseState.tables.account_erasures.push({ id: 'j1', user_id: USER, reason: 'user_request', erase_community_text: true, email: 'homme@exemple.fr', attempts: 0 });
  const report = await build().resumePending();
  assert.equal(report.completed, 1);
  assert.equal(rpcNames()[0], 'erase_user_data');
  assert.equal(supabaseState.tables.profiles.length, 0);
});

test('double demande : le journal ouvert est réutilisé (un seul par compte)', async () => {
  wpResult = { ok: false, httpStatus: 500 };
  const erasure = build();
  await erasure.eraseAccount({ userId: USER, reason: 'user_request' });
  supabaseState.tables.profiles.push({ id: USER, is_founder: false, email: 'homme@exemple.fr' });
  await erasure.eraseAccount({ userId: USER, reason: 'user_request' });
  assert.equal(supabaseState.tables.account_erasures.length, 1);
});

test('raison inconnue : exception', async () => {
  await assert.rejects(build().eraseAccount({ userId: USER, reason: 'autre' }), /raison invalide/);
});
