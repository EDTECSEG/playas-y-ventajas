'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

test('shuttle exige tenantId e NAO chama nenhuma RPC', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_shuttle_services' || name === 'list_live_vehicles') return { data: ['vazou'], error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: {} }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fake.calls.rpc.length, 0, 'não deve chamar nenhuma RPC sem tenantId');
});

test('shuttle sem tenantId devolve 400 com mensagem de contrato', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: {} }));
  assert.strictEqual(parseBody(res).error, 'tenantId obrigatório');
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

test('shuttle propaga erro de RPC como 400 sem vazar stack', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_shuttle_services') return { data: null, error: { message: 'erro do postgres: 42P01' } };
      return { data: null, error: null };
    },
  });
  const { handler, restore } = loadFunction('shuttle.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, lat: '-1', lng: '-1' } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'erro do postgres: 42P01');
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