'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createHmac } = require('crypto');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const SECRET = 'test-webhook-secret';
const SUB_ID = '2c9380848a5a8a3a018a5a9f4f6d0008';
const PAY_ID = '1324567890';
const REQ_ID = '3e4c4f7a-9a1b-4c2d-8e3f-1a2b3c4d5e6f';

// Mesma construção do manifest do handler (doc do MP: id, request-id?, ts, `;`).
function mpSignature({ dataId, ts = Math.floor(Date.now() / 1000), withRequestId = true }) {
  const fields = ['id:' + dataId];
  if (withRequestId) fields.push('request-id:' + REQ_ID);
  fields.push('ts:' + ts);
  const v1 = createHmac('sha256', SECRET).update(fields.join(';') + ';').digest('hex');
  return { ts, v1 };
}

function webhookFake(rpcImpl) {
  return makeFakeSupabase({ rpc: async (name, args) => (typeof rpcImpl === 'function' ? rpcImpl(name, args) : { data: true, error: null }) });
}

function authHeadersFor({ ts, v1 }) {
  return { ts: String(ts), 'x-request-id': REQ_ID, 'x-signature': `ts=${ts},v1=${v1}` };
}

function installEnvSecret() {
  process.env.MP_WEBHOOK_SECRET = SECRET;
  process.env.MP_ACCESS_TOKEN = 'TEST-123';
  return () => {
    delete process.env.MP_WEBHOOK_SECRET;
    delete process.env.MP_ACCESS_TOKEN;
  };
}

function installFetchMock(json) {
  const orig = global.fetch;
  global.fetch = async (url) => ({ ok: true, status: 200, json: async () => json, url });
  return () => { global.fetch = orig; };
}

test('billing-webhook: subscription_authorized_payment valida, busca o pagamento e registra a cobranca', async (t) => {
  const calls = [];
  const fake = webhookFake(async (name, args) => {
    calls.push({ name, args });
    if (name === 'billing_mp_webhook_charge') return { data: true, error: null };
    return { data: true, error: null };
  });
  const { handler, restore } = loadFunction('billing-webhook.js', fake);
  t.after(restore);
  t.after(installEnvSecret());

  const fetchUrls = [];
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    fetchUrls.push(String(url).replace('https://api.mercadopago.com', ''));
    return { ok: true, status: 200, json: async () => ({ preapproval_id: SUB_ID, transaction_amount: 29.9 }) };
  };
  t.after(() => { global.fetch = origFetch; });

  const sig = mpSignature({ dataId: PAY_ID });
  const res = await handler(makeEvent({
    method: 'POST',
    query: { ['data.id']: PAY_ID, type: 'subscription_authorized_payment' },
    headers: authHeadersFor(sig),
    body: { action: 'payment.created', type: 'subscription_authorized_payment', data: { id: PAY_ID } },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { ok: true });
  assert.strictEqual(fetchUrls[0], '/authorized_payments/' + PAY_ID);
  const charge = calls.find((c) => c.name === 'billing_mp_webhook_charge');
  assert.ok(charge);
  assert.deepStrictEqual(charge.args, { p_subscription_id: SUB_ID, p_payment_id: PAY_ID, p_amount_cents: 2990 });
});

test('billing-webhook: subscription_preapproval atualiza o status via RPC', async (t) => {
  const calls = [];
  const fake = webhookFake(async (name, args) => {
    calls.push({ name, args });
    return { data: true, error: null };
  });
  const { handler, restore } = loadFunction('billing-webhook.js', fake);
  t.after(restore);
  t.after(installEnvSecret());

  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: SUB_ID, status: 'authorized' }) });
  t.after(() => { global.fetch = origFetch; });

  const sig = mpSignature({ dataId: SUB_ID });
  const res = await handler(makeEvent({
    method: 'POST',
    query: { ['data.id']: SUB_ID, type: 'subscription_preapproval' },
    headers: authHeadersFor(sig),
    body: { type: 'subscription_preapproval', data: { id: SUB_ID } },
  }));

  assert.strictEqual(res.statusCode, 200);
  const pre = calls.find((c) => c.name === 'billing_mp_webhook_preapproval');
  assert.ok(pre);
  assert.deepStrictEqual(pre.args, { p_subscription_id: SUB_ID, p_status: 'authorized' });
});

test('billing-webhook: assinatura omitida -> 403 sem header x-signature', async (t) => {
  const fake = webhookFake();
  const { handler, restore } = loadFunction('billing-webhook.js', fake);
  t.after(restore);
  t.after(installEnvSecret());

  const res = await handler(makeEvent({
    method: 'POST',
    query: { ['data.id']: PAY_ID },
    headers: { ts: String(Math.floor(Date.now() / 1000)) },
    body: { type: 'subscription_authorized_payment', data: { id: PAY_ID } },
  }));
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(parseBody(res), { error: 'assinatura invalida' });
});

test('billing-webhook: v1 adulterado -> 403', async (t) => {
  const fake = webhookFake();
  const { handler, restore } = loadFunction('billing-webhook.js', fake);
  t.after(restore);
  t.after(installEnvSecret());

  const sig = mpSignature({ dataId: PAY_ID });
  t.after(() => {});
  const tampered = { ts: sig.ts, v1: sig.v1.slice(0, 63) + (sig.v1[63] === '0' ? '1' : '0') };
  const res = await handler(makeEvent({
    method: 'POST',
    query: { ['data.id']: PAY_ID },
    headers: authHeadersFor(tampered),
    body: { type: 'subscription_authorized_payment', data: { id: PAY_ID } },
  }));
  assert.strictEqual(res.statusCode, 403);
});

test('billing-webhook: timestamp antigo (replay) -> 403', async (t) => {
  const fake = webhookFake();
  const { handler, restore } = loadFunction('billing-webhook.js', fake);
  t.after(restore);
  t.after(installEnvSecret());

  const sig = mpSignature({ dataId: PAY_ID, ts: Math.floor(Date.now() / 1000) - 7200 });
  const res = await handler(makeEvent({
    method: 'POST',
    query: { ['data.id']: PAY_ID },
    headers: authHeadersFor(sig),
    body: { type: 'subscription_authorized_payment', data: { id: PAY_ID } },
  }));
  assert.strictEqual(res.statusCode, 403);
});

test('billing-webhook: tipo desconhecido responde 200 e nao chama RPC', async (t) => {
  const calls = [];
  const fake = webhookFake(async (name) => { calls.push(name); return { data: true, error: null }; });
  const { handler, restore } = loadFunction('billing-webhook.js', fake);
  t.after(restore);
  t.after(installEnvSecret());

  const sig = mpSignature({ dataId: '123456789' });
  const res = await handler(makeEvent({
    method: 'POST',
    query: { ['data.id']: '123456789', type: 'payment' },
    headers: authHeadersFor(sig),
    body: { type: 'payment' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { ok: true });
  assert.strictEqual(calls.length, 0);
});

test('billing-webhook: GET -> 405', async (t) => {
  const fake = webhookFake();
  const { handler, restore } = loadFunction('billing-webhook.js', fake);
  t.after(restore);
  t.after(installEnvSecret());
  const res = await handler(makeEvent({ method: 'GET' }));
  assert.strictEqual(res.statusCode, 405);
});