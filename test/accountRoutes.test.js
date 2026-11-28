const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakes, resetSupabase, resetStripe, supabaseState, stripeState } = require('./support/fakes');
const { listen, postJson } = require('./support/http');

installFakes();
const SECRET = 'secret-make-de-test-0123456789';
process.env.MAKE_SHARED_SECRET = SECRET;
process.env.TRANSMISSION_PRICE_IDS = 'price_transmission';
process.env.PC_LMS_BASE_URL = 'https://wp.test';

const express = require('express');
const accountRoutes = require('../routes/account');
const lmsSync = require('../src/lmsSync');
const brevo = require('../src/brevo');

const DAY = 86400000;
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const sub = (id, status) => ({ id, status, created: 1, items: { data: [{ price: { id: 'price_app' } }] } });

let external;
const realLmsFetch = lmsSync.deps.fetch;
const realBrevoFetch = brevo.deps.fetch;
beforeEach(() => {
  external = [];
  lmsSync.deps.fetch = async (url, init) => {
    external.push({ to: 'wordpress', url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ success: true, found: true }) };
  };
  brevo.deps.fetch = async (url, init) => {
    external.push({ to: 'brevo', url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { status: init.method === 'DELETE' ? 204 : 201 };
  };
  process.env.PC_LMS_SECRET = 'secret-wordpress-de-test-0123456789';
  process.env.BREVO_API_KEY = 'cle-brevo-test';
  process.env.BREVO_TEMPLATE_ERASURE_J30 = '30';
  process.env.BREVO_TEMPLATE_ERASURE_J7 = '7';
  process.env.ENABLE_ACCOUNT_DELETE = 'true';
  delete process.env.ENABLE_RETENTION_ERASURE;

  const fresh = { id: 'u1', email: 'homme@exemple.fr', last_sign_in_at: iso(-60 * 1000) };
  const stale = { id: 'u1', email: 'homme@exemple.fr', last_sign_in_at: iso(-10 * 60 * 1000) };
  resetSupabase({
    tokens: { frais: fresh, ancien: stale },
    authUsers: [{ id: 'u1', email: 'homme@exemple.fr' }],
    tables: {
      profiles: [{ id: 'u1', is_founder: false, email: 'homme@exemple.fr' }],
      entitlements: [{ supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'active' }],
      account_erasures: [],
    },
  });
  supabaseState.rpcHandlers.erase_user_data = async () => ({ data: { profiles: 1 }, error: null });
  supabaseState.rpcHandlers.refresh_last_seen = async () => ({ data: 0, error: null });
  supabaseState.rpcHandlers.retention_candidates = async () => ({ data: [], error: null });
  resetStripe({ customers: [{ id: 'cus_1' }], subscriptions: { cus_1: [sub('sub_1', 'active')] } });
});
after(() => { lmsSync.deps.fetch = realLmsFetch; brevo.deps.fetch = realBrevoFetch; });

async function start(t) {
  const app = express();
  app.use(express.json());
  app.use('/api', accountRoutes);
  const ctx = await listen(app);
  t.after(ctx.close);
  return ctx;
}

async function del(t, { token = 'frais', body = { confirm: 'SUPPRIMER' } } = {}) {
  const ctx = await start(t);
  const res = await fetch(`${ctx.baseUrl}/api/account`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function run(t, body = {}, headers = { 'x-make-secret': SECRET }) {
  const ctx = await start(t);
  const res = await postJson(`${ctx.baseUrl}/api/maintenance/retention-run`, body, headers);
  return { status: res.status, body: await res.json() };
}

// ------------------------------------------------------------ DELETE /api/account

test('DELETE /api/account : 503 tant que ENABLE_ACCOUNT_DELETE n’est pas activé, rien n’est lu', async (t) => {
  delete process.env.ENABLE_ACCOUNT_DELETE;
  const { status } = await del(t);
  assert.equal(status, 503);
  assert.equal(supabaseState.rpcCalls.length, 0);
  assert.equal(stripeState.calls.length, 0);
});

test('DELETE /api/account : 401 sans jeton', async (t) => {
  assert.equal((await del(t, { token: null })).status, 401);
});

test('DELETE /api/account : 400 sans le mot « SUPPRIMER »', async (t) => {
  for (const body of [{}, { confirm: 'supprimer' }, { confirm: 'OUI' }]) {
    const { status, body: res } = await del(t, { body });
    assert.deepEqual([status, res.error], [400, 'confirmation_required']);
  }
  assert.equal(stripeState.calls.length, 0);
});

test('DELETE /api/account : 403 si le code email date de plus de 5 minutes', async (t) => {
  const { status, body } = await del(t, { token: 'ancien' });
  assert.deepEqual([status, body.error], [403, 'reauth_required']);
  assert.equal(stripeState.calls.length, 0);
});

test('DELETE /api/account : résilie, efface, et renvoie le résultat', async (t) => {
  const { status, body } = await del(t, { body: { confirm: 'SUPPRIMER', eraseCommunityText: false } });
  assert.equal(status, 200);
  assert.deepEqual(body, { deleted: true, canceledSubscriptions: 1, pending: [] });
  assert.equal(supabaseState.rpcCalls[0].params.p_erase_community_text, false);
  assert.deepEqual(external.map((e) => e.to), ['wordpress', 'brevo']);
  assert.equal(external[0].url, 'https://wp.test/wp-json/pc-lms/v1/delete-user');
});

test('DELETE /api/account : compte fondateur → 409, rien d’effacé', async (t) => {
  supabaseState.tables.profiles[0].is_founder = true;
  const { status, body } = await del(t);
  assert.deepEqual([status, body.error], [409, 'founder_protected']);
  assert.equal(supabaseState.rpcCalls.length, 0);
});

test('DELETE /api/account : erreur technique → 500 sans détail', async (t) => {
  supabaseState.rpcHandlers.erase_user_data = async () => ({ data: null, error: { message: 'permission denied for table users' } });
  const { status, body } = await del(t);
  assert.deepEqual([status, body], [500, { error: 'delete_failed' }]);
});

// ------------------------------------------------------------ tâche de conservation

const candidate = (eraseInDays, extra = {}) => ({
  user_id: 'u1', email: 'homme@exemple.fr', prenom: 'Jean',
  last_activity_at: iso((eraseInDays - 183) * DAY), erase_after: iso(eraseInDays * DAY),
  warn30_sent_at: null, warn7_sent_at: null, ...extra,
});

test('retention-run : 401 sans secret Make', async (t) => {
  const { status } = await run(t, {}, {});
  assert.equal(status, 401);
  assert.equal(supabaseState.rpcCalls.length, 0);
});

test('retention-run : simulation par défaut, même avec dryRun:false sans ENABLE_RETENTION_ERASURE', async (t) => {
  supabaseState.rpcHandlers.retention_candidates = async () => ({ data: [candidate(20), candidate(-1, { warn30_sent_at: iso(-40 * DAY), warn7_sent_at: iso(-8 * DAY) })], error: null });
  for (const body of [{}, { dryRun: false }]) {
    external = [];
    const { status, body: report } = await run(t, body);
    assert.equal(status, 200);
    assert.equal(report.mode, 'dry_run');
    assert.deepEqual([report.warned30, report.erased], [['u1'], ['u1']]);
    assert.equal(external.length, 0, 'aucun email, aucun effacement');
  }
  assert.ok(!supabaseState.rpcCalls.some((c) => c.name === 'erase_user_data'));
});

test('retention-run : mode réel → email J-30 via Brevo, date notée sur le profil, jamais d’email dans la réponse', async (t) => {
  process.env.ENABLE_RETENTION_ERASURE = 'true';
  supabaseState.rpcHandlers.retention_candidates = async () => ({ data: [candidate(20)], error: null });
  const { body: report } = await run(t, { dryRun: false });
  assert.equal(report.mode, 'live');
  assert.deepEqual(report.warned30, ['u1']);
  const mail = external.find((e) => e.to === 'brevo');
  assert.equal(mail.body.templateId, 30);
  assert.deepEqual(mail.body.to, [{ email: 'homme@exemple.fr' }]);
  assert.equal(mail.body.params.PRENOM, 'Jean');
  assert.ok(supabaseState.tables.profiles[0].erasure_warn30_sent_at);
  assert.ok(!JSON.stringify(report).includes('@'));
});

test('retention-run : email non envoyé → date non notée (donc pas d’effacement plus tard)', async (t) => {
  process.env.ENABLE_RETENTION_ERASURE = 'true';
  delete process.env.BREVO_TEMPLATE_ERASURE_J30;
  supabaseState.rpcHandlers.retention_candidates = async () => ({ data: [candidate(20)], error: null });
  const { body: report } = await run(t, { dryRun: false });
  assert.deepEqual(report.warned30, []);
  assert.equal(report.errors[0].error, 'template_not_configured');
  assert.equal(supabaseState.tables.profiles[0].erasure_warn30_sent_at, undefined);
});

test('retention-run : mode réel → effacement après les deux avertissements, abonnement terminé', async (t) => {
  process.env.ENABLE_RETENTION_ERASURE = 'true';
  resetStripe({ customers: [{ id: 'cus_1' }], subscriptions: { cus_1: [sub('sub_1', 'canceled')] } });
  supabaseState.rpcHandlers.retention_candidates = async () => ({
    data: [candidate(-1, { warn30_sent_at: iso(-40 * DAY), warn7_sent_at: iso(-8 * DAY) })], error: null,
  });
  const { body: report } = await run(t, { dryRun: false });
  assert.deepEqual(report.erased, ['u1']);
  const erase = supabaseState.rpcCalls.find((c) => c.name === 'erase_user_data');
  assert.deepEqual(erase.params, { p_user_id: 'u1', p_erase_community_text: true });
  assert.equal(supabaseState.tables.account_erasures[0].reason, 'retention_expired');
});

test('retention-run : réabonné entre-temps (Stripe en direct) → refusé, rien effacé', async (t) => {
  process.env.ENABLE_RETENTION_ERASURE = 'true';
  supabaseState.rpcHandlers.retention_candidates = async () => ({
    data: [candidate(-1, { warn30_sent_at: iso(-40 * DAY), warn7_sent_at: iso(-8 * DAY) })], error: null,
  });
  const { body: report } = await run(t, { dryRun: false });
  assert.deepEqual(report.refused, [{ id: 'u1', code: 'active_subscription' }]);
  assert.ok(!supabaseState.rpcCalls.some((c) => c.name === 'erase_user_data'));
  assert.equal(stripeState.calls.filter((c) => c.fn === 'subscriptions.cancel').length, 0);
});

test('retention-run : au plus 20 effacements par passage', async (t) => {
  supabaseState.rpcHandlers.retention_candidates = async () => ({
    data: Array.from({ length: 25 }, (_, i) => candidate(-1, { user_id: `u${i}`, warn30_sent_at: iso(-40 * DAY), warn7_sent_at: iso(-8 * DAY) })),
    error: null,
  });
  const { body: report } = await run(t);
  assert.equal(report.erased.length, 20);
  assert.equal(report.skipped, 5);
});

test('retention-run : la mesure d’activité est relancée à chaque passage', async (t) => {
  await run(t);
  assert.equal(supabaseState.rpcCalls[0].name, 'refresh_last_seen');
});
