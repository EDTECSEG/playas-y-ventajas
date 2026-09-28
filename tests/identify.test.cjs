'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

test('identify sem ref cadastra e devolve customerId + token, sem referral', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'identify_customer') return { data: '11111111-2222-3333-4444-555555555555', error: null };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('identify.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: { phone: '+5511999999999' } }));
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  assert.strictEqual(body.customerId, '11111111-2222-3333-4444-555555555555');
  assert.ok(/^[0-9a-f]{64}$/.test(body.customerToken), 'token HMAC de 64 hex');
  assert.strictEqual(body.referral, null);
});

test('identify com ref valido registra indicacao (referral_track) e devolve referral', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'identify_customer') return { data: '11111111-2222-3333-4444-555555555555', error: null };
      if (name === 'referral_track') {
        assert.strictEqual(args.p_tenant_id, TENANT);
        assert.strictEqual(args.p_referral_code, 'MARIA-7F3A');
        assert.strictEqual(args.p_referred_user_id, '11111111-2222-3333-4444-555555555555');
        return { data: null, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('identify.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: { phone: '+5511999999999', ref: 'MARIA-7F3A' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res).referral, { code: 'MARIA-7F3A' });
});

test('identify com ref invalido nao bloqueia o cadastro (fail-open, referral null)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'identify_customer') return { data: '11111111-2222-3333-4444-555555555555', error: null };
      if (name === 'referral_track') return { data: null, error: { message: 'referral code not found' } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('identify.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: { phone: '+5511999999999', ref: 'NAO-EXISTE' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).referral, null);
});

test('identify exige telefone', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('identify.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: {} }));
  assert.strictEqual(res.statusCode, 400);
});