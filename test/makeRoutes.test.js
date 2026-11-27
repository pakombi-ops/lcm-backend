const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakes, resetSupabase, resetStripe, supabaseState, stripeState } = require('./support/fakes');
const { listen, postJson } = require('./support/http');

installFakes();
const SECRET = 'secret-make-de-test-0123456789';
process.env.MAKE_SHARED_SECRET = SECRET;

const express = require('express');
const entitlementsRoutes = require('../routes/entitlements');
const { STRIPE_SUBSCRIPTION_STATUSES, normalizeEmail, firstNameFrom } = require('../routes/entitlements');

const MAKE = { 'x-make-secret': SECRET };

async function start() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', entitlementsRoutes);
  return listen(app);
}

const activeSub = (id = 'sub_1') => ({
  id,
  status: 'active',
  created: 1,
  trial_end: null,
  items: { data: [{ price: { id: 'price_app', nickname: 'mensuel' } }] },
});

beforeEach(() => {
  resetSupabase();
  resetStripe();
  process.env.MAKE_SHARED_SECRET = SECRET;
});

// ------------------------------------------------------------ secret Make (comportement de a49b96c, non-régression)

for (const [route, body] of [
  ['/api/update-entitlement', { stripeCustomerId: 'cus_1', status: 'active' }],
  ['/api/provision-account', { email: 'homme@exemple.fr', stripeCustomerId: 'cus_1' }],
]) {
  test(`${route} : 401 sans x-make-secret ou avec un mauvais secret, rien n'est lu ni écrit`, async (t) => {
    const ctx = await start();
    t.after(ctx.close);
    for (const headers of [{}, { 'x-make-secret': 'x'.repeat(SECRET.length) }, { 'x-make-secret': 'court' }]) {
      const res = await postJson(`${ctx.baseUrl}${route}`, body, headers);
      assert.equal(res.status, 401);
    }
    assert.equal(stripeState.calls.length, 0);
    assert.equal(supabaseState.writes.length, 0);
  });
}

// ------------------------------------------------------------ update-entitlement : liste fermée

test('update-entitlement : accepte chaque statut Stripe de la liste fermée', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  for (const status of STRIPE_SUBSCRIPTION_STATUSES) {
    resetSupabase({ tables: { entitlements: [{ supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'active' }] } });
    const res = await postJson(`${ctx.baseUrl}/api/update-entitlement`, { stripeCustomerId: 'cus_1', status }, MAKE);
    assert.equal(res.status, 200, status);
    assert.equal(supabaseState.tables.entitlements[0].status, status);
  }
});

test('update-entitlement : 400 sur un statut hors liste, rien n’est écrit', async (t) => {
  resetSupabase({ tables: { entitlements: [{ supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'canceled' }] } });
  const ctx = await start();
  t.after(ctx.close);
  for (const status of ['premium', 'ACTIVE', 'expired', 'inactive', ['active'], { $ne: 1 }]) {
    const res = await postJson(`${ctx.baseUrl}/api/update-entitlement`, { stripeCustomerId: 'cus_1', status }, MAKE);
    assert.equal(res.status, 400, JSON.stringify(status));
    assert.equal((await res.json()).code, 'invalid_status');
  }
  assert.equal(supabaseState.writes.length, 0);
  assert.equal(supabaseState.tables.entitlements[0].status, 'canceled');
});

