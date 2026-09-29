'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, VALID_ACTORS } = require('./helpers.cjs');

const TOKEN = 'merchant-session';

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

// ------------------------------------------------------------
// empresa: GET mode=shuttles (painel da empresa)
// ------------------------------------------------------------
test('empresa: GET mode=shuttles lista os servicos do ator', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_list_shuttle_services') { calls.push(args); return { data: [{ shuttleId: 's-1' }], error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { mode: 'shuttles' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_tenant_id, 't-1');
  assert.strictEqual(calls[0].p_actor_user_id, 'u-merchant-1');
  assert.deepStrictEqual(parseBody(res), [{ shuttleId: 's-1' }]);
});

test('empresa: GET mode=shuttles com FORBIDDEN -> 403', async (t) => {
  const fake = actorFake(VALID_ACTORS.merchant, async (name) => {
    if (name === 'business_list_shuttle_services') return { data: null, error: { message: 'FORBIDDEN: sem acesso' } };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { mode: 'shuttles' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(parseBody(res).error, 'FORBIDDEN');
});

// ------------------------------------------------------------
// empresa: POST save_shuttle_service
// ------------------------------------------------------------
test('empresa: POST save_shuttle_service cria servico com dados convertidos', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_save_shuttle_service') { calls.push(args); return { data: { shuttleId: 's-1' }, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: {
      action: 'save_shuttle_service',
      name: 'Aeroporto <-> Centro',
      description: 'Translado compartilhado',
      serviceType: 'shuttle',
      originLat: '-22.9068', originLng: '-43.1729',
      destLat: '-22.9110', destLng: '-43.2050',
      priceCents: 2500, opensAt: '08:00', closesAt: '22:00',
      activeDays: [1, 2, 3],
      stops: [{ lat: -22.9, lng: -43.17, label: 'Praça' }],
    },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { shuttleId: 's-1' });
  const a = calls[0];
  assert.strictEqual(a.p_tenant_id, 't-1');
  assert.strictEqual(a.p_actor_user_id, 'u-merchant-1');
  assert.strictEqual(a.p_service_id, null);
  assert.strictEqual(a.p_name, 'Aeroporto <-> Centro');
  assert.strictEqual(a.p_origin_lat, -22.9068);
  assert.strictEqual(a.p_origin_lng, -43.1729);
  assert.strictEqual(a.p_dest_lat, -22.911);
  assert.strictEqual(a.p_dest_lng, -43.205);
  assert.strictEqual(a.p_price_cents, 2500);
  assert.strictEqual(a.p_opens_at, '08:00');
  assert.strictEqual(a.p_closes_at, '22:00');
  assert.deepStrictEqual(a.p_active_days, [1, 2, 3]);
  assert.strictEqual(a.p_stops.length, 1);
});

test('empresa: POST save_shuttle_service aceita campos vazios como null', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_save_shuttle_service') { calls.push(args); return { data: { shuttleId: 's-2' }, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: {
      action: 'save_shuttle_service',
      name: 'Translado',
      originLat: '', originLng: '', destLat: '', destLng: '',
      priceCents: '', activeDays: [],
    },
  }));
  assert.strictEqual(res.statusCode, 200);
  const a = calls[0];
  assert.strictEqual(a.p_origin_lat, null);
  assert.strictEqual(a.p_price_cents, null);
  assert.deepStrictEqual(a.p_active_days, []);
});

test('empresa: POST save_shuttle_service edita servico existente (serviceId)', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_save_shuttle_service') { calls.push(args); return { data: { shuttleId: 's-1' }, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: {
      action: 'save_shuttle_service',
      serviceId: 's-1',
      name: 'Rota nova',
      originLat: '1', originLng: '2', destLat: '3', destLng: '4',
    },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_service_id, 's-1');
});

test('empresa: POST save_shuttle_service com FORBIDDEN -> 403', async (t) => {
  const fake = actorFake(VALID_ACTORS.merchant, async (name) => {
    if (name === 'business_save_shuttle_service') return { data: null, error: { message: 'FORBIDDEN' } };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'save_shuttle_service', name: 'x', originLat: '1', originLng: '2', destLat: '3', destLng: '4' },
  }));
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(parseBody(res).error, 'FORBIDDEN');
});

// ------------------------------------------------------------
// empresa: POST toggle/delete_shuttle_service
// ------------------------------------------------------------
test('empresa: POST toggle_shuttle_service ativa pelo id do servico', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_toggle_shuttle_service') { calls.push(args); return { data: true, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'toggle_shuttle_service', serviceId: 's-1', isActive: true },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_service_id, 's-1');
  assert.strictEqual(calls[0].p_is_active, true);
  assert.strictEqual(parseBody(res).changed, true);
});

test('empresa: POST delete_shuttle_service apaga pelo id do servico', async (t) => {
  const calls = [];
  const fake = actorFake(VALID_ACTORS.merchant, async (name, args) => {
    if (name === 'business_delete_shuttle_service') { calls.push(args); return { data: true, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'delete_shuttle_service', serviceId: 's-1' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_service_id, 's-1');
  assert.strictEqual(parseBody(res).deleted, true);
});

// ------------------------------------------------------------
// driver-position
// ------------------------------------------------------------
test('driver-position: sem token -> 401', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('driver-position.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { lat: 1, lng: 2 } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'AUTH_REQUIRED');
});

test('driver-position: GET -> 405', async (t) => {
  const fake = makeFakeSupabase({ rpc: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('driver-position.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 405);
});

test('driver-position: reporta posicao e devolve driverId/recordedAt', async (t) => {
  const calls = [];
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'driver_report_position') { calls.push(args); return { data: { driverId: 'd-1', recordedAt: '2026-01-01T00:00:00Z' }, error: null }; }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('driver-position.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { lat: -22.9, lng: -43.17, heading: 90, speedKmh: 40.5, shuttleId: 's-1' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  const a = calls[0];
  assert.strictEqual(a.p_session_token, 'merchant-session');
  assert.strictEqual(a.p_lat, -22.9);
  assert.strictEqual(a.p_lng, -43.17);
  assert.strictEqual(a.p_heading, 90);
  assert.strictEqual(a.p_speed_kmh, 40.5);
  assert.strictEqual(a.p_shuttle_id, 's-1');
  assert.strictEqual(parseBody(res).driverId, 'd-1');
});

test('driver-position: motorista nao aprovado -> 403', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'driver_report_position') return { data: null, error: { message: 'NOT_APPROVED: nao habilitado' } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('driver-position.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { lat: 1, lng: 2 } }));
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(parseBody(res).error, 'NOT_APPROVED');
});

test('driver-position: sessao expirada -> 401', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'driver_report_position') return { data: null, error: { message: 'SESSION_EXPIRED' } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('driver-position.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { lat: 1, lng: 2 } }));
  assert.strictEqual(res.statusCode, 401);
});

test('driver-position: shuttle inexistente -> 404', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'driver_report_position') return { data: null, error: { message: 'SHUTTLE_NOT_FOUND' } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('driver-position.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { lat: 1, lng: 2, shuttleId: 'x' } }));
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(parseBody(res).error, 'SHUTTLE_NOT_FOUND');
});

test('driver-position: coordenada invalida passa ao banco (400 por padrao)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async () => ({ data: null, error: { message: 'INVALID_COORDS' } }),
  });
  const { handler, restore } = loadFunction('driver-position.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: { lat: 999, lng: 2 } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'INVALID_COORDS');
});