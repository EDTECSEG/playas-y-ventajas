'use strict';

// empresa: fila de reservas (GET ?mode=reservations) e decisao
// (POST { action: 'review_reservation', decision }).
//
// ESTE ARQUIVO NAO E EXECUTADO NESTA ENTREGA.
//
// app/empresa/page.jsx e netlify/functions/empresa.js estao em alteracao por
// outro trabalho e nao podem ser tocados aqui. (O espelho
// functions/.netlify/functions/empresa.js que este comentario tambem citava foi
// removido em 2026-09-30; hoje a fonte unica e netlify/functions.)
// O que existe hoje nesses arquivos e o catalogo de translado
// (mode=shuttles) e a gestao de motoristas; nao existe nenhuma das duas rotas
// testadas abaixo.
//
// A suite esta escrita e pronta para rodar depois que o bloco
// INTEGRACAO EMPRESA for aplicado. Rodar antes disso daria falso vermelho: os
// testes medem o contrato especificado, nao o codigo existente.
//
// O que fica travado aqui:
//   - p_tenant_id e p_actor_user_id vem da SESSAO (resolveSession), nunca da
//     query nem do corpo — e o que impede a empresa A de ler ou decidir a fila
//     da empresa B;
//   - status e date sao escolha de tela e seguem para a RPC;
//   - decision fora de confirm/reject/cancel -> 400 ACTION_INVALID, antes da RPC;
//   - FORBIDDEN 403, SESSION_EXPIRED 401, RESERVATION_NOT_FOUND 404 e
//     INVALID_STATUS_TRANSITION 409;
//   - Cache-Control: no-store no GET (a fila traz telefone e observacao do
//     cliente).

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

function managerFake(rpcImpl) {
  return actorFake(VALID_ACTORS.merchant, rpcImpl);
}

const LINHA = {
  reservationId: 'r-1', shuttleId: 's-1', serviceName: 'Aeroporto -> Centro',
  businessName: 'Translado Norte', businessPhone: '11987654321',
  scheduledFor: '2026-10-02T14:00:00-03:00', durationMinutes: 60,
  passengers: 3, priceCents: 4500, status: 'pending',
  contactPhone: '11999998888', notes: 'porta 3', reason: null,
  createdAt: '2026-09-29T10:00:00Z', decidedAt: null,
};

// ------------------------------------------------------------
// GET ?mode=reservations
// ------------------------------------------------------------

