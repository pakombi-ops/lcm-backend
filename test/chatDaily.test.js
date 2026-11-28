// Fichier séparé : les limites sont lues au chargement de src/index.js
// (node --test lance chaque fichier dans son propre processus).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.CHAT_RATE_MAX = '1000';
process.env.CHAT_USER_RATE_MAX = '1000';
process.env.CHAT_USER_DAILY_MAX = '2';

const { loadChatApp } = require('./support/chatApp');
const { resetSupabase } = require('./support/fakes');
const { listen, postJson } = require('./support/http');

const app = loadChatApp();
let server;
before(async () => { server = await listen(app); });
after(async () => { await server.close(); });

test('limite quotidienne par compte → 429 daily_limit', async () => {
  const user = { id: 'premium-1', email: 'p@exemple.fr' };
  resetSupabase({
    tokens: { jeton: user },
    tables: {
      entitlements: [{ supabase_user_id: 'premium-1', status: 'active', access_expires_at: null }],
      user_consents: [{ user_id: 'premium-1', purpose: 'coach', action: 'granted' }],
    },
  });
  const auth = { Authorization: 'Bearer jeton' };
  const send = () => postJson(`${server.baseUrl}/api/chat-simple`, { message: 'Salut' }, auth);
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  const res = await send();
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'daily_limit');
});