test('update-entitlement : met à jour et synchronise ai_quota (comportement inchangé)', async (t) => {
  resetSupabase({ tables: { entitlements: [{ supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'trialing' }] } });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/update-entitlement`, { stripeCustomerId: 'cus_1', status: 'canceled' }, MAKE);
  assert.deepEqual(await res.json(), { updated: true });
  const quota = supabaseState.writes.find((w) => w.table === 'ai_quota');
  assert.deepEqual([quota.row.user_id, quota.row.is_premium], ['u1', false]);
});

test('update-entitlement : ne retire pas un accès à durée fixe en cours (comportement inchangé)', async (t) => {
  resetSupabase({
    tables: {
      entitlements: [{
        supabase_user_id: 'u1', stripe_customer_id: 'cus_1', status: 'active',
        access_expires_at: new Date(Date.now() + 86400000).toISOString(),
      }],
    },
  });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/update-entitlement`, { stripeCustomerId: 'cus_1', status: 'canceled' }, MAKE);
  assert.deepEqual(await res.json(), { updated: false, reason: 'fixed_term_access_running' });
  assert.equal(supabaseState.writes.length, 0);
});

// ------------------------------------------------------------ provision-account : email du client Stripe

test('provision-account : provisionne quand l’email correspond au client Stripe (casse et espaces ignorés)', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', email: 'Homme@Exemple.fr' }], subscriptions: { cus_1: [activeSub()] } });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: ' homme@exemple.FR ', prenom: 'Jo', stripeCustomerId: 'cus_1' }, MAKE);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.success, body.createdNewUser, body.status], [true, true, 'active']);
  const ent = supabaseState.tables.entitlements[0];
  assert.deepEqual([ent.purchase_email, ent.stripe_customer_id, ent.status], ['homme@exemple.fr', 'cus_1', 'active']);
});

test('provision-account : tunnel app, le supabaseUserId des métadonnées est retenu si son email correspond', async (t) => {
  resetSupabase({ authUsers: [{ id: 'u-app', email: 'homme@exemple.fr' }] });
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [activeSub()] } });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: 'homme@exemple.fr', stripeCustomerId: 'cus_1', supabaseUserId: 'u-app' }, MAKE);
  const body = await res.json();
  assert.deepEqual([body.userId, body.createdNewUser], ['u-app', false]);
});

test('provision-account : email du client Stripe avec espaces et majuscules → accepté, email stocké normalisé', async (t) => {
  resetStripe({ customers: [{ id: 'cus_1', email: '  HOMME@exemple.fr\t' }], subscriptions: { cus_1: [activeSub()] } });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: 'Homme@Exemple.Fr', stripeCustomerId: 'cus_1' }, MAKE);
  assert.equal(res.status, 200);
  assert.equal(supabaseState.tables.entitlements[0].purchase_email, 'homme@exemple.fr');
});

test('provision-account : tunnel app, supabaseUserId retenu même si l’email du compte diffère par la casse ou les espaces', async (t) => {
  resetSupabase({ authUsers: [{ id: 'u-app', email: ' Homme@Exemple.FR ' }] });
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [activeSub()] } });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: 'HOMME@exemple.fr ', stripeCustomerId: 'cus_1', supabaseUserId: 'u-app' }, MAKE);
  const body = await res.json();
  assert.deepEqual([body.userId, body.createdNewUser], ['u-app', false]);
});

test('provision-account : tunnel app, supabaseUserId d’un autre email ignoré (pas de vol par l’identifiant)', async (t) => {
  resetSupabase({ authUsers: [{ id: 'u-victime', email: 'victime@exemple.fr' }] });
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [activeSub()] } });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: 'homme@exemple.fr', stripeCustomerId: 'cus_1', supabaseUserId: 'u-victime' }, MAKE);
  const body = await res.json();
  assert.notEqual(body.userId, 'u-victime');
  assert.equal(supabaseState.tables.entitlements.some((e) => e.supabase_user_id === 'u-victime'), false);
});

test('normalizeEmail : casse et espaces ignorés, valeur absente ou non textuelle → null', () => {
  assert.equal(normalizeEmail('  Homme@Exemple.FR '), 'homme@exemple.fr');
  assert.equal(normalizeEmail('homme @exemple.fr'), 'homme@exemple.fr');
  assert.equal(normalizeEmail('homme@exemple.fr\n'), 'homme@exemple.fr');
  for (const v of [null, undefined, '', '   ', 42, ['a@b.fr'], { a: 1 }]) assert.equal(normalizeEmail(v), null, JSON.stringify(v));
});

