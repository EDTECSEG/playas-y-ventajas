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
      if (name === 'affiliate_reward_status') {
        assert.strictEqual(args.p_tenant_id, TENANT);
        assert.strictEqual(args.p_affiliate_id, 'a-1');
        return { data: { pendingReason: 'ok' }, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { affiliateId: 'a-1', phone: '+5511999999999' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).totalReferrals, 3);
  assert.strictEqual(parseBody(res).rewardStatus, 'active');
});

// A tela /afiliado le `dash.rewardStatus` em dois lugares, mas affiliate_dashboard
// NUNCA devolveu esse campo. Resultado: o painel mostrava "—" e a condicao
// `=== 'active'` da folha de divulgacao nunca era verdadeira. Os dois pontos
// eram codigo morto apontando para um campo inexistente.
test('GET expoe rewardStatus a partir de affiliate_reward_status', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'affiliate_dashboard') return { data: { totalReferrals: 5 }, error: null };
      if (name === 'affiliate_reward_status') {
        return { data: { pendingReason: 'semTemplate', rewardTemplateConfigured: false }, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { affiliateId: 'a-1', phone: '+5511999999999' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(
    parseBody(res).rewardStatus, 'semTemplate',
    'o motivo tem de chegar cru para a tela traduzir; so "ok" vira active',
  );
});

// A RPC e um diagnostico, nao a funcao principal do endpoint. Se ela nao existir
// no banco (ou falhar), o painel tem de continuar funcionando.
test('GET degrada sem rewardStatus quando a RPC de status falha, sem virar 500', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'affiliate_dashboard') return { data: { totalReferrals: 2 }, error: null };
      return { data: null, error: { message: 'function affiliate_reward_status does not exist' } };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { affiliateId: 'a-1', phone: '+5511999999999' } }));
  assert.strictEqual(res.statusCode, 200, 'falha de diagnostico nao pode derrubar o painel');
  assert.strictEqual(parseBody(res).totalReferrals, 2, 'o dashboard continua vindo');
  assert.ok(!('rewardStatus' in parseBody(res)), 'sem status inventado: a chave nem aparece');
});

test('GET nao vaza o customerId que a RPC devolve', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'affiliate_dashboard') return { data: { totalReferrals: 1 }, error: null };
      if (name === 'affiliate_reward_status') {
        return {
          data: { customerId: 'c-uuid-secreto', hasCustomer: true, pendingReason: 'ok' },
          error: null,
        };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { affiliateId: 'a-1', phone: '+5511999999999' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).rewardStatus, 'active');
  const bruto = JSON.stringify(parseBody(res));
  assert.ok(!bruto.includes('c-uuid-secreto'), 'o UUID do cliente nao vai para o navegador');
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

// BUG (setembro/2026): a deduplicacao comparava o texto do telefone, entao
// "22 99833-6286" e "22 99833-6286 " passavam uma pela outra e a MESMA pessoa
// recebia dois codigos de indicacao. Aconteceu em producao.
test('POST / deduplica pelos DIGITOS do telefone, nao pelo texto', async (t) => {
  const fake = makeFakeSupabase({
    from: async () => ({ data: { id: 'a-1', referral_code: 'MEUNOME-8E94' }, error: null }),
    rpc: async () => { assert.fail('nao deve criar duplicado'); return { data: null, error: null }; },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: { name: 'Meu nome', phone: '(22) 99833-6286' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).referralCode, 'MEUNOME-8E94');

  const filtro = fake.calls.eq.find((c) => c.column === 'phone_digits');
  assert.ok(filtro, 'a busca tem de usar a coluna phone_digits');
  assert.strictEqual(filtro.value, '22998336286', 'compara so os digitos');
  assert.ok(
    !fake.calls.eq.some((c) => c.column === 'phone'),
    'nao pode voltar a comparar o texto do telefone',
  );
});

test('POST / telefone so com pontuacao devolve 400 em vez de cadastrar lixo', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { name: 'Maria', phone: '() -' } }));
  assert.strictEqual(res.statusCode, 400);
});

// A tela /afiliado oferecia 'empresa' e 'motorista', que violam o CHECK
// affiliates_kind_check ('customer' | 'driver' | 'business') e faziam o
// cadastro falhar com erro cru do Postgres.
test('POST / kind fora do CHECK cai em customer em vez de estourar o banco', async (t) => {
  const fake = makeFakeSupabase({
    from: async () => ({ data: null, error: null }),
    rpc: async (name, args) => {
      if (name === 'affiliate_register') {
        assert.strictEqual(args.p_kind, 'customer', 'kind invalido vira customer');
        return { data: { affiliateId: 'a-3', referralCode: 'X-0001' }, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { name: 'X', phone: '21999990000', kind: 'empresa' } }));
  assert.strictEqual(res.statusCode, 200);
});

test('POST / preserva um kind valido do formulario', async (t) => {
  const fake = makeFakeSupabase({
    from: async () => ({ data: null, error: null }),
    rpc: async (name, args) => {
      if (name === 'affiliate_register') {
        assert.strictEqual(args.p_kind, 'driver');
        return { data: { affiliateId: 'a-4', referralCode: 'Y-0002' }, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { name: 'Y', phone: '21999990001', kind: 'driver' } }));
  assert.strictEqual(res.statusCode, 200);
});