'use strict';

// shuttle-reservation (cliente identificado).
//
// O que estes testes prendem, alem do contrato de HTTP:
//   - a credencial e o customerToken (HMAC do customerId) conferido ANTES de
//     qualquer RPC, e o par trocado (token de A com id de B) nao chega ao banco;
//   - sem tenantId nao ha RPC, como em shuttle.test.cjs;
//   - o detalhe do Postgres ('CODIGO: detalhe') nao vaza na resposta;
//   - toda resposta, inclusive de erro, leva Cache-Control: no-store, porque o
//     payload traz nome de empresa, telefone e horario de um terceiro.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, customerTokenFor } = require('./helpers.cjs');

const TENANT = 't-1';
const CUSTOMER = 'c-1';

function reservationFake(rpcImpl) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (typeof rpcImpl === 'function') return rpcImpl(name, args);
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
}

function authBody(extra = {}) {
  return { tenantId: TENANT, customerId: CUSTOMER, customerToken: customerTokenFor(CUSTOMER), ...extra };
}

function authQuery(extra = {}) {
  return { tenantId: TENANT, customerId: CUSTOMER, customerToken: customerTokenFor(CUSTOMER), ...extra };
}

// ------------------------------------------------------------
// Credencial
// ------------------------------------------------------------

test('sem tenantId -> 400 e nenhuma RPC chamada', async (t) => {
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { customerId: CUSTOMER } }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'TENANT_ID_REQUIRED');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

test('customerToken invalido -> 401 e nenhuma RPC chamada', async (t) => {
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    body: { tenantId: TENANT, customerId: CUSTOMER, customerToken: 'token-adulterado' },
  }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'CUSTOMER_TOKEN_INVALID');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

test('IDOR: token do cliente A com customerId de B -> 401 e a RPC nao e chamada', async (t) => {
  // E o teste que impede ler/cancelar reserva de outra pessoa: o customerId
  // chega do cliente, mas so e usado depois que o HMAC bate com ele.
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    body: { tenantId: TENANT, customerId: 'c-2', customerToken: customerTokenFor('c-1') },
  }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'CUSTOMER_TOKEN_INVALID');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

