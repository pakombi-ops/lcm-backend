const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const brevo = require('../src/brevo');

let calls, status;
const realFetch = brevo.deps.fetch;
beforeEach(() => {
  calls = []; status = 204;
  process.env.BREVO_API_KEY = 'cle-test';
  brevo.deps.fetch = async (url, init) => { calls.push({ url, init }); return { status }; };
});
after(() => { brevo.deps.fetch = realFetch; });

test('deleteContact : DELETE sur l’email encodé, en-tête api-key', async () => {
  assert.deepEqual(await brevo.deleteContact('jean+test@exemple.fr'), { ok: true, httpStatus: 204 });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/contacts/jean%2Btest%40exemple.fr');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.headers['api-key'], 'cle-test');
});

test('deleteContact : contact inexistant (404) = effacé', async () => {
  status = 404;
  assert.equal((await brevo.deleteContact('a@b.fr')).ok, true);
});

test('deleteContact : erreur 500 → ok:false', async () => {
  status = 500;
  assert.equal((await brevo.deleteContact('a@b.fr')).ok, false);
});

test('sans clé : aucun appel', async () => {
  delete process.env.BREVO_API_KEY;
  assert.deepEqual(await brevo.deleteContact('a@b.fr'), { ok: false, error: 'not_configured' });
  assert.equal(calls.length, 0);
});

test('sendTemplate : modèle absent ou invalide → aucun appel', async () => {
  for (const id of [undefined, '', 'abc', '0']) {
    assert.deepEqual(await brevo.sendTemplate(id, 'a@b.fr', {}), { ok: false, error: 'template_not_configured' });
  }
  assert.equal(calls.length, 0);
});

test('sendTemplate : POST /smtp/email avec le modèle et les paramètres', async () => {
  status = 201;
  assert.equal((await brevo.sendTemplate('12', 'a@b.fr', { PRENOM: 'Jean' })).ok, true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { templateId: 12, to: [{ email: 'a@b.fr' }], params: { PRENOM: 'Jean' } });
});
