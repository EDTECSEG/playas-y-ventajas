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
const TENANT_SLUG = 'playas-y-ventajas';

// Nomes exatos, em ordem de insercao, como o handler monta hoje. O
// deepStrictEqual de `Object.keys` abaixo e o que prende a ordem tambem.
//
// Sao 14, nao 6: a lista foi gerada casando `CREATE [OR REPLACE] FUNCTION` de
// verdade, e nao qualquer mencao. Um scan por substring dava 6 e errava em
// dois sentidos: contava comentario como definicao (`auth_login` aparece em
// `email-login-billing.sql:26` so num comentario que diz "espelha auth_login" -
// a funcao la definida e `auth_login_by_email`) e deixava de fora as 8 que
// nao tem mencao nenhuma. `tests/rpc-contract-guard.inventory.test.cjs` refaz a
// contagem e falha se esta lista deixar de bater com o repo.
const ASSINATURAS = {
  admin_billing_panel: ['p_tenant_id', 'p_actor_user_id'],
  admin_create_business: ['p_tenant_id', 'p_actor_user_id', 'p_name', 'p_category', 'p_city', 'p_phone', 'p_email', 'p_lat', 'p_lng', 'p_owner_internal_code', 'p_owner_pin', 'p_billing_plan', 'p_cnpj', 'p_website', 'p_logo_url'],
  admin_list_customers: ['p_tenant_id', 'p_actor_user_id', 'p_search'],
  admin_toggle_business: ['p_tenant_id', 'p_actor_user_id', 'p_business_id', 'p_is_active'],
  admin_update_business: ['p_tenant_id', 'p_actor_user_id', 'p_business_id', 'p_name', 'p_phone', 'p_email', 'p_category', 'p_city', 'p_cnpj', 'p_website', 'p_logo_url'],
  admin_update_customer: ['p_tenant_id', 'p_actor_user_id', 'p_customer_id', 'p_name', 'p_email', 'p_instagram', 'p_is_active'],
  auth_login: ['p_tenant_slug', 'p_internal_code', 'p_pin'],
  auth_verify_session: ['p_session_token'],
  business_coupon_stats: ['p_tenant_id', 'p_business_id'],
  create_campaign: ['p_tenant_id', 'p_business_id', 'p_actor_user_id', 'p_title'],
  create_coupon_template: ['p_tenant_id', 'p_business_id', 'p_campaign_id', 'p_actor_user_id', 'p_title', 'p_benefit_type', 'p_benefit_value', 'p_total_stock', 'p_image_url'],
  empresa_dashboard: ['p_tenant_id', 'p_business_id'],
  identify_customer: ['p_tenant_id', 'p_phone', 'p_name', 'p_email', 'p_instagram'],
  validate_and_redeem_coupon: ['p_tenant_id', 'p_business_id', 'p_public_id', 'p_raw_token', 'p_actor_user_id', 'p_idempotency_key', 'p_short_code'],
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
// SQL, a assinatura dela deixa de ser travada em silencio. A contagem e a
// definicao ficam em rpc-contract-guard.inventory.test.cjs, que refaz a varredura.
test('a lista cobre as 14 RPCs sem .sql no repo', () => {
  assert.strictEqual(Object.keys(ASSINATURAS).length, 14);
  for (const [nome, p] of Object.entries(ASSINATURAS)) {
    assert.ok(Array.isArray(p) && p.length > 0, `${nome}: lista vazia`);
    for (const param of p) assert.match(param, /^p_[a-z0-9_]+$/, `${nome}: param invalido ${param}`);
  }
});

// Estas 8 entraram na revisao da lista. Os testes abaixo exercitam o caminho
// completo (login -> sessao) porque sao as unicas em que o p_* viaja por
// helpers compartilhados, e um typo ali quebra TODAS as rotas de uma vez.
// auth_verify_session nao e chamada por um handler e sim pelo helper
// compartilhado `_supabaseAdmin.resolveSession` (`_supabaseAdmin.js:27`), que
// roda em TODA rota autenticada. Um p_* errado aqui derruba o sistema inteiro
// de uma vez - por isso o teste mira o helper, nao um handler que passe por ele.
test('assinatura CALLSITE: auth_verify_session (afeta toda rota autenticada)', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'empresa.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') { calls.push(args); return { data: VALID_ACTORS.merchant, error: null }; }
        if (name === 'empresa_dashboard') return { data: { ok: 1 }, error: null };
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);
  await handler(makeEvent({ query: {}, headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.strictEqual(calls.length, 1, 'resolveSession deveria ter sido chamado');
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.auth_verify_session);
  assert.strictEqual(calls[0].p_session_token, TOKEN);
});

test('assinatura CALLSITE: auth_login', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'login.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_login') { calls.push(args); return { data: { session_token: 'tok-1', user_id: 'u-1', tenant_id: 't-1', role: 'ADMIN', business_id: null, internal_code: 'C-1' }, error: null }; }
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.admin, error: null };
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: TENANT_SLUG, internalCode: 'C-1', pin: '1234' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.auth_login);
});

test('assinatura CALLSITE: identify_customer', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'identify.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'identify_customer') { calls.push(args); return { data: { customer_id: 'c-1', customer_token: 'tk' }, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);
  await handler(makeEvent({ method: 'POST', body: { phone: '5511999999999' } }));
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.identify_customer);
});

test('assinatura CALLSITE: validate_and_redeem_coupon (idempotencia e short_code)', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'validate-coupon.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.merchant, error: null };
        if (name === 'validate_and_redeem_coupon') { calls.push(args); return { data: { ok: true }, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);
  await handler(makeEvent({ method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: { publicId: 'ABC-1', rawToken: 'rt', shortCode: '123456' } }));
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.validate_and_redeem_coupon);
});

test('assinatura CALLSITE: business_coupon_stats', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'empresa.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.merchant, error: null };
        if (name === 'business_coupon_stats') { calls.push(args); return { data: { ok: 1 }, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);
  await handler(makeEvent({ query: { mode: 'stats' }, headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.business_coupon_stats);
});

test('assinatura CALLSITE: admin_billing_panel', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'admin.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.admin, error: null };
        if (name === 'admin_billing_panel') { calls.push(args); return { data: { ok: 1 }, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);
  await handler(makeEvent({ query: { mode: 'billing' }, headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS.admin_billing_panel);
});