test('sem customerToken no GET -> 401 e nenhuma RPC chamada', async (t) => {
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { tenantId: TENANT, customerId: CUSTOMER } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'CUSTOMER_TOKEN_INVALID');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

// ------------------------------------------------------------
// POST create
// ------------------------------------------------------------

test('create -> 200 com p_* convertidos e resposta traz businessName/businessPhone', async (t) => {
  const calls = [];
  const fake = reservationFake(async (name, args) => {
    if (name === 'shuttle_create_reservation') {
      calls.push(args);
      return {
        data: {
          reservationId: 'r-1', shuttleId: 's-1', serviceName: 'Aeroporto -> Centro',
          businessName: 'Translado Norte', businessPhone: '11987654321',
          scheduledFor: '2026-10-02T14:00:00-03:00', durationMinutes: 60,
          passengers: 3, priceCents: 4500, status: 'pending', createdAt: '2026-09-29T10:00:00Z',
        },
        error: null,
      };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    // passengers como string: o handler precisa converter, senao a RPC recebe
    // texto e o CHECK do banco recusa.
    body: authBody({ shuttleId: 's-1', scheduledFor: '2026-10-02T14:00:00-03:00', passengers: '3', notes: 'porta 3' }),
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].p_tenant_id, TENANT);
  assert.strictEqual(calls[0].p_customer_id, CUSTOMER);
  assert.strictEqual(calls[0].p_service_id, 's-1');
  assert.strictEqual(calls[0].p_scheduled_for, '2026-10-02T14:00:00-03:00');
  assert.strictEqual(calls[0].p_passengers, 3);
  assert.strictEqual(calls[0].p_notes, 'porta 3');
  const body = parseBody(res);
  assert.strictEqual(body.businessName, 'Translado Norte');
  assert.strictEqual(body.businessPhone, '11987654321');
  assert.strictEqual(body.status, 'pending');
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

test('create sem shuttleId ou sem scheduledFor -> 400 e nenhuma RPC', async (t) => {
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const semServico = await handler(makeEvent({
    method: 'POST', body: authBody({ scheduledFor: '2026-10-02T14:00:00-03:00', passengers: 2 }),
  }));
  assert.strictEqual(semServico.statusCode, 400);
  assert.strictEqual(parseBody(semServico).error, 'SHUTTLE_ID_REQUIRED');
  const semData = await handler(makeEvent({
    method: 'POST', body: authBody({ shuttleId: 's-1', passengers: 2 }),
  }));
  assert.strictEqual(semData.statusCode, 400);
  assert.strictEqual(parseBody(semData).error, 'SCHEDULED_FOR_REQUIRED');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

test('action desconhecida -> 400 ACTION_INVALID e nenhuma RPC', async (t) => {
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: authBody({ action: 'apagar' }) }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'ACTION_INVALID');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

// ------------------------------------------------------------
// POST cancel
// ------------------------------------------------------------

test('cancel -> 200 { reservationId, status: cancelled } com o id do dono', async (t) => {
  const calls = [];
  const fake = reservationFake(async (name, args) => {
    if (name === 'shuttle_cancel_reservation') { calls.push(args); return { data: {}, error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: authBody({ action: 'cancel', reservationId: 'r-9' }) }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { reservationId: 'r-9', status: 'cancelled' });
  assert.strictEqual(calls[0].p_reservation_id, 'r-9');
  assert.strictEqual(calls[0].p_customer_id, CUSTOMER);
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

test('cancel sem reservationId -> 400 e nenhuma RPC', async (t) => {
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: authBody({ action: 'cancel' }) }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'RESERVATION_ID_REQUIRED');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------

test('GET normaliza reservations para array mesmo com data: null', async (t) => {
  // O endpoint pode devolver null sem linha; setReservations(null) no cliente
  // quebraria reservations.filter no render. O handler garante array.
  const fake = reservationFake(async (name) => {
    if (name === 'shuttle_list_customer_reservations') return { data: null, error: null };
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: authQuery() }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { reservations: [], count: 0 });
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

test('GET aceita o formato { reservations: [...] } e conta as linhas', async (t) => {
  const fake = reservationFake(async (name) => {
    if (name === 'shuttle_list_customer_reservations') {
      return { data: { reservations: [{ reservationId: 'r-1', status: 'confirmed' }] }, error: null };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: authQuery({ status: 'confirmed' }) }));
  const body = parseBody(res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.count, 1);
  assert.strictEqual(body.reservations[0].status, 'confirmed');
});

test('GET repassa p_status como filtro de tela, com o customer_id conferido', async (t) => {
  const calls = [];
  const fake = reservationFake(async (name, args) => {
    if (name === 'shuttle_list_customer_reservations') { calls.push(args); return { data: [], error: null }; }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  await handler(makeEvent({ query: authQuery({ status: 'pending' }) }));
  assert.strictEqual(calls[0].p_status, 'pending');
  assert.strictEqual(calls[0].p_customer_id, CUSTOMER);
  assert.strictEqual(calls[0].p_tenant_id, TENANT);
});

// ------------------------------------------------------------
// Erros: codigo no HTTP, detalhe no banco
// ------------------------------------------------------------

test('SLOT_CONFLICT: detalhe -> 409 e o detalhe nao vaza', async (t) => {
  const fake = reservationFake(async (name) => {
    if (name === 'shuttle_create_reservation') {
      return { data: null, error: { message: 'SLOT_CONFLICT: tstzrange(scheduled_for,(scheduled_for + \'01:00\'::interval)) && tstzrange(\'2026-10-02 14:00+00\'::timestamptz,\'2026-10-02 15:00+00\'::timestamptz,\'[)\')' } };
    }
    return { data: null, error: { message: 'unexpected rpc ' + name } };
  });
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    body: authBody({ shuttleId: 's-1', scheduledFor: '2026-10-02T14:00:00-03:00', passengers: 2 }),
  }));
  assert.strictEqual(res.statusCode, 409);
  const body = parseBody(res);
  assert.strictEqual(body.error, 'SLOT_CONFLICT');
  assert.ok(!JSON.stringify(body).includes('tstzrange'), 'detalhe do Postgres nao pode vazar na resposta');
});

test('SHUTTLE_NOT_FOUND -> 404, OUTSIDE_HOURS -> 400, INVALID_STATUS_TRANSITION -> 409', async (t) => {
  const casos = [
    ['shuttle_create_reservation', 'SHUTTLE_NOT_FOUND: servico inativo', 404, 'SHUTTLE_NOT_FOUND'],
    ['shuttle_create_reservation', 'OUTSIDE_HOURS: 23:30 fora de 08:00-18:00', 400, 'OUTSIDE_HOURS'],
    ['shuttle_cancel_reservation', 'INVALID_STATUS_TRANSITION: status atual completed', 409, 'INVALID_STATUS_TRANSITION'],
  ];
  for (const [rpc, mensagem, status, codigo] of casos) {
    const fake = reservationFake(async (name) => {
      if (name === rpc) return { data: null, error: { message: mensagem } };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    });
    const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
    const isCancel = rpc === 'shuttle_cancel_reservation';
    const res = await handler(makeEvent({
      method: 'POST',
      body: authBody(isCancel
        ? { action: 'cancel', reservationId: 'r-1' }
        : { shuttleId: 's-1', scheduledFor: '2026-10-02T14:00:00-03:00', passengers: 2 }),
    }));
    restore();
    assert.strictEqual(res.statusCode, status, mensagem);
    assert.strictEqual(parseBody(res).error, codigo);
  }
});

test('JSON invalido -> 400 INVALID_JSON e nenhuma RPC', async (t) => {
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: '{ nao é json' }));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'INVALID_JSON');
  assert.strictEqual(fake.calls.rpc.length, 0);
});

test('metodo nao suportado -> 405 com no-store', async (t) => {
  const fake = reservationFake();
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'DELETE' }));
  assert.strictEqual(res.statusCode, 405);
  assert.strictEqual(parseBody(res).error, 'METHOD_NOT_ALLOWED');
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

test('falha inesperada -> 500 "erro interno" sem vazar err.message', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async () => { throw new Error('connection to 10.0.0.7:5432 refused, key=service_role'); },
  });
  const { handler, restore } = loadFunction('shuttle-reservation.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: authQuery() }));
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(parseBody(res), { error: 'erro interno' });
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});
