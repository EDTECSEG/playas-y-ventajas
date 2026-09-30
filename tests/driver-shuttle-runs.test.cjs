'use strict';

// driver-shuttle-runs (motorista aprovado).
//
// A credencial aqui e a sessao de MOTORISTA (driver_sessions), a mesma de
// driver-position — nao a sessao de empresa. E o que estes testes prendem:
//   - sem token nenhum a resposta e 401 e nenhuma RPC;
//   - o p_driver_id nunca vem do corpo: o banco deriva da sessao, entao o handler
//     so repassa o token;
//   - NOT_APPROVED e SESSION_EXPIRED chegam do banco como codigo e sao
//     traduzidos em 403/401;
//   - a lista NUNCA traz nome nem telefone do cliente (Q6 da spec): a agenda e
//     da rota, nao uma folha de contato de terceiros.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const TOKEN = 'driver-session-token';

function runsFake(rpcImpl) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (typeof rpcImpl === 'function') return rpcImpl(name, args);
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

function authHeaders() { return { authorization: `Bearer ${TOKEN}` }; }

// ------------------------------------------------------------
// Credencial
// ------------------------------------------------------------

test('sem token -> 401 AUTH_REQUIRED e nenhuma RPC chamada', async (t) => {
  const fake = runsFake();
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { date: '2026-10-02' } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'AUTH_REQUIRED');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

test('POST sem token tambem -> 401 e nenhuma RPC chamada', async (t) => {
  // Sem o gate antes do parse, um POST sem token chegaria a responder erro de
  // campo faltando em vez de "faca login".
  const fake = runsFake();
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { reservationId: 'r-1' } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'AUTH_REQUIRED');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------

test('GET repassa o token da sessao e o p_date, e devolve runs com no-store', async (t) => {
  const calls = [];
  const fake = runsFake(async (name, args) => {
    if (name === 'driver_list_shuttle_runs') {
      calls.push(args);
      return {
        data: [
          {
            reservationId: 'r-2', shuttleId: 's-1', serviceName: 'Aeroporto -> Centro',
            scheduledFor: '2026-10-02T16:00:00-03:00', durationMinutes: 60,
            passengers: 2, origin: { lat: -22.8, lng: -43.2 }, destination: { lat: -22.9, lng: -43.1 },
            status: 'confirmed',
          },
        ],
        error: null,
      };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { date: '2026-10-02' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_session_token, TOKEN);
  assert.strictEqual(calls[0].p_date, '2026-10-02');
  const body = parseBody(res);
  assert.strictEqual(body.date, '2026-10-02');
  assert.strictEqual(body.count, 1);
  assert.strictEqual(body.runs[0].reservationId, 'r-2');
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  // O p_driver_id e derivado no banco: se o handler mandasse algo, seria abrir
  // para o motorista pedir a corrida de outro.
  assert.strictEqual(calls[0].p_driver_id, undefined);
  assert.strictEqual(calls[0].p_business_id, undefined);
});

test('GET normaliza runs para array mesmo com data: null', async (t) => {
  const fake = runsFake(async (name) => {
    if (name === 'driver_list_shuttle_runs') return { data: null, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  assert.deepStrictEqual(body.runs, []);
  assert.strictEqual(body.count, 0);
  // Sem date na query, a RPC e quem assume o dia corrente no fuso de referencia.
  assert.strictEqual(fake.calls.rpc[0].args.p_date, null);
});

test('a agenda nao carrega nome nem telefone do cliente', async (t) => {
  // Guarda de privacidade: se a RPC crescer e comecar a devolver PII, o handler
  // nao deve repassar. Q6 da spec respondeu "nao".
  const fake = runsFake(async (name) => {
    if (name === 'driver_list_shuttle_runs') {
      return {
        data: [{
          reservationId: 'r-1', shuttleId: 's-1', serviceName: 'Centro -> Praia',
          scheduledFor: '2026-10-02T09:00:00-03:00', durationMinutes: 60, passengers: 3,
          origin: { lat: -22.9, lng: -43.1 }, destination: { lat: -22.8, lng: -43.2 },
          status: 'confirmed',
          customerName: 'Joao da Silva', contactPhone: '11999998888',
        }],
        error: null,
      };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ headers: authHeaders() }));
  const corrida = parseBody(res).runs[0];
  assert.strictEqual(corrida.customerName, undefined);
  assert.strictEqual(corrida.contactPhone, undefined);
  assert.ok(!JSON.stringify(corrida).includes('Joao'), 'PII do cliente nao pode chegar ao motorista');
});

// ------------------------------------------------------------
// Erros de sessao vindos do banco
// ------------------------------------------------------------

test('NOT_APPROVED -> 403 e SESSION_EXPIRED -> 401, com o codigo na resposta', async (t) => {
  for (const [mensagem, status, codigo] of [
    ['NOT_APPROVED: status pending', 403, 'NOT_APPROVED'],
    ['SESSION_EXPIRED: token expirado', 401, 'SESSION_EXPIRED'],
  ]) {
    const fake = runsFake(async (name) => {
      if (name === 'driver_list_shuttle_runs') return { data: null, error: { message: mensagem } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    });
    const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
    const res = await handler(makeEvent({ headers: authHeaders() }));
    restore();
    assert.strictEqual(res.statusCode, status, mensagem);
    assert.strictEqual(parseBody(res).error, codigo);
  }
});

test('metodo nao suportado -> 405', async (t) => {
  const fake = runsFake();
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'PUT', headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 405);
  assert.strictEqual(parseBody(res).error, 'METHOD_NOT_ALLOWED');
});

// ------------------------------------------------------------
// POST: concluir corrida
// ------------------------------------------------------------

test('POST conclui a corrida -> 200 { status: completed }', async (t) => {
  const calls = [];
  const fake = runsFake(async (name, args) => {
    if (name === 'driver_complete_shuttle_reservation') {
      calls.push(args);
      return { data: { reservationId: 'r-1', status: 'completed', completedAt: '2026-10-02T15:10:00Z' }, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(), body: { reservationId: 'r-1' },
  }));
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  assert.strictEqual(body.status, 'completed');
  assert.strictEqual(body.completedAt, '2026-10-02T15:10:00Z');
  assert.strictEqual(calls[0].p_session_token, TOKEN);
  assert.strictEqual(calls[0].p_reservation_id, 'r-1');
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

test('POST sem reservationId -> 400 e nenhuma RPC', async (t) => {
  const fake = runsFake();
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', headers: authHeaders(), body: {} }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'RESERVATION_ID_REQUIRED');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

test('concluir corrida ja cancelada -> 409 INVALID_STATUS_TRANSITION', async (t) => {
  const fake = runsFake(async (name) => {
    if (name === 'driver_complete_shuttle_reservation') {
      return { data: null, error: { message: 'INVALID_STATUS_TRANSITION: status atual cancelled' } };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(), body: { reservationId: 'r-1' },
  }));
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(parseBody(res).error, 'INVALID_STATUS_TRANSITION');
});

test('falha inesperada -> 500 "erro interno" sem vazar err.message', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async () => { throw new Error('relation "shuttle_reservations" does not exist'); },
  });
  const { handler, restore } = loadFunction('driver-shuttle-runs.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(parseBody(res), { error: 'erro interno' });
});