test('provision-account : 403 si l’email ne correspond pas au client Stripe (vol d’abonnement)', async (t) => {
  resetStripe({ customers: [{ id: 'cus_victime', email: 'victime@exemple.fr' }], subscriptions: { cus_victime: [activeSub()] } });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: 'attaquant@exemple.fr', stripeCustomerId: 'cus_victime' }, MAKE);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'email_mismatch');
  assert.equal(supabaseState.writes.length, 0, 'aucun compte créé, aucune écriture');
  assert.deepEqual(stripeState.calls.map((c) => c.fn), ['customers.retrieve'], 'abonnements jamais lus');
});

test('provision-account : 403 avec un client sans abonnement visant une victime (rétrogradation)', async (t) => {
  resetSupabase({
    authUsers: [{ id: 'u-victime', email: 'victime@exemple.fr' }],
    tables: { entitlements: [{ supabase_user_id: 'u-victime', stripe_customer_id: 'cus_v', status: 'active' }] },
  });
  resetStripe({ customers: [{ id: 'cus_vide', email: 'attaquant@exemple.fr' }] });
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: 'victime@exemple.fr', stripeCustomerId: 'cus_vide' }, MAKE);
  assert.equal(res.status, 403);
  const ent = supabaseState.tables.entitlements[0];
  assert.deepEqual([ent.status, ent.stripe_customer_id], ['active', 'cus_v'], 'accès de la victime intact');
});

test('provision-account : 403 si le client Stripe n’a pas d’email ou est supprimé', async (t) => {
  resetStripe({ customers: [{ id: 'cus_sans', email: null }, { id: 'cus_suppr', deleted: true }] });
  const ctx = await start();
  t.after(ctx.close);
  for (const id of ['cus_sans', 'cus_suppr']) {
    const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: 'homme@exemple.fr', stripeCustomerId: id }, MAKE);
    assert.equal(res.status, 403, id);
  }
  assert.equal(supabaseState.writes.length, 0);
});

test('provision-account : 400 si le client Stripe n’existe pas', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, { email: 'homme@exemple.fr', stripeCustomerId: 'cus_inconnu' }, MAKE);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'unknown_customer');
});

