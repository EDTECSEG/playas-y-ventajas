'use strict';

// Trava a ASSINATURA das RPCs que os handlers chamam, para que o lado repo
// pare de mudar em silencio. Uma RPC com .sql no repo tem a assinatura no
// proprio SQL; o que falta e travar que o HANDLER mande exatamente os p_* e a
// ordem que o banco espera. Sem este teste, um p_* renomeado no handler so
// quebra em producao, e o PostgREST responde "function ... does not exist"
// para o usuario. O teste nao garante que a assinatura bate com o banco (isso
// exige MCP/CLI): garante que o call-site do repo nao deriva.
//
// HISTORICO: ASSINATURAS comecou com as 14 RPCs que existiam em producao mas
// nao tinham .sql (o call-site era a unica fonte da verdade). A p9 versionou
// admin_create_business e admin_update_business (saíram para
// ASSINATURAS_VERSIONADAS); a p10 (supabase/p10-functions-v2.sql) versionou
// as 12 que sobravam. ASSINATURAS hoje esta VAZIA de proposito: e o âncora que
// tests/rpc-contract-guard.inventory.test.cjs compara contra a varredura
// "handler chama RPC que nao tem CREATE FUNCTION no repo". Se uma RPC nova
// entrar sem .sql, a varredura enche, ASSINATURAS nao, e o inventario falha
// pedindo reconciliacao.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'sessao';
const TENANT_SLUG = 'playas-y-ventajas';

// Nomes exatos, em ordem de insercao, como o handler monta hoje. O
// deepStrictEqual de `Object.keys` abaixo e o que prende a ordem tambem.
//
// A lista nasceu com 14 (gerada casando `CREATE [OR REPLACE] FUNCTION` de
// verdade, e nao qualquer mencao: um scan por substring contava comentario
// como definicao e deixava de fora as que nao tem mencao nenhuma). A p9 levou
// 2 para ASSINATURAS_VERSIONADAS; a p10 levou as 12 restantes. Nada aqui esta
// apagado: as 14 continuam travadas no call-site la embaixo.
const ASSINATURAS = {
};

// RPCs com .sql no repo (p9 e p10) mas cujo callsite continua travado aqui.
// O `.sql` diz o que a funcao aceita; o que falta e travar que o HANDLER
// continue mandando exatamente esses nomes, na ordem, com nada undefined.
// Excecao conhecida: as duas da p9 exigem `p_instagram` por ultimo, porque e
// o unico parametro com DEFAULT (validado no teste da lista, la embaixo).
const ASSINATURAS_VERSIONADAS = {
  admin_billing_panel: ['p_tenant_id', 'p_actor_user_id'],
  admin_create_business: ['p_tenant_id', 'p_actor_user_id', 'p_name', 'p_category', 'p_city', 'p_phone', 'p_email', 'p_lat', 'p_lng', 'p_owner_internal_code', 'p_owner_pin', 'p_billing_plan', 'p_cnpj', 'p_website', 'p_logo_url', 'p_instagram'],
  admin_list_customers: ['p_tenant_id', 'p_actor_user_id', 'p_search'],
  admin_toggle_business: ['p_tenant_id', 'p_actor_user_id', 'p_business_id', 'p_is_active'],
  admin_update_business: ['p_tenant_id', 'p_actor_user_id', 'p_business_id', 'p_name', 'p_phone', 'p_email', 'p_category', 'p_city', 'p_cnpj', 'p_website', 'p_logo_url', 'p_instagram'],
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.admin_list_customers);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.admin_toggle_business);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.admin_update_customer);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.admin_update_business);
  // Campos ausentes no body vao como null, nunca undefined solto: o PostgREST
  // rejeita undefined e o `|| null` existe para isso.
  for (const k of ASSINATURAS_VERSIONADAS.admin_update_business) {
    assert.notStrictEqual(calls[0][k], undefined, `p_ausente: ${k} chegou undefined`);
  }
  // O parametro novo da p9 e o unico com regra de valor: ausente no body ele
  // tem de chegar NULL (mantem o dado salvo), e string vazia tem de chegar ''
  // (limpa). Se fosse `|| null` nas duas pontas, limpar o campo no /admin
  // pararia de funcionar depois do deploy.
  assert.strictEqual(calls[0].p_instagram, null, 'instagram ausente precisa chegar null para nao apagar o que esta salvo');
  const res2 = await handler(makeEvent({
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { action: 'update_business', businessId: 'b-1', instagram: '' },
  }));
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(calls[1].p_instagram, '', 'instagram vazio precisa chegar string vazia, para limpar de verdade');
});

test('assinatura CALLSITE: create_campaign', async (t) => {
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.create_campaign);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.empresa_dashboard);
  assert.strictEqual(calls[0].p_business_id, VALID_ACTORS.merchant.businessId);
});

// Trava as listas em si: se alguem apagar uma entrada sem (des)versionar o
// SQL, a assinatura dela deixa de ser travada em silencio. A contagem contra o
// repo fica em rpc-contract-guard.inventory.test.cjs, que refaz a varredura.
test('ASSINATURAS esta vazia (p10 versionou as 12) e as 14 versionadas seguem travadas no callsite', () => {
  assert.strictEqual(
    Object.keys(ASSINATURAS).length,
    0,
    'ASSINATURAS so deve ganhar entrada de RPC sem .sql no repo — o inventario refaz a varredura e cobra reconciliacao',
  );
  for (const [nome, p] of Object.entries(ASSINATURAS)) {
    assert.ok(Array.isArray(p) && p.length > 0, `${nome}: lista vazia`);
    for (const param of p) assert.match(param, /^p_[a-z0-9_]+$/, `${nome}: param invalido ${param}`);
  }
  assert.strictEqual(Object.keys(ASSINATURAS_VERSIONADAS).length, 14);
  for (const [nome, p] of Object.entries(ASSINATURAS_VERSIONADAS)) {
    assert.ok(Array.isArray(p) && p.length > 0, `${nome}: lista vazia`);
    for (const param of p) assert.match(param, /^p_[a-z0-9_]+$/, `${nome}: param invalido ${param}`);
  }
  // O parametro da p9 e DEFAULT e por isso tem de ser o ultimo: com um
  // parametro sem DEFAULT depois dele, o CREATE nem roda.
  for (const nome of ['admin_create_business', 'admin_update_business']) {
    const p = ASSINATURAS_VERSIONADAS[nome];
    assert.strictEqual(p[p.length - 1], 'p_instagram', `${nome}: p_instagram precisa ser o ultimo parametro`);
  }
});

test('assinatura CALLSITE: admin_create_business (tem .sql desde a p9)', async (t) => {
  const calls = [];
  const { handler, restore } = loadFunction(
    'admin.js',
    makeFakeSupabase({
      rpc: async (name, args) => {
        if (name === 'auth_verify_session') return { data: VALID_ACTORS.admin, error: null };
        if (name === 'admin_create_business') { calls.push(args); return { data: null, error: null }; }
        return { data: null, error: { message: 'unexpected rpc ' + name } };
      },
    }),
  );
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
    body: { action: 'create_business', name: 'Padaria', ownerInternalCode: 'padaria', ownerPin: 'senha123' },
  }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.admin_create_business);
  // No cadastro nao ha "manter": a linha esta nascendo, entao ausente e null.
  assert.strictEqual(calls[0].p_instagram, null);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.auth_verify_session);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.auth_login);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.identify_customer);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.validate_and_redeem_coupon);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.business_coupon_stats);
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
  assert.deepStrictEqual(Object.keys(calls[0]), ASSINATURAS_VERSIONADAS.admin_billing_panel);
});