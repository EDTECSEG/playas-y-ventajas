'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'billing-session';
const SUB_ID = '2c9380848a5a8a3a018a5a9f4f6d0008';
const INIT = 'https://www.mercadopago.com.br/checkout/v1/redirect?pref-id=abc';
const PREPARE_DATA = {
  businessId: 'b-1',
  tenantId: 't-1',
  ownerEmail: 'dono@x.y',
  businessName: 'Bar do Zé',
  transactionAmount: 99.9,
  reason: 'Bar do Zé - Plano PRO',
};

function billingFake(actor, rpcImpl) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_verify_session') return { data: actor, error: null };
      if (typeof rpcImpl === 'function') return rpcImpl(name, args);
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

function authHeaders() { return { authorization: `Bearer ${TOKEN}` }; }

function installFetchMock(handlerFn) {
  const orig = global.fetch;
  global.fetch = handlerFn;
  return () => { global.fetch = orig; };
}

function mpOk(json) {
  return { ok: true, status: 200, json: async () => json };
}

test('billing: MERCHANT dono pode criar assinatura (cria no MP e registra)', async (t) => {
  const calls = [];
  const fake = billingFake(VALID_ACTORS.merchant, async (name) => {
    calls.push(name);
    if (name === 'billing_mp_prepare') return { data: { ...PREPARE_DATA }, error: null };
    if (name === 'billing_mp_register') return { data: true, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('billing.js', fake);
  t.after(restore);

  const restores = [];
  const fetchCalls = [];
  t.after(() => {
    delete process.env.MP_ACCESS_TOKEN;
    delete process.env.MP_NOTIFICATION_URL;
  });
  process.env.MP_ACCESS_TOKEN = 'TEST-123';
  process.env.MP_NOTIFICATION_URL = 'https://playas.example/.netlify/functions/billing-webhook';
  restores.push(installFetchMock(async (url, opts) => {
    fetchCalls.push({ url, opts });
    return mpOk({ id: SUB_ID, init_point: INIT });
  }));
  t.after(() => restores.forEach((r) => r()));

  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'create', businessId: 'b-1' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { initPoint: INIT, subscriptionId: SUB_ID, already: false });

  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.endsWith('/preapproval'));
  const sent = JSON.parse(fetchCalls[0].opts.body);
  assert.strictEqual(sent.status, 'pending');
  assert.strictEqual(sent.auto_recurring.frequency, 1);
  assert.strictEqual(sent.auto_recurring.frequency_type, 'months');
  assert.strictEqual(sent.auto_recurring.transaction_amount, 99.9);
  assert.strictEqual(sent.notification_url, 'https://playas.example/.netlify/functions/billing-webhook');

  const reg = fake.calls.rpc.find((r) => r.name === 'billing_mp_register');
  assert.ok(reg);
  assert.strictEqual(reg.args.p_subscription_id, SUB_ID);
  assert.strictEqual(reg.args.p_subscription_url, INIT);
});

test('billing: create com assinatura existente reabre o mesmo url sem chamar o MP', async (t) => {
  const fake = billingFake(VALID_ACTORS.merchant, async (name) => {
    if (name === 'billing_mp_prepare') return { data: { ...PREPARE_DATA, subscriptionId: SUB_ID, subscriptionUrl: INIT }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('billing.js', fake);
  t.after(restore);

  let fetchCalled = false;
  const origFetch = global.fetch;
  global.fetch = async () => { fetchCalled = true; return mpOk({}); };
  t.after(() => { global.fetch = origFetch; });

  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'create', businessId: 'b-1' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { initPoint: INIT, subscriptionId: SUB_ID, already: true });
  assert.strictEqual(fetchCalled, false);
});

test('billing: status devolve a assinatura quando existe', async (t) => {
  const fake = billingFake(VALID_ACTORS.merchant, async (name) => {
    if (name === 'billing_mp_prepare') return { data: { ...PREPARE_DATA, subscriptionId: SUB_ID, subscriptionUrl: INIT }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('billing.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'status', businessId: 'b-1' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { subscriptionId: SUB_ID, subscriptionUrl: INIT });
});

test('billing: status sem assinatura devolve nulos', async (t) => {
  const fake = billingFake(VALID_ACTORS.merchant, async (name) => {
    if (name === 'billing_mp_prepare') return { data: { ...PREPARE_DATA }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('billing.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'status', businessId: 'b-1' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { subscriptionId: null, subscriptionUrl: null });
});

test('billing: cancel avisa o MP e limpa a assinatura local', async (t) => {
  const calls = [];
  const fake = billingFake(VALID_ACTORS.merchant, async (name) => {
    calls.push(name);
    if (name === 'billing_mp_prepare') return { data: { ...PREPARE_DATA, subscriptionId: SUB_ID, subscriptionUrl: INIT }, error: null };
    if (name === 'billing_mp_cancel') return { data: true, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('billing.js', fake);
  t.after(restore);

  const fetchCalls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => { fetchCalls.push({ url, opts }); return mpOk({}); };
  t.after(() => { global.fetch = origFetch; });
  process.env.MP_ACCESS_TOKEN = 'TEST-123';
  t.after(() => { delete process.env.MP_ACCESS_TOKEN; });

  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'cancel', businessId: 'b-1' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { ok: true });
  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.endsWith('/preapproval/' + SUB_ID));
  assert.strictEqual(JSON.parse(fetchCalls[0].opts.body).status, 'cancelled');
  assert.strictEqual(calls[1], 'billing_mp_cancel');
});

test('billing: papel sem permissao (DRIVER) -> 403', async (t) => {
  const fake = billingFake({ userId: 'u-driver-1', tenantId: 't-1', role: 'DRIVER', businessId: 'b-1' });
  const { handler, restore } = loadFunction('billing.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'create', businessId: 'b-1' } }));
  assert.strictEqual(res.statusCode, 403);
});

test('billing: erro do MP vira 500 sem vazar detalhe', async (t) => {
  const fake = billingFake(VALID_ACTORS.merchant, async (name) => {
    if (name === 'billing_mp_prepare') return { data: { ...PREPARE_DATA }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('billing.js', fake);
  t.after(restore);
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ message: 'invalid_token' }) });
  t.after(() => { global.fetch = origFetch; });
  process.env.MP_ACCESS_TOKEN = 'TEST-123';
  t.after(() => { delete process.env.MP_ACCESS_TOKEN; });

  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'create', businessId: 'b-1' } }));
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(parseBody(res), { error: 'erro interno' });
});

test('billing: action desconhecida -> 400', async (t) => {
  const fake = billingFake(VALID_ACTORS.merchant);
  const { handler, restore } = loadFunction('billing.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { action: 'nada', businessId: 'b-1' } }));
  assert.strictEqual(res.statusCode, 400);
});