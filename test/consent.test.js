const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.CHAT_RATE_MAX = '1000';
process.env.CHAT_USER_RATE_MAX = '1000';
process.env.CHAT_USER_DAILY_MAX = '1000';

const { loadChatApp, anthropicCalls } = require('./support/chatApp');
const { resetSupabase, supabaseState } = require('./support/fakes');
const { listen, postJson } = require('./support/http');
const { createRequireConsent } = require('../src/consent');

const app = loadChatApp();
let server;
before(async () => { server = await listen(app); });
after(async () => { await server.close(); });
beforeEach(() => { anthropicCalls.length = 0; });

const USER = { id: 'u-consent', email: 'c@exemple.fr' };
const AUTH = { Authorization: 'Bearer jeton-c' };
const withConsents = (events, extra = {}) =>
  resetSupabase({ tokens: { 'jeton-c': USER }, tables: { user_consents: events }, ...extra });

for (const route of ['/api/chat-simple', '/api/chat']) {
  test(`${route} : 403 consent_required sans accord, le modèle n'est jamais appelé`, async () => {
    withConsents([]);
    const res = await postJson(`${server.baseUrl}${route}`, { message: 'Je dors mal' }, AUTH);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'consent_required', purpose: 'coach' });
    assert.equal(anthropicCalls.length, 0);
    assert.deepEqual(supabaseState.rpcCalls.find((c) => c.name === 'has_consent').params, { p_user_id: 'u-consent', p_purpose: 'coach' });
  });

  test(`${route} : accord retiré → 403, accord redonné → 200`, async () => {
    withConsents([
      { user_id: 'u-consent', purpose: 'coach', action: 'granted' },
      { user_id: 'u-consent', purpose: 'coach', action: 'withdrawn' },
    ]);
    assert.equal((await postJson(`${server.baseUrl}${route}`, { message: 'Salut' }, AUTH)).status, 403);
    withConsents([
      { user_id: 'u-consent', purpose: 'coach', action: 'withdrawn' },
      { user_id: 'u-consent', purpose: 'coach', action: 'granted' },
    ]);
    assert.equal((await postJson(`${server.baseUrl}${route}`, { message: 'Salut' }, AUTH)).status, 200);
  });

  test(`${route} : l'accord au journal ne vaut pas pour le coach`, async () => {
    withConsents([{ user_id: 'u-consent', purpose: 'journal', action: 'granted' }]);
    assert.equal((await postJson(`${server.baseUrl}${route}`, { message: 'Salut' }, AUTH)).status, 403);
    assert.equal(anthropicCalls.length, 0);
  });

  test(`${route} : vérification impossible → 503, rien n'est envoyé au modèle`, async () => {
    withConsents([{ user_id: 'u-consent', purpose: 'coach', action: 'granted' }], { consentError: true });
    const res = await postJson(`${server.baseUrl}${route}`, { message: 'Salut' }, AUTH);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'consent_check_failed' });
    assert.equal(anthropicCalls.length, 0);
  });

  test(`${route} : sans jeton → 401 avant toute vérification de consentement`, async () => {
    withConsents([]);
    const res = await postJson(`${server.baseUrl}${route}`, { message: 'Salut' }, {});
    assert.equal(res.status, 401);
    assert.equal(supabaseState.rpcCalls.filter((c) => c.name === 'has_consent').length, 0);
  });
}

test('createRequireConsent : objet inconnu refusé au démarrage', () => {
  assert.throws(() => createRequireConsent({}, 'autre'));
});
