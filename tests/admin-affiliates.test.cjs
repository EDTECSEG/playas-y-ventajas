'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'admin-session';

function adminFake(rpcImpl) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_verify_session') return { data: VALID_ACTORS.admin, error: null };
      if (typeof rpcImpl === 'function') return rpcImpl(name, args);
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

function authHeaders() { return { authorization: `Bearer ${TOKEN}` }; }

test('admin: GET mode=affiliates chama admin_affiliate_report', async (t) => {
  const fake = adminFake(async (name, args) => {
    if (name === 'admin_affiliate_report') {
      assert.strictEqual(args.p_actor_user_id, VALID_ACTORS.admin.userId);
      return { data: [{ name: 'Maria', referralCode: 'MARIA-7F3A', converted: 1, totalReferrals: 2 }], error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { mode: 'affiliates' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res)[0].referralCode, 'MARIA-7F3A');
});

test('admin: GET mode=affiliate-rewards devolve { config }', async (t) => {
  const fake = adminFake(async (name) => {
    if (name === 'admin_get_affiliate_rewards') return { data: { welcomeTemplateId: 'w-1' }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { mode: 'affiliate-rewards' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { config: { welcomeTemplateId: 'w-1' } });
});

test('admin: POST set_affiliate_rewards repassa templates e requireFirstClaim', async (t) => {
  const fake = adminFake(async (name, args) => {
    if (name === 'admin_set_affiliate_rewards') {
      assert.strictEqual(args.p_affiliate_reward_template_id, 'tpl-reward');
      assert.strictEqual(args.p_welcome_template_id, 'tpl-welcome');
      assert.strictEqual(args.p_require_first_claim, true);
      return {
        data: { affiliateRewardTemplateId: 'tpl-reward', welcomeTemplateId: 'tpl-welcome', requireFirstClaim: true },
        error: null,
      };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(),
    body: { action: 'set_affiliate_rewards', affiliateRewardTemplateId: 'tpl-reward', welcomeTemplateId: 'tpl-welcome', requireFirstClaim: true },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).welcomeTemplateId, 'tpl-welcome');
});

test('admin: POST set_coupon_featured (override) chama admin_set_coupon_featured com ISO', async (t) => {
  const fake = adminFake(async (name, args) => {
    if (name === 'admin_set_coupon_featured') {
      assert.strictEqual(args.p_template_id, 'tpl-1');
      assert.match(args.p_until, /^2026-/);
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(),
    body: { action: 'set_coupon_featured', templateId: 'tpl-1', until: '2026-10-10T00:00:00' },
  }));
  assert.strictEqual(res.statusCode, 200);
});