'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'merchant-session';

function merchantFake(rpcImpl) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_verify_session') return { data: VALID_ACTORS.merchant, error: null };
      if (typeof rpcImpl === 'function') return rpcImpl(name, args);
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

function authHeaders() { return { authorization: `Bearer ${TOKEN}` }; }

test('empresa: update_my_data repassa p_category (atividade editável)', async (t) => {
  const fake = merchantFake(async (name, args) => {
    if (name === 'business_update_own') {
      assert.strictEqual(args.p_category, 'Restaurante');
      assert.strictEqual(args.p_city, 'Maceió');
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(),
    body: { action: 'update_my_data', name: 'Restaurante X', city: 'Maceió', category: 'Restaurante' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { ok: true });
});

test('empresa: update_my_data sem category manda null (não apaga a atual)', async (t) => {
  const fake = merchantFake(async (name, args) => {
    if (name === 'business_update_own') {
      assert.strictEqual(args.p_category, null);
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(),
    body: { action: 'update_my_data', name: 'Restaurante X' },
  }));
  assert.strictEqual(res.statusCode, 200);
});

test('empresa: set_coupon_featured chama business_set_coupon_featured com ISO até a data', async (t) => {
  const fake = merchantFake(async (name, args) => {
    if (name === 'business_set_coupon_featured') {
      assert.strictEqual(args.p_template_id, 'tpl-1');
      assert.match(args.p_until, /^2026-\d{2}-\d{2}T/);
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(),
    body: { action: 'set_coupon_featured', templateId: 'tpl-1', until: '2026-10-05T23:59:59' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.ok(parseBody(res).until, 'resposta deve trazer o until em ISO');
});

test('empresa: set_coupon_featured sem until limpa o destaque (null)', async (t) => {
  const fake = merchantFake(async (name, args) => {
    if (name === 'business_set_coupon_featured') {
      assert.strictEqual(args.p_until, null);
      return { data: null, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(),
    body: { action: 'set_coupon_featured', templateId: 'tpl-1' },
  }));
  assert.strictEqual(res.statusCode, 200);
});