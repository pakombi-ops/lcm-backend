const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakes, resetSupabase, fakeSupabase } = require('./support/fakes');

installFakes();
const { createQuota } = require('../src/quota');
const { PREMIUM_STATUSES } = require('../src/billingStatus');
const { SUSPEND_STATUSES } = require('../src/lmsSync');

test('Premium et suspension de la formation : listes disjointes, past_due donne le Premium', () => {
  assert.deepEqual(PREMIUM_STATUSES, ['trialing', 'active', 'past_due']);
  for (const s of SUSPEND_STATUSES) assert.ok(!PREMIUM_STATUSES.includes(s), s);
});

for (const [status, expected] of [['trialing', true], ['active', true], ['past_due', true], ['canceled', false], ['unpaid', false], ['paused', false], ['incomplete_expired', false], ['incomplete', false]]) {
  test(`quota.isEntitled : ${status} → ${expected}`, async () => {
    resetSupabase({ tables: { entitlements: [{ supabase_user_id: 'u1', status }] } });
    assert.equal(await createQuota(fakeSupabase).isEntitled('u1'), expected);
  });
}

test('quota.isEntitled : past_due avec une date de fin dépassée → pas de Premium', async () => {
  resetSupabase({ tables: { entitlements: [{ supabase_user_id: 'u1', status: 'past_due', access_expires_at: '2020-01-01T00:00:00Z' }] } });
  assert.equal(await createQuota(fakeSupabase).isEntitled('u1'), false);
});
