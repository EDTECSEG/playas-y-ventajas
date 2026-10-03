'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, customerTokenFor } = require('./helpers.cjs');

const CLAIM = {
  publicId: 'PUB-1',
  customerId: 'c-1',
  couponId: '11111111-1111-4111-8111-111111111111',
  shortCode: 'ABC',
};

function claimFake({ onTax }) {
  return makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'claim_coupon') return { data: CLAIM, error: null };
      if (name === 'billing_record_coupon_tax') {
        if (onTax === 'throw') throw new Error('tax boom');
        if (onTax === 'error') return { data: null, error: { message: 'tax fail' } };
        return { data: true, error: null };
      }
      return { data: null, error: null };
    },
  });
}

function makeClaim() {
  return makeEvent({ method: 'POST', body: { tenantId: '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9', templateId: 'tmpl-1', phone: '5511999999999' } });
}

test('claim-coupon: resgate chama billing_record_coupon_tax com o cupom gerado', async (t) => {
  const fake = claimFake({ onTax: 'ok' });
  const { handler, restore } = loadFunction('claim-coupon.js', fake);
  t.after(restore);
  const res = await handler(makeClaim());
  assert.strictEqual(res.statusCode, 200);
  const tax = fake.calls.rpc.find((c) => c.name === 'billing_record_coupon_tax');
  assert.ok(tax, 'billing_record_coupon_tax deve ser chamado');
  assert.strictEqual(tax.args.p_tenant_id, '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9');
  assert.strictEqual(tax.args.p_template_id, 'tmpl-1');
  assert.strictEqual(tax.args.p_coupon_id, CLAIM.couponId);
  assert.strictEqual(parseBody(res).couponId, CLAIM.couponId);
});

test('claim-coupon: falha ao registrar a taxa nao derruba o resgate (best-effort)', async () => {
  for (const onTax of ['throw', 'error']) {
    const fake = claimFake({ onTax });
    const { handler, restore } = loadFunction('claim-coupon.js', fake);
    try {
      const res = await handler(makeClaim());
      assert.strictEqual(res.statusCode, 200, `onTax=${onTax}`);
      const body = parseBody(res);
      assert.strictEqual(body.couponId, CLAIM.couponId);
      assert.strictEqual(body.customerToken, customerTokenFor(CLAIM.customerId));
    } finally {
      restore();
    }
  }
});