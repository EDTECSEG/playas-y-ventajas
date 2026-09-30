'use strict';

// empresa: GET mode=report (aba "Relatorio" do painel da empresa).
//
// O que este arquivo trava, alem do contrato de status:
//   1. sem sessao nunca 200 (Regra 3 do AGENTS.md);
//   2. a RPC so recebe p_tenant_id/p_actor_user_id do ATOR — um businessId
//      na query e ignorado (a assinatura nao tem p_business_id);
//   3. o periodo e validado no handler, antes de gastar uma chamada ao banco;
//   4. erro de regra volta como CODIGO, nunca como error.message cru;
//   5. a v3 ausente degrada para business_report, com `source` dizendo qual
//      respondeu — e nao 500;
//   6. zero PII de cliente no corpo.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'merchant-session';
const MS_DAY = 86400000;

// Resposta de uma RPC de relatorio, no formato de business_report_v3.
function reportV3(overrides = {}) {
  return {
    period: { from: '2026-09-01T00:00:00+00:00', to: '2026-09-29T00:00:00+00:00' },
    totals: { issued: 40, validated: 25, available: 15, conversionPct: 62.5, newCustomers: 10, totalCustomers: 33, returningCustomers: 7 },
    daily: [{ day: '2026-09-01', issued: 4, validated: 2 }],
    byCampaign: [{ campaignId: 'camp-1', title: 'Verão', issued: 30, validated: 20 }],
    byTemplate: [{ templateId: 'tpl-1', title: '10% OFF', issued: 30, validated: 20 }],
    drivers: { total: 5, approved: 2, pending: 2, rejected: 1, documentsPending: 3 },
    billing: { plan: 'PER_COUPON', status: 'ACTIVE', monthlyFeeCents: 0, feePerCouponCents: 150, chargedCents: 3000, charges: 20 },
    shuttle: { services: 2, activeServices: 1, vehiclesReporting: 1 },
    rides: null,
    ...overrides,
  };
}

function actorFake(actor, rpcImpl) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_verify_session') {
        assert.strictEqual(args.p_session_token, TOKEN);
        return { data: actor, error: null };
      }
      if (name === 'driver_verify_session') {
        return { data: null, error: null };
      }
      if (typeof rpcImpl === 'function') return rpcImpl(name, args);
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

function authHeaders() { return { authorization: `Bearer ${TOKEN}` }; }

function loadWith(t, actor, rpcImpl) {
  const fake = actorFake(actor, rpcImpl);
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  return { handler, calls: fake.calls.rpc };
}

function get(handler, query) {
  return handler(makeEvent({ query, headers: authHeaders() }));
}

// ------------------------------------------------------------
// Sessao: nunca 200 sem token valido
// ------------------------------------------------------------
test('empresa report: sem token -> 401 SESSION_REQUIRED', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { mode: 'report', days: '30' } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'SESSION_REQUIRED');
});

test('empresa report: token expirado -> 401 SESSION_EXPIRED', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_verify_session') return { data: null, error: { message: 'sessao inexistente' } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { mode: 'report', days: '30' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'SESSION_EXPIRED');
  // Nenhuma consulta ao banco de relatorio pode ter saído.
  assert.ok(!fake.calls.rpc.some((c) => c.name.startsWith('business_report')));
});

test('empresa report: ator sem businessId -> 400 (contrato existente)', async (t) => {
  const admin = { userId: 'u-admin-1', tenantId: 't-1', role: 'ADMIN', businessId: null };
  const { handler } = loadWith(t, admin, async () => ({ data: null, error: { message: 'unexpected rpc' } }));
  const res = await get(handler, { mode: 'report', days: '30' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'ator não vinculado a um estabelecimento');
});

// ------------------------------------------------------------
// 200: ids do ator e periodo derivado de days
// ------------------------------------------------------------
test('empresa report: mode=report chama business_report_v3 com o ator e o periodo de days', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'business_report_v3') return { data: reportV3(), error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '7' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  assert.strictEqual(rpcCalls.length, 1);
  assert.strictEqual(rpcCalls[0].name, 'business_report_v3');
  const a = rpcCalls[0].args;
  assert.strictEqual(a.p_tenant_id, 't-1');
  assert.strictEqual(a.p_actor_user_id, 'u-merchant-1');
  // p_de = now()-7d, p_ate = now()
  assert.ok(Math.abs(Date.now() - Date.parse(a.p_ate)) < 10000, 'p_ate deve ser agora');
  assert.strictEqual(Date.parse(a.p_ate) - Date.parse(a.p_de), 7 * MS_DAY);
  const body = parseBody(res);
  assert.strictEqual(body.source, 'business_report_v3');
  assert.strictEqual(body.period.days, 7);
  // O resto do objeto do banco passa intacto (a RPC e a fonte do relatorio).
  assert.strictEqual(body.totals.issued, 40);
  assert.strictEqual(body.daily.length, 1);
  assert.strictEqual(body.byCampaign[0].title, 'Verão');
  assert.strictEqual(body.byTemplate[0].title, '10% OFF');
  assert.strictEqual(body.drivers.total, 5);
  assert.strictEqual(body.billing.chargedCents, 3000);
});

