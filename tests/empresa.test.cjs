'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'merchant-session';

function actorFake(actor, rpcImpl) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_verify_session') {
        assert.strictEqual(args.p_session_token, TOKEN);
        return { data: actor, error: null };
      }
      if (typeof rpcImpl === 'function') return rpcImpl(name, args);
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

function authHeaders() { return { authorization: `Bearer ${TOKEN}` }; }

test('empresa: sem token -> 401', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: {} }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'SESSION_REQUIRED');
});

test('empresa: GET dashboard usa o businessId do ator (nunca do cliente)', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'empresa_dashboard') { calls.push(args); return { data: { ok: 1 }, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: {}, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_tenant_id, 't-1');
  assert.strictEqual(calls[0].p_business_id, 'b-1');
});

test('empresa: GET mode=my-data chama business_get_own com o userId do ator', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_get_own') { calls.push(args); return { data: { name: 'Loja X' }, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { mode: 'my-data' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_actor_user_id, 'u-merchant-1');
});

test('empresa: ator sem businessId -> 400', async (t) => {
  const admin = { userId: 'u-admin-1', tenantId: 't-1', role: 'ADMIN', businessId: null };
  const fake = actorFake(admin);
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: {}, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 400);
});

test('empresa: POST create_template repassa parametros e usa ids do ator', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'create_coupon_template') { calls.push(args); return { data: { templateId: 'tpl-9' }, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'create_template', campaignId: 'camp-1', title: 'Bônus', benefitType: 'PERCENT', benefitValue: 10, totalStock: 50, imageUrl: null },
  }));
  assert.strictEqual(res.statusCode, 200);
  const a = calls[0];
  assert.strictEqual(a.p_tenant_id, 't-1');
  assert.strictEqual(a.p_business_id, 'b-1');
  assert.strictEqual(a.p_actor_user_id, 'u-merchant-1');
  assert.strictEqual(a.p_campaign_id, 'camp-1');
  assert.strictEqual(a.p_title, 'Bônus');
  assert.strictEqual(a.p_benefit_type, 'PERCENT');
  assert.strictEqual(a.p_benefit_value, 10);
  assert.strictEqual(a.p_total_stock, 50);
});

test('empresa: POST update_my_data atualiza dados proprios', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_update_own') { calls.push(args); return { data: null, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'update_my_data', name: 'Nova', phone: '11', email: 'x@y.z', city: 'Cid', logoUrl: 'https://cdn.example.test/a.png' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_name, 'Nova');
  assert.deepStrictEqual(parseBody(res), { ok: true });
});

test('empresa: action invalida -> 400', async (t) => {
  const fake = actorFake(VALID_ACTORS.merchant);
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'hack' } }));
  assert.strictEqual(res.statusCode, 400);
});