test('empresa: GET mode=reservations usa tenant e ator da sessao, nunca da query', async (t) => {
  const calls = [];
  const fake = managerFake(async (name, args) => {
    if (name === 'business_list_shuttle_reservations') {
      calls.push(args);
      return { data: [LINHA], error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  // A query tenta sequestrar o escopo: um tenantId e um actor na URL precisam ser
  // ignorados em favor da sessao.
  const res = await handler(makeEvent({
    query: { mode: 'reservations', tenantId: 't-9', actorUserId: 'u-9', status: 'pending', date: '2026-10-02' },
    headers: authHeaders(),
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_tenant_id, 't-1');
  assert.strictEqual(calls[0].p_actor_user_id, 'u-merchant-1');
  assert.strictEqual(calls[0].p_status, 'pending');
  assert.strictEqual(calls[0].p_date, '2026-10-02');
  const body = parseBody(res);
  assert.strictEqual(body.count, 1);
  assert.strictEqual(body.reservations[0].reservationId, 'r-1');
  // A empresa e a dona da reserva: telefone e observacao precisam vir.
  assert.strictEqual(body.reservations[0].contactPhone, '11999998888');
  assert.strictEqual(body.reservations[0].notes, 'porta 3');
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

test('empresa: GET mode=reservations normaliza lista vazia quando data e null', async (t) => {
  const fake = managerFake(async (name) => {
    if (name === 'business_list_shuttle_reservations') return { data: null, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { mode: 'reservations' }, headers: authHeaders() }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { reservations: [], count: 0 });
  const call = fake.calls.rpc.find((c) => c.name === 'business_list_shuttle_reservations');
  assert.ok(call, 'deveria ter chamado business_list_shuttle_reservations');
  assert.strictEqual(call.args.p_status, null);
  assert.strictEqual(call.args.p_date, null);
});

test('empresa: GET mode=reservations com FORBIDDEN -> 403 e SESSION_EXPIRED -> 401', async (t) => {
  for (const [mensagem, status, codigo] of [
    ['FORBIDDEN: role CUSTOMER nao ve fila', 403, 'FORBIDDEN'],
    ['SESSION_EXPIRED: token expirado', 401, 'SESSION_EXPIRED'],
  ]) {
    const fake = managerFake(async (name) => {
      if (name === 'business_list_shuttle_reservations') return { data: null, error: { message: mensagem } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    });
    const { handler, restore } = loadFunction('empresa.js', fake);
    const res = await handler(makeEvent({ query: { mode: 'reservations' }, headers: authHeaders() }));
    restore();
    assert.strictEqual(res.statusCode, status, mensagem);
    assert.strictEqual(parseBody(res).error, codigo);
  }
});

test('empresa: GET mode=reservations sem sessao -> 401 e nenhuma RPC de fila', async (t) => {
  const fake = managerFake();
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { mode: 'reservations' } }));
  assert.strictEqual(res.statusCode, 401);
  assert.ok(!fake.calls.rpc.some((c) => c.name === 'business_list_shuttle_reservations'));
});

// ------------------------------------------------------------
// POST review_reservation
// ------------------------------------------------------------

test('empresa: POST review_reservation confirma e devolve o novo status', async (t) => {
  const calls = [];
  const fake = managerFake(async (name, args) => {
    if (name === 'business_review_shuttle_reservation') {
      calls.push(args);
      return { data: { reservationId: 'r-1', status: 'confirmed' }, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'review_reservation', reservationId: 'r-1', decision: 'confirm' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_tenant_id, 't-1');
  assert.strictEqual(calls[0].p_actor_user_id, 'u-merchant-1');
  assert.strictEqual(calls[0].p_reservation_id, 'r-1');
  assert.strictEqual(calls[0].p_action, 'confirm');
  assert.deepStrictEqual(parseBody(res), { reservationId: 'r-1', status: 'confirmed' });
});

test('empresa: POST review_reservation recusa com motivo', async (t) => {
  const calls = [];
  const fake = managerFake(async (name, args) => {
    if (name === 'business_review_shuttle_reservation') {
      calls.push(args);
      return { data: { reservationId: 'r-1', status: 'rejected' }, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'review_reservation', reservationId: 'r-1', decision: 'reject', reason: 'sem vaga no horario' },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls[0].p_action, 'reject');
  assert.strictEqual(calls[0].p_reason, 'sem vaga no horario');
  assert.strictEqual(parseBody(res).status, 'rejected');
});

test('empresa: decision fora de confirm/reject/cancel -> 400 ACTION_INVALID e nenhuma RPC', async (t) => {
  // O guard e antes da RPC de proposito: uma decision invalida nao deve chegar
  // ao banco para virar erro de constraint.
  const fake = managerFake();
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    headers: authHeaders(),
    body: { action: 'review_reservation', reservationId: 'r-1', decision: 'apagada' },
  }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'ACTION_INVALID');
  assert.ok(!fake.calls.rpc.some((c) => c.name === 'business_review_shuttle_reservation'));
});

test('empresa: review sem reservationId -> 400 e nenhuma RPC', async (t) => {
  const fake = managerFake();
  const { handler, restore } = loadFunction('empresa.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST', headers: authHeaders(), body: { action: 'review_reservation', decision: 'confirm' },
  }));
  assert.strictEqual(res.statusCode, 400);
  assert.ok(!fake.calls.rpc.some((c) => c.name === 'business_review_shuttle_reservation'));
});

test('empresa: RESERVATION_NOT_FOUND -> 404 e INVALID_STATUS_TRANSITION -> 409', async (t) => {
  for (const [mensagem, status, codigo] of [
    ['RESERVATION_NOT_FOUND: reserva de outra empresa', 404, 'RESERVATION_NOT_FOUND'],
    ['INVALID_STATUS_TRANSITION: status atual rejected', 409, 'INVALID_STATUS_TRANSITION'],
  ]) {
    const fake = managerFake(async (name) => {
      if (name === 'business_review_shuttle_reservation') return { data: null, error: { message: mensagem } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    });
    const { handler, restore } = loadFunction('empresa.js', fake);
    const res = await handler(makeEvent({
      method: 'POST',
      headers: authHeaders(),
      body: { action: 'review_reservation', reservationId: 'r-1', decision: 'confirm' },
    }));
    restore();
    assert.strictEqual(res.statusCode, status, mensagem);
    assert.strictEqual(parseBody(res).error, codigo);
  }
});
