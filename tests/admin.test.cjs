'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'admin-session';

function adminFake(actor, rpcImpl) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_verify_session') return { data: actor, error: null };
      if (typeof rpcImpl === 'function') return rpcImpl(name, args);
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

function authHeaders() { return { authorization: `Bearer ${TOKEN}` }; }

test('admin: MERCHANT nao acessa (403) - nem GET nem POST', async (t) => {
  const merchant = VALID_ACTORS.merchant;
  const fake = adminFake(merchant);
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);

  let res = await handler(makeEvent({ query: {}, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 403);
  res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'create_business' } }));
  assert.strictEqual(res.statusCode, 403);
});

test('admin: usa token do header e de body (legado) indistintamente', async (t) => {
  const fake = adminFake(VALID_ACTORS.admin, async (name) => {
    if (name === 'admin_toggle_business') return { data: null, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { action: 'toggle_business', businessId: 'b-1', isActive: false, sessionToken: TOKEN } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { ok: true });
});

test('admin: GET lista businesses -> admin_list_businesses', async (t) => {
  const calls = [];
  const fake = adminFake(VALID_ACTORS.admin, async (name, args) => {
    if (name === 'admin_list_businesses') { calls.push(args); return { data: [{ id: 'b-1' }], error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: {}, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_tenant_id, 't-1');
  assert.strictEqual(calls[0].p_actor_user_id, 'u-admin-1');
});

test('admin: POST create_business repassa dados de registro', async (t) => {
  const calls = [];
  const fake = adminFake(VALID_ACTORS.admin, async (name, args) => {
    if (name === 'admin_create_business') { calls.push(args); return { data: { businessId: 'b-novo' }, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: {
      action: 'create_business', name: 'Nova', category: 'COMIDA', city: 'Cid', phone: '11',
      email: 'e@x.y', ownerInternalCode: 'NOVA-01', ownerPin: '123456', billingPlan: 'PRO',
      cnpj: 'xx', website: null, logoUrl: null, lat: null, lng: null,
    },
  }));
  assert.strictEqual(res.statusCode, 200);
  const a = calls[0];
  assert.strictEqual(a.p_tenant_id, 't-1');
  assert.strictEqual(a.p_actor_user_id, 'u-admin-1');
  assert.strictEqual(a.p_owner_internal_code, 'NOVA-01');
  assert.strictEqual(a.p_owner_pin, '123456');
  assert.strictEqual(a.p_billing_plan, 'PRO');
});

test('admin: actions de billing/customer validas', async (t) => {
  const calls = [];
  const fake = adminFake(VALID_ACTORS.admin, async (name) => {
    calls.push(name);
    return { data: null, error: null };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);

  let res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'set_billing', businessId: 'b-1', plan: 'FREE', status: 'ACTIVE', feeCents: 0 } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0], 'admin_set_billing');

  res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'update_customer', customerId: 'c-1', name: 'João' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[1], 'admin_update_customer');

  res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'update_business', businessId: 'b-1', name: 'X' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[2], 'admin_update_business');
});

test('admin: mode billing e customers usam rpcs certas', async (t) => {
  const calls = [];
  const fake = adminFake(VALID_ACTORS.admin, async (name) => {
    calls.push(name);
    return { data: [], error: null };
  });
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);

  let res = await handler(makeEvent({ query: { mode: 'billing' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0], 'admin_billing_panel');

  res = await handler(makeEvent({ query: { mode: 'customers', search: 'jo' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[1], 'admin_list_customers');
});

test('admin: action desconhecida -> 400', async (t) => {
  const fake = adminFake(VALID_ACTORS.admin);
  const { handler, restore } = loadFunction('admin.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'nada' } }));
  assert.strictEqual(res.statusCode, 400);
});