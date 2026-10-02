'use strict';

// Trava a ASSINATURA das RPCs que existem em producao mas nao tem .sql no
// repositorio. Sao as unicas em que o call-site do handler e a fonte da
// verdade: sem o SQL, nada mais no repo diz quais p_* a funcao aceita.
//
// Sem este teste, um p_* renomeado no handler so quebra em producao, e o
// PostgREST responde "function ... does not exist" para o usuario. O teste
// nao garante que a assinatura bate com o banco (isso exige MCP/CLI): garante
// que o lado do repo para de mudar em silencio.
//
// Quando o SQL de uma delas for versionado, este teste vira redundante e pode
// sair: a passa de `assinatura: CALLSITE` para `assinatura: VERSIONADA`.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'sessao';

// Nomes exatos, em ordem de insercao, como o handler monta hoje. O
// deepStrictEqual de `Object.keys` abaixo e o que prende a ordem tambem.
const ASSINATURAS = {
  admin_list_customers: ['p_tenant_id', 'p_actor_user_id', 'p_search'],
  admin_toggle_business: ['p_tenant_id', 'p_actor_user_id', 'p_business_id', 'p_is_active'],
  admin_update_customer: ['p_tenant_id', 'p_actor_user_id', 'p_customer_id', 'p_name', 'p_email', 'p_instagram', 'p_is_active'],
  admin_update_business: ['p_tenant_id', 'p_actor_user_id', 'p_business_id', 'p_name', 'p_phone', 'p_email', 'p_category', 'p_city', 'p_cnpj', 'p_website', 'p_logo_url'],
  create_campaign: ['p_tenant_id', 'p_business_id', 'p_actor_user_id', 'p_title'],
  empresa_dashboard: ['p_tenant_id', 'p_business_id'],
};

// Uma unica RPC por teste: se o servidor mockado rejeitar o resto, a falha
// aponta a RPC culpada em vez de um "unexpected rpc" generico. O ator e sempre
// ADMIN, porque e o unico papel que admin.js aceita.
function fakeAceitando(rpcName, sink, returnData) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_verify_session') {
        return { data: VALID_ACTORS.admin, error: null };
      }
      if (name === rpcName) {
        sink.push(args);
        return { data: returnData === undefined ? null : returnData, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

test('assinatura CALLSITE: admin_list_customers', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'admin.js',
    fakeAceitando('admin_list_customers', calls, []),
  );
  t.after(restore);

  const res = await handler(makeEvent({
    query: { mode: 'customers', search: 'jo' },
    headers: { authorization: `Bearer ${TOKEN}` },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.admin_list_customers);
  // O filtro da UI vai em p_search, nao em p_query_string.
  assert.strictEqual(calls[0].p_search, 'jo');
});

test('assinatura CALLSITE: admin_toggle_business', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'admin.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.admin, error: null };
        if (name === 'admin_toggle_business') { calls.push(args); return { data: null, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { action: 'toggle_business', businessId: 'b-1', isActive: false },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.admin_toggle_business);
  assert.strictEqual(calls[0].p_business_id, 'b-1');
  assert.strictEqual(calls[0].p_is_active, false);
});

test('assinatura CALLSITE: admin_update_customer', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'admin.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.admin, error: null };
        if (name === 'admin_update_customer') { calls.push(args); return { data: null, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: {
      action: 'update_customer',
      customerId: 'cust-1',
      name: 'Jo',
      email: 'jo@x.com',
      instagram: '@jo',
      isActive: true,
    },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.admin_update_customer);
  assert.strictEqual(calls[0].p_instagram, '@jo');
});

test('assinatura CALLSITE: admin_update_business', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'admin.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.admin, error: null };
        if (name === 'admin_update_business') { calls.push(args); return { data: null, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { action: 'update_business', businessId: 'b-1', name: 'Padaria' },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.admin_update_business);
  // Campos ausentes no body vao como null, nunca undefined solto: o PostgREST
  // rejeita undefined e o `|| null` existe para isso.
  for (const k of ASSINATURAS.admin_update_business) {
    assert.notStrictEqual(calls[0][k], undefined, `p_ausente: ${k} chegou undefined`);
  }
});

test('assinatura CALLSITE: create_campaign (sem .sql, sem teste ate agora)', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'empresa.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.merchant, error: null };
        if (name === 'create_campaign') { calls.push(args); return { data: { id: 'camp-1' }, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { action: 'create_campaign', title: 'Outono' },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.create_campaign);
  assert.strictEqual(calls[0].p_title, 'Outono');
  // businessId vem do ATOR, nunca do body: se alguem mandar businessId no body
  // para escrever em outro estabelecimento, o parametro nem existe.
  assert.strictEqual(calls[0].p_business_id, VALID_ACTORS.merchant.businessId);
});

test('assinatura CALLSITE: empresa_dashboard', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'empresa.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.merchant, error: null };
        if (name === 'empresa_dashboard') { calls.push(args); return { data: { ok: 1 }, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);

  const res = await handler(makeEvent({
    query: {},
    headers: { authorization: `Bearer ${TOKEN}` },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.empresa_dashboard);
  assert.strictEqual(calls[0].p_business_id, VALID_ACTORS.merchant.businessId);
});

// Trava a lista em si: se alguem apagar uma entrada daqui sem versionar o
// SQL, a assinatura dela deixa de ser travada em silencio.
test('a lista cobre exatamente as 6 RPCs sem .sql no repo', () => {
  assert.strictEqual(Object.keys(ASSINATURAS).length, 6);
  for (const [nome, p] of Object.entries(ASSINATURAS)) {
    assert.ok(Array.isArray(p) && p.length > 0, `${nome}: lista vazia`);
    for (const param of p) assert.match(param, /^p_[a-z0-9_]+$/, `${nome}: param invalido ${param}`);
  }
});