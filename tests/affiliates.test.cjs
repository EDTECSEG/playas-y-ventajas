'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

test('POST / devolve afiliado existente por telefone (sem criar duplicado)', async (t) => {
  const fake = makeFakeSupabase({
    from: async (table) => {
      assert.strictEqual(table, 'affiliates');
      return { data: { id: 'a-1', referral_code: 'MARIA-7F3A' }, error: null };
    },
    rpc: async (name) => {
      assert.fail('nao deve chamar affiliate_register quando o afiliado ja existe');
      return { data: null, error: null };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: { name: 'Maria', phone: '+5511999999999' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).referralCode, 'MARIA-7F3A');
  assert.strictEqual(parseBody(res).shareUrl, '/?ref=MARIA-7F3A');
});

test('POST / cria afiliado novo via affiliate_register quando o telefone nao existe', async (t) => {
  const fake = makeFakeSupabase({
    from: async () => ({ data: null, error: null }),
    rpc: async (name, args) => {
      if (name === 'affiliate_register') {
        assert.strictEqual(args.p_tenant_id, TENANT);
        assert.strictEqual(args.p_name, 'Maria');
        assert.strictEqual(args.p_phone, '+5511999999999');
        assert.strictEqual(args.p_kind, 'customer');
        return { data: { affiliateId: 'a-2', referralCode: 'MARIA-9C2D', shareUrl: '/?ref=MARIA-9C2D' }, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: { name: 'Maria', phone: '+5511999999999' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).referralCode, 'MARIA-9C2D');
});

test('GET ?affiliateId&phone devolve o dashboard verificado por telefone', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'affiliate_dashboard') {
        assert.strictEqual(args.p_affiliate_id, 'a-1');
        assert.strictEqual(args.p_phone, '+5511999999999');
        return { data: { totalReferrals: 3, converted: 1 }, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { affiliateId: 'a-1', phone: '+5511999999999' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).totalReferrals, 3);
});

test('GET sem affiliateId/phone devolve 400', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: {} }));
  assert.strictEqual(res.statusCode, 400);
});

test('POST sem nome/telefone devolve 400', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { name: 'Maria' } }));
  assert.strictEqual(res.statusCode, 400);
});