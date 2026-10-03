'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, customerTokenFor } = require('./helpers.cjs');

const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';
const VICTIM_CUSTOMER = '11111111-2222-3333-4444-555555555555';

test('my-coupons sem customerToken retorna 401 e NAO chama list_customer_coupons (anti-IDOR)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_customer_coupons') return { data: ['leaked'], error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    query: { tenantId: TENANT, mode: 'my-coupons', customerId: VICTIM_CUSTOMER },
  }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'CUSTOMER_TOKEN_INVALID');
  assert.strictEqual(fake.calls.rpc.length, 0, 'não deve chamar nenhuma RPC sem token');
});

test('my-coupons com token adulterado retorna 401', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    query: { tenantId: TENANT, mode: 'my-coupons', customerId: VICTIM_CUSTOMER, customerToken: 'aa'.repeat(32) },
  }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'CUSTOMER_TOKEN_INVALID');
});

test('my-coupons com token valido retorna 200 e chama list_customer_coupons com o customerId certo', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'list_customer_coupons') {
        assert.strictEqual(args.p_customer_id, VICTIM_CUSTOMER);
        assert.strictEqual(args.p_tenant_id, TENANT);
        return { data: [{ publicId: 'C-1', title: 'Bônus' }], error: null };
      }
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    query: { tenantId: TENANT, mode: 'my-coupons', customerId: VICTIM_CUSTOMER, customerToken: customerTokenFor(VICTIM_CUSTOMER) },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), [{ publicId: 'C-1', title: 'Bônus' }]);
});

test('my-coupons nao aceita token de outro cliente (token do atacante com id da vitima)', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const attackerToken = customerTokenFor('99999999-0000-0000-0000-000000000000');
  const res = await handler(makeEvent({
    query: { tenantId: TENANT, mode: 'my-coupons', customerId: VICTIM_CUSTOMER, customerToken: attackerToken },
  }));
  assert.strictEqual(res.statusCode, 401);
});

test('listagem de ofertas sem modo continua funcional (leitura publica)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_offers') return { data: [{ templateId: 'tpl-1' }], error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), [{ templateId: 'tpl-1' }]);
});

test('offers ignora tenantId da query e usa o tenant fixo (anti-IDOR)', async (t) => {
  // Regressao: tenantId vinha da query string e ia direto para as cinco RPCs
  // pelo client de administracao. Trocar o UUID por outro listava ofertas,
  // categorias e cidades de outro tenant -- e, em my-coupons, os cupons de
  // outro tenant, porque verifyCustomerToken so assina o customerId.
  const INIMIGO = '11111111-2222-4333-8444-555555555555';
  const seen = [];
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      seen.push({ name, tenant: args.p_tenant_id });
      if (name === 'list_offers') return { data: [{ templateId: 'tpl-1' }], error: null };
      if (name === 'list_cities') return { data: ['Recife'], error: null };
      if (name === 'list_categories') return { data: ['food'], error: null };
      return { data: null, error: { message: 'unexpected ' + name } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  for (const query of [
    { tenantId: INIMIGO },
    { tenantId: INIMIGO, mode: 'cities' },
    { tenantId: INIMIGO, mode: 'categories' },
  ]) {
    const res = await handler(makeEvent({ query }));
    assert.strictEqual(res.statusCode, 200, 'o parametro nao pode mais barrar a requisicao');
  }

  assert.strictEqual(seen.length, 3, 'as tres RPCs rodam normalmente');
  for (const call of seen) {
    assert.strictEqual(call.tenant, TENANT, `${call.name} deve usar o tenant fixo`);
  }
});

test('offers sem tenantId na query funciona (o parametro virou opcional)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_offers') return { data: [], error: null };
      return { data: null, error: { message: 'unexpected ' + name } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: {} }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), []);
});

test('my-coupons ignora tenantId da query (token valido nao compra tenant alheio)', async (t) => {
  const INIMIGO = '11111111-2222-4333-8444-555555555555';
  const fake = makeFakeSupabase({ rpc: async () => ({ data: [], error: null }) });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    query: {
      tenantId: INIMIGO,
      mode: 'my-coupons',
      customerId: VICTIM_CUSTOMER,
      customerToken: customerTokenFor(VICTIM_CUSTOMER),
    },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(fake.calls.rpc.length, 1);
  assert.strictEqual(fake.calls.rpc[0].args.p_tenant_id, TENANT);
});