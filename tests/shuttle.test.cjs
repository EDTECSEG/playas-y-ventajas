'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

test('shuttle IGNORA tenantId da query e sempre consulta o tenant fixo (IDOR)', async (t) => {
  // Regressao: tenantId vinha da query string e ia direto para as RPCs pelo
  // client de administracao. list_live_vehicles devolve posicao GPS, entao
  // trocar o UUID por outro expunha a localizacao de outro tenant.
  const INIMIGO = '11111111-2222-4333-8444-555555555555';
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_shuttle_services') return { data: [{ id: 1 }], error: null };
      if (name === 'list_live_vehicles') return { data: [{ lat: -23.5, lng: -46.6 }], error: null };
      return { data: null, error: { message: 'unexpected ' + name } };
    },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: INIMIGO } }));
  assert.strictEqual(res.statusCode, 200, 'o parametro nao pode mais barrar a requisicao');

  assert.strictEqual(fake.calls.rpc.length, 2, 'as duas RPCs rodam normalmente');
  for (const call of fake.calls.rpc) {
    assert.strictEqual(call.args.p_tenant_id, TENANT, `${call.name} deve usar o tenant fixo`);
    assert.notStrictEqual(call.args.p_tenant_id, INIMIGO, 'o tenant da query nao pode chegar na RPC');
  }
});

test('lat/lng invalidos barram ANTES de qualquer RPC (nada e consultado sem coordenada coerente)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_shuttle_services' || name === 'list_live_vehicles') return { data: ['vazou'], error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, lat: '-23.5' } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fake.calls.rpc.length, 0, 'não deve chamar nenhuma RPC com par de coordenada quebrado');
});

test('shuttle com lat e sem lng devolve 400 (par coordenado)', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, lat: '-23.5' } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'lat e lng devem ser enviados juntos');
});

test('shuttle com lat/lng nao numericos devolve 400', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, lat: 'abc', lng: '10' } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'lat e lng devem ser numéricos');
});

test('shuttle com radiusKm sem lat/lng devolve 400', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, radiusKm: '16' } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'radiusKm só faz sentido junto de lat/lng');
});

test('shuttle lista servicos e veiculos ao vivo chamando as duas RPCs com os params certos', async (t) => {
  const serviço = { id: 'S-1', name: 'Translado aeroporto', price_cents: 8000 };
  const veiculo = { vehicleId: 'V-1', name: 'Fusca', distance_m: 1200 };
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'list_shuttle_services') {
        assert.strictEqual(args.p_tenant_id, TENANT);
        assert.strictEqual(args.p_lat, -23.5);
        assert.strictEqual(args.p_lng, -46.6);
        assert.strictEqual(args.p_radius_km, 16);
        return { data: [serviço], error: null };
      }
      if (name === 'list_live_vehicles') {
        assert.strictEqual(args.p_tenant_id, TENANT);
        assert.strictEqual(args.p_lat, -23.5);
        assert.strictEqual(args.p_lng, -46.6);
        assert.strictEqual(args.p_radius_m, 16000);
        assert.strictEqual(args.p_max_age_s, 300);
        return { data: [veiculo], error: null };
      }
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    query: { tenantId: TENANT, lat: '-23.5', lng: '-46.6', radiusKm: '16' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { services: [serviço], vehicles: [veiculo] });
  assert.deepStrictEqual(fake.calls.rpc.map((c) => c.name), ['list_shuttle_services', 'list_live_vehicles']);
});

test('shuttle sem lat/lng chama as RPCs com null (lista completa, sem distancia)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      assert.strictEqual(args.p_lat, null);
      assert.strictEqual(args.p_lng, null);
      if (name === 'list_shuttle_services') assert.strictEqual(args.p_radius_km, null);
      if (name === 'list_live_vehicles') {
        assert.strictEqual(args.p_radius_m, null);
        assert.strictEqual(args.p_max_age_s, 300);
      }
      return { data: [], error: null };
    },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { services: [], vehicles: [] });
});

test('shuttle responde 400 com o SQLSTATE e NUNCA com o texto do Postgres', async (t) => {
  // O teste antigo fixava 'erro do postgres: 42P01', um formato que nao existe
  // em producao: o PostgREST devolve message separada de code, e a message e
  // texto livre que nomeia tabela. Pinava o passthrough cru sem nunca poder
  // falhar pela razao que importa.
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_shuttle_services') {
        return {
          data: null,
          error: {
            code: '42P01',
            message: 'relation "public.list_shuttle_services" does not exist',
            details: null,
            hint: null,
          },
        };
      }
      return { data: null, error: null };
    },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, lat: '-1', lng: '-1' } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, '42P01', 'o SQLSTATE e util e seguro');
  assert.ok(!/relation|public\.|does not exist/.test(res.body), 'o texto do Postgres nao pode vazar');
});

test('shuttle sem SQLSTATE cai num codigo estavel, nunca na mensagem crua', async (t) => {
  // Sem `code` nao ha nada de confiavel a repassar: a mensagem pode ser qualquer
  // texto. O fallback e estavel para o cliente tratar, e o motivo real so vai
  // para o log do servidor.
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_live_vehicles') {
        return { data: null, error: { message: 'violates row-level security policy for table "businesses"' } };
      }
      return { data: [], error: null };
    },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, lat: '-1', lng: '-1' } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'SHUTTLE_UNAVAILABLE');
  assert.ok(!/businesses|row-level security|violates/.test(res.body), 'nenhum detalhe de schema na resposta');
});

test('falha inesperada na RPC vira 500 sanitizado', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async () => { throw new Error('connection refused: segredo interno'); },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, lat: '-1', lng: '-1' } }));
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(parseBody(res).error, 'erro interno');
  assert.ok(!String(res.body).includes('segredo'), 'não deve vazar detalhe interno');
});

test('maxAgeS invalido devolve 400', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, lat: '-1', lng: '-1', maxAgeS: 'x' } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'maxAgeS deve ser um inteiro positivo');
});