test('provision-account : 400 si email ou stripeCustomerId ne sont pas des chaînes', async (t) => {
  const ctx = await start();
  t.after(ctx.close);
  for (const body of [{}, { email: ['a@b.fr'], stripeCustomerId: 'cus_1' }, { email: 'a@b.fr', stripeCustomerId: { $gt: '' } }]) {
    const res = await postJson(`${ctx.baseUrl}/api/provision-account`, body, MAKE);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

// ------------------------------------------------------------ provision-account : prénom depuis customer_details.name

test('firstNameFrom : premier mot, espaces retirés, null si vide ou non textuel', () => {
  assert.equal(firstNameFrom('Jean Dupont'), 'Jean');
  assert.equal(firstNameFrom('  Tonton Claude '), 'Tonton');
  assert.equal(firstNameFrom('Jean-Pierre Martin'), 'Jean-Pierre');
  assert.equal(firstNameFrom('\tJo\n'), 'Jo');
  for (const v of ['', '   ', null, undefined, 42, {}]) assert.equal(firstNameFrom(v), null);
});

async function provisionWithProfile(t, profile, prenom) {
  resetSupabase({
    authUsers: [{ id: 'u1', email: 'homme@exemple.fr' }],
    tables: profile ? { profiles: [{ id: 'u1', ...profile }] } : {},
  });
  resetStripe({ customers: [{ id: 'cus_1', email: 'homme@exemple.fr' }], subscriptions: { cus_1: [activeSub()] } });
  const ctx = await start();
  t.after(ctx.close);
  const body = { email: 'homme@exemple.fr', stripeCustomerId: 'cus_1', supabaseUserId: '' };
  if (prenom !== undefined) body.prenom = prenom;
  const res = await postJson(`${ctx.baseUrl}/api/provision-account`, body, MAKE);
  assert.equal(res.status, 200);
  return supabaseState.tables.profiles.find((p) => p.id === 'u1');
}

for (const current of [undefined, null, '', '  ', 'Utilisateur', 'utilisateur ']) {
  test(`provision-account : prénom actuel ${JSON.stringify(current)} → remplacé par le premier mot du nom`, async (t) => {
    const profile = await provisionWithProfile(t, current === undefined ? null : { prenom: current }, '  Tonton Claude ');
    assert.equal(profile.prenom, 'Tonton');
  });
}

test('provision-account : un prénom choisi dans l’app n’est jamais écrasé', async (t) => {
  const profile = await provisionWithProfile(t, { prenom: 'Johann' }, 'Jean Dupont');
  assert.equal(profile.prenom, 'Johann');
});

for (const prenom of [undefined, '', '   ', null]) {
  test(`provision-account : nom ${JSON.stringify(prenom)} depuis Make → le prénom existant n’est pas effacé`, async (t) => {
    const profile = await provisionWithProfile(t, { prenom: 'Utilisateur' }, prenom);
    assert.equal(profile.prenom, 'Utilisateur');
    const write = supabaseState.writes.find((w) => w.table === 'profiles' && w.op === 'upsert');
    assert.equal('prenom' in write.row, false);
  });
}

// ------------------------------------------------------------ grant-access (La Transmission) : même règle pour le prénom

async function grantWithProfile(t, profile, prenom) {
  resetSupabase({
    authUsers: [{ id: 'u1', email: 'homme@exemple.fr' }],
    tables: profile ? { profiles: [{ id: 'u1', ...profile }] } : {},
  });
  const ctx = await start();
  t.after(ctx.close);
  const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  const body = { email: 'homme@exemple.fr', planType: 'transmission_groupe', expiresAt };
  if (prenom !== undefined) body.prenom = prenom;
  const res = await postJson(`${ctx.baseUrl}/api/grant-access`, body, MAKE);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  return supabaseState.tables.profiles.find((p) => p.id === 'u1');
}

for (const current of [undefined, null, '', 'Utilisateur']) {
  test(`grant-access : prénom actuel ${JSON.stringify(current)} → remplacé par le premier mot du nom`, async (t) => {
    const profile = await grantWithProfile(t, current === undefined ? null : { prenom: current }, ' Jean Dupont ');
    assert.equal(profile.prenom, 'Jean');
  });
}

test('grant-access : un prénom choisi dans l’app n’est jamais écrasé', async (t) => {
  const profile = await grantWithProfile(t, { prenom: 'Johann' }, 'Jean Dupont');
  assert.equal(profile.prenom, 'Johann');
});

for (const prenom of [undefined, '', '   ', null]) {
  test(`grant-access : nom ${JSON.stringify(prenom)} depuis Make → le prénom existant n’est pas effacé`, async (t) => {
    const profile = await grantWithProfile(t, { prenom: 'Johann' }, prenom);
    assert.equal(profile.prenom, 'Johann');
    const write = supabaseState.writes.find((w) => w.table === 'profiles' && w.op === 'upsert');
    assert.equal('prenom' in write.row, false);
  });
}

test('grant-access : nouveau compte → prénom = premier mot', async (t) => {
  resetSupabase();
  const ctx = await start();
  t.after(ctx.close);
  const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
  const res = await postJson(`${ctx.baseUrl}/api/grant-access`, { email: 'neuf@exemple.fr', prenom: 'Marc Antoine', planType: 'transmission_1a1', expiresAt }, MAKE);
  assert.equal(res.status, 200);
  const { userId } = await res.json();
  assert.equal(supabaseState.tables.profiles.find((p) => p.id === userId).prenom, 'Marc');
});
