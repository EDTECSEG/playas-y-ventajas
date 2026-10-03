'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

const CLAIM = {
  publicId: 'PUB-1',
  customerId: 'c-1',
  couponId: '11111111-1111-4111-8111-111111111111',
  shortCode: 'ABC',
};

// claimData permite simular o replay devolvido pela RPC (mesmo cupom, com
// idempotent=true) sem precisar encostar no banco.
function claimFake(claimData) {
  return makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'claim_coupon') return { data: claimData || CLAIM, error: null };
      return { data: null, error: null };
    },
  });
}

function makeClaim(extra) {
  return makeEvent({
    method: 'POST',
    body: Object.assign({ tenantId: 'OUTRO-TENANT-TENTANDO', templateId: 'tmpl-1', phone: '5511999999999' }, extra || {}),
  });
}

function claimArgs(fake) {
  const call = fake.calls.rpc.find((c) => c.name === 'claim_coupon');
  assert.ok(call, 'claim_coupon deve ser chamado');
  return call.args;
}

async function run(t, extra, claimData) {
  const fake = claimFake(claimData);
  const { handler, restore } = loadFunction('claim-coupon.js', fake);
  t.after(restore);
  const res = await handler(makeClaim(extra));
  assert.strictEqual(res.statusCode, 200);
  return { fake, res };
}

test('claim-coupon: a chave de idempotencia do cliente vai para a RPC', async (t) => {
  const { fake } = await run(t, { idempotencyKey: 'chave-do-cliente-123' });
  assert.strictEqual(claimArgs(fake).p_idempotency_key, 'chave-do-cliente-123');
});

test('claim-coupon: sem chave, manda null em vez de fabricar uma', async (t) => {
  const { fake } = await run(t, {});
  const args = claimArgs(fake);
  // Nao pode existir chave gerada no servidor: uma chave unica por requisicao
  // nunca seria lida num replay, so poluiria idempotency_keys com o rawToken.
  assert.strictEqual(args.p_idempotency_key, null);
});

test('claim-coupon: chave com espacos nas pontas e aparada', async (t) => {
  const { fake } = await run(t, { idempotencyKey: '  abc-123  ' });
  assert.strictEqual(claimArgs(fake).p_idempotency_key, 'abc-123');
});

test('claim-coupon: chave invalida degrada para null em vez de travar o resgate', async (t) => {
  const cases = [
    ['vazia', ''],
    ['so espacos', '   '],
    ['maior que o limite', 'x'.repeat(201)],
    ['no limite', 'x'.repeat(200)],
    ['numero', 12345],
    ['objeto', { a: 1 }],
    ['null', null],
  ];
  for (const [rotulo, valor] of cases) {
    const { fake } = await run(t, { idempotencyKey: valor });
    const esperado = rotulo === 'no limite' ? 'x'.repeat(200) : null;
    assert.strictEqual(claimArgs(fake).p_idempotency_key, esperado, rotulo);
  }
});

test('claim-coupon: o tenant continua fixo, nunca vindo do corpo', async (t) => {
  const { fake } = await run(t, { idempotencyKey: 'k-1' });
  assert.strictEqual(claimArgs(fake).p_tenant_id, TENANT);
});

test('claim-coupon: o replay idempotente chega ao cliente', async (t) => {
  const replay = Object.assign({}, CLAIM, { idempotent: true });
  const { res } = await run(t, { idempotencyKey: 'k-1' }, replay);
  const body = parseBody(res);
  assert.strictEqual(body.idempotent, true);
  assert.strictEqual(body.couponId, CLAIM.couponId);
});