test('empresa report: sem days usa a janela default de 30 dias', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'business_report_v3') return { data: reportV3(), error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(Date.parse(rpcCalls[0].args.p_ate) - Date.parse(rpcCalls[0].args.p_de), 30 * MS_DAY);
  assert.strictEqual(parseBody(res).period.days, 30);
});

test('empresa report: days=90 abre janela de 90 dias', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'business_report_v3') return { data: reportV3(), error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '90' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(Date.parse(rpcCalls[0].args.p_ate) - Date.parse(rpcCalls[0].args.p_de), 90 * MS_DAY);
  assert.strictEqual(parseBody(res).period.days, 90);
});

// ------------------------------------------------------------
// from/to explicitos chegam crus; e as datas invalidas sao 400
// ------------------------------------------------------------
test('empresa report: from/to explicitos chegam crus em p_de/p_ate', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'business_report_v3') return { data: reportV3(), error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', from: '2026-09-01', to: '2026-09-29' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rpcCalls[0].args.p_de, '2026-09-01');
  assert.strictEqual(rpcCalls[0].args.p_ate, '2026-09-29');
  assert.strictEqual(parseBody(res).period.days, 28);
});

test('empresa report: from > to -> 400 INVALID_PERIOD', async (t) => {
  const { handler, calls } = loadWith(t, VALID_ACTORS.merchant, async () => ({ data: reportV3(), error: null }));
  const res = await get(handler, { mode: 'report', from: '2026-09-29', to: '2026-09-01' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'INVALID_PERIOD');
  assert.ok(!calls.some((c) => c.name.startsWith('business_report')));
});

test('empresa report: data nao-ISO -> 400 INVALID_PERIOD', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async () => ({ data: reportV3(), error: null }));
  const res = await get(handler, { mode: 'report', from: '01/09/2026', to: '2026-09-29' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'INVALID_PERIOD');
});

test('empresa report: data ISO com valor impossivel -> 400 INVALID_PERIOD', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async () => ({ data: reportV3(), error: null }));
  const res = await get(handler, { mode: 'report', from: '2026-13-45' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'INVALID_PERIOD');
});

test('empresa report: days fora de 1..366 -> 400 INVALID_PERIOD', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async () => ({ data: reportV3(), error: null }));
  const alto = await get(handler, { mode: 'report', days: '400' });
  assert.strictEqual(alto.statusCode, 400);
  assert.strictEqual(parseBody(alto).error, 'INVALID_PERIOD');
  const zero = await get(handler, { mode: 'report', days: '0' });
  assert.strictEqual(zero.statusCode, 400);
  const lixo = await get(handler, { mode: 'report', days: '30d' });
  assert.strictEqual(lixo.statusCode, 400);
});

test('empresa report: janela maior que 366 dias -> 400 INVALID_PERIOD', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async () => ({ data: reportV3(), error: null }));
  const res = await get(handler, { mode: 'report', from: '2020-01-01', to: '2026-09-29' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'INVALID_PERIOD');
});

// ------------------------------------------------------------
// IDOR: businessId do cliente e ignorado
// ------------------------------------------------------------
test('empresa report: businessId do cliente e ignorado (a RPC nao recebe p_business_id)', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'business_report_v3') return { data: reportV3(), error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '30', businessId: 'b-da-vitima', tenantId: 't-da-vitima', userId: 'u-da-vitima' });
  assert.strictEqual(res.statusCode, 200);
  const a = rpcCalls[0].args;
  assert.deepStrictEqual(Object.keys(a).sort(), ['p_actor_user_id', 'p_ate', 'p_de', 'p_tenant_id']);
  assert.strictEqual(a.p_tenant_id, 't-1');
  assert.strictEqual(a.p_actor_user_id, 'u-merchant-1');
  assert.strictEqual(JSON.stringify(parseBody(res)).includes('b-da-vitima'), false);
});

// ------------------------------------------------------------
// Erro de regra: so o codigo
// ------------------------------------------------------------
test('empresa report: FORBIDDEN da RPC -> 403 com apenas o codigo', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name) => {
    if (name === 'business_report_v3') {
      return { data: null, error: { message: 'FORBIDDEN: ator nao pertence a este tenant; detalhe interno do banco' } };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '30' });
  assert.strictEqual(res.statusCode, 403);
  const body = parseBody(res);
  assert.strictEqual(body.error, 'FORBIDDEN');
  assert.strictEqual(JSON.stringify(body).includes('detalhe interno'), false);
});

test('empresa report: BUSINESS_NOT_FOUND da RPC -> 404', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name) => {
    if (name === 'business_report_v3') return { data: null, error: { message: 'BUSINESS_NOT_FOUND: negocio removido' } };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '30' });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(parseBody(res).error, 'BUSINESS_NOT_FOUND');
});

// ------------------------------------------------------------
// Fallback: v3 ainda nao aplicada em producao
// ------------------------------------------------------------
test('empresa report: business_report_v3 inexistente cai para business_report (sem 500)', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'business_report_v3') {
      return { data: null, error: { code: '42883', message: 'function public.business_report_v3(uuid, uuid, timestamp with time zone, timestamp with time zone) does not exist' } };
    }
    if (name === 'business_report') return { data: reportV3({ drivers: undefined }), error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '30' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(rpcCalls.map((c) => c.name), ['business_report_v3', 'business_report']);
  // O fallback leva os MESMOS p_* do ator, nunca p_business_id.
  assert.strictEqual(rpcCalls[1].args.p_actor_user_id, 'u-merchant-1');
  assert.strictEqual(rpcCalls[1].args.p_tenant_id, 't-1');
  const body = parseBody(res);
  assert.strictEqual(body.source, 'business_report');
  assert.strictEqual(body.period.days, 30);
  assert.strictEqual(body.totals.issued, 40);
});

test('empresa report: erro da v3 por outro motivo NAO cai para business_report', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name) => {
    rpcCalls.push(name);
    if (name === 'business_report_v3') return { data: null, error: { message: 'FORBIDDEN: nao autorizado' } };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '30' });
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(rpcCalls, ['business_report_v3']);
});

// ------------------------------------------------------------
// Contrato do payload
// ------------------------------------------------------------
test('empresa report: corpo nao carrega PII de cliente nem token', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name) => {
    if (name === 'business_report_v3') return { data: reportV3(), error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '30' });
  assert.strictEqual(res.statusCode, 200);
  const raw = res.body;
  for (const proibido of ['customerName', 'customerPhone', 'customer_email', 'email', 'cpnj', 'cnpj', 'pin', 'pin_hash', 'token', TOKEN]) {
    assert.strictEqual(raw.includes(proibido), false, `o corpo do relatorio nao pode conter "${proibido}"`);
  }
  assert.strictEqual(raw.includes('billing_subscription_url'), false);
});

test('empresa report: shuttle e rides nulos sao repassados como null', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name) => {
    if (name === 'business_report_v3') return { data: reportV3({ shuttle: null, rides: null }), error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '30' });
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  assert.strictEqual(body.shuttle, null);
  assert.strictEqual(body.rides, null);
});

test('empresa report: series sem linha vem como array vazio, nunca undefined', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name) => {
    if (name === 'business_report_v3') {
      return { data: reportV3({ daily: [], byCampaign: [], byTemplate: [], shuttle: null, rides: null }), error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'report', days: '30' });
  const body = parseBody(res);
  assert.deepStrictEqual(body.daily, []);
  assert.deepStrictEqual(body.byCampaign, []);
  assert.deepStrictEqual(body.byTemplate, []);
  assert.strictEqual(body.shuttle, null);
});

// ------------------------------------------------------------
// Modos antigos: intocados
// ------------------------------------------------------------
test('empresa report: mode=stats continua chamando business_coupon_stats com o businessId do ator', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'business_coupon_stats') return { data: { totalIssued: 3 }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'stats' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rpcCalls[0].name, 'business_coupon_stats');
  assert.strictEqual(rpcCalls[0].args.p_business_id, 'b-1');
  assert.deepStrictEqual(parseBody(res), { totalIssued: 3 });
});

test('empresa report: mode=my-data continua chamando business_get_own', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'business_get_own') return { data: { name: 'Loja X' }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'my-data' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rpcCalls[0].name, 'business_get_own');
  assert.strictEqual(rpcCalls[0].args.p_actor_user_id, 'u-merchant-1');
});

test('empresa report: mode=shuttles continua devolvendo a lista crua', async (t) => {
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_list_shuttle_services') return { data: [{ shuttleId: 's-1' }], error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'shuttles' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), [{ shuttleId: 's-1' }]);
});

test('empresa report: default continua sendo empresa_dashboard', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === 'empresa_dashboard') return { data: { ok: 1 }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, {});
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(rpcCalls[0].name, 'empresa_dashboard');
  assert.strictEqual(rpcCalls[0].args.p_business_id, 'b-1');
});

test('empresa report: mode desconhecido cai no default (empresa_dashboard)', async (t) => {
  const rpcCalls = [];
  const { handler } = loadWith(t, VALID_ACTORS.merchant, async (name) => {
    rpcCalls.push(name);
    if (name === 'empresa_dashboard') return { data: { ok: 1 }, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const res = await get(handler, { mode: 'qualquer-coisa' });
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(rpcCalls, ['empresa_dashboard']);
});
