'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const GOOD_PIN = '1234';
const WRONG_PIN = '0000';

test('login com credenciais corretas retorna 200 + sessionToken', async (t) => {
  let called = null;
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_login') {
        called = { name, args };
        return {
          data: { sessionToken: 'tok-1', userId: 'u1', tenantId: 't1', role: 'MERCHANT', businessId: 'b1' },
          error: null,
        };
      }
      if (name === 'auth_pin_reset_required') return { data: false, error: null };
      return { data: null, error: { message: 'unexpected rpc' } };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({
    method: 'POST',
    body: { tenantSlug: 'playas-y-ventajas', internalCode: 'MERCHANT-001', pin: GOOD_PIN },
  }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).sessionToken, 'tok-1');
  assert.strictEqual(called.args.p_tenant_slug, 'playas-y-ventajas');
});

test('login retorna mustChangePin=true quando o admin resetou a senha', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_login') return {
        data: { sessionToken: 'tok-1', userId: 'u1', tenantId: 't1', role: 'MERCHANT', businessId: 'b1' },
        error: null,
      };
      if (name === 'auth_pin_reset_required') {
        assert.strictEqual(args.p_user_id, 'u1');
        return { data: true, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc' } };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-1', pin: '123456' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseBody(res).mustChangePin, true);
});

test('login com pin errado retorna 401 INVALID_CREDENTIALS', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_login') return { data: { error: 'INVALID_CREDENTIALS' }, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-1', pin: WRONG_PIN } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'INVALID_CREDENTIALS');
});

test('login silencia tenant inexistente como erro inesperado (400 da rpc propaga como 401)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async () => ({ data: null, error: { message: 'NOT_FOUND: tenant' } }),
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'nao-existe', internalCode: 'M-1', pin: GOOD_PIN } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'NOT_FOUND');
});

test('login bloqueia entrada invalida (campos/formatos) sem chamar o banco', async (t) => {
  let dbCalls = 0;
  const fake = makeFakeSupabase({
    rpc: async () => { dbCalls += 1; return { data: null, error: null }; },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);

  // campos faltando
  let res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x' } }));
  assert.strictEqual(res.statusCode, 400);

  // internalCode fora do padrao
  res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'a b!c', pin: GOOD_PIN } }));
  assert.strictEqual(res.statusCode, 400);

  // pin nao string / gigante
  res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-1', pin: 'x'.repeat(200) } }));
  assert.strictEqual(res.statusCode, 400);

  // http method errado
  res = await handler(makeEvent({ method: 'GET', query: { x: 1 } }));
  assert.strictEqual(res.statusCode, 405);

  assert.strictEqual(dbCalls, 0);
});

test('login bloqueia apos 5 falhas (429) mesmo com senha correta, e sucesso reseta o contador', async (t) => {
  let wrong = true;
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_login') {
        if (wrong) return { data: { error: 'INVALID_CREDENTIALS' }, error: null };
        return { data: { sessionToken: 'tok-ok' }, error: null };
      }
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);

  // 4 falhas: ainda nao bloqueia
  wrong = true;
  for (let i = 0; i < 4; i++) {
    const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-2', pin: WRONG_PIN } }));
    assert.strictEqual(res.statusCode, 401, `falha ${i} deveria ser 401`);
  }
  // 5a falha registra o bloqueio (mas a resposta e 401; o bloqueio age na proxima)
  let res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-2', pin: WRONG_PIN } }));
  assert.strictEqual(res.statusCode, 401, '5a falha ainda retorna 401');

  // mesma com senha correta, agora bloqueado
  wrong = false;
  res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-2', pin: GOOD_PIN } }));
  assert.strictEqual(res.statusCode, 429, 'bloqueio vale mesmo para senha correta');
  res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-2', pin: GOOD_PIN } }));
  assert.strictEqual(res.statusCode, 429);

  // codigo diferente nao e afetado pelo bloqueio do M-2
  const okFake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_login') return { data: { sessionToken: 'tok-ok' }, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const ok2 = loadFunction('login.js', okFake);
  const plain = await ok2.handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'OTHER', pin: GOOD_PIN } }));
  ok2.restore();
  assert.strictEqual(plain.statusCode, 200);
});

test('login bem-sucedido zera o contador de falhas do mesmo codigo', async (t) => {
  let fail = true;
  const fake = makeFakeSupabase({
    rpc: async () => {
      if (fail) return { data: { error: 'INVALID_CREDENTIALS' }, error: null };
      return { data: { sessionToken: 'tok' }, error: null };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);

  // 4 falhas
  for (let i = 0; i < 4; i++) {
    const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-3', pin: WRONG_PIN } }));
    assert.strictEqual(res.statusCode, 401);
  }
  // sucesso apaga o contador
  fail = false;
  let res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-3', pin: GOOD_PIN } }));
  assert.strictEqual(res.statusCode, 200);

  // 5 falhas novas e depois o bloqueio vale de novo (contador recomecou de zero)
  fail = true;
  for (let i = 0; i < 5; i++) {
    res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-3', pin: WRONG_PIN } }));
    assert.strictEqual(res.statusCode, 401);
  }
  res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-3', pin: WRONG_PIN } }));
  assert.strictEqual(res.statusCode, 429);
});

// --- bucket por IP -------------------------------------------------------
// Regressao: `ip:${ip}` era consultado mas nunca alimentado, entao o bucket
// ficava permanentemente vazio e a checagem devolvia sempre "allowed". O
// limite por IP era inerte: nenhuma combinacao de tentativas o ativava.

test('login bloqueia o IP apos 20 falhas distribuidas entre codigos diferentes', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_login') return { data: { error: 'INVALID_CREDENTIALS' }, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);

  // Cada codigo so erra uma vez, entao NENHUM credential individual bate o
  // limite de 5. E exatamente esse o ataque que o lock por codigo nao pega.
  for (let i = 0; i < 20; i++) {
    const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: `ATK-${i}`, pin: WRONG_PIN } }));
    assert.strictEqual(res.statusCode, 401, `tentativa ${i} deveria ser 401`);
  }

  // 21a tentativa, agora com a senha CORRETA: o bloqueio e por origem, e nao
  // por credencial, entao nem um login valido passa.
  const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'ATK-0', pin: GOOD_PIN } }));
  assert.strictEqual(res.statusCode, 429, 'o IP deveria estar bloqueado');
  assert.ok(parseBody(res).error, 'corpo de erro presente');
});

test('login nao propaga o bloqueio de IP para outra origem', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_login') return { data: { error: 'INVALID_CREDENTIALS' }, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);

  for (let i = 0; i < 20; i++) {
    await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: `ATK-${i}`, pin: WRONG_PIN } }));
  }
  const blocked = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'ATK-0', pin: WRONG_PIN } }));
  assert.strictEqual(blocked.statusCode, 429);

  // outra origem (203.0.113.9 e o IP padrao dos testes)
  const other = await handler(makeEvent({
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.7' },
    body: { tenantSlug: 'x', internalCode: 'ATK-0', pin: WRONG_PIN },
  }));
  assert.strictEqual(other.statusCode, 401, 'um IP distinto nao pode herdar o bloqueio');
});

test('login bem-sucedido zera o contador de falhas do IP', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name !== 'auth_login') return { data: null, error: { message: 'unexpected' } };
      if (args.p_internal_code === 'BOM') {
        return { data: { sessionToken: 'tok-ok' }, error: null };
      }
      return { data: { error: 'INVALID_CREDENTIALS' }, error: null };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);

  // 19 falhas: uma a menos do limite, bucket tem fails=19
  for (let i = 0; i < 19; i++) {
    const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: `ATK-${i}`, pin: WRONG_PIN } }));
    assert.strictEqual(res.statusCode, 401, `falha ${i} deveria ser 401`);
  }

  // um login legitimo zera o bucket por IP
  const ok = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'BOM', pin: GOOD_PIN } }));
  assert.strictEqual(ok.statusCode, 200);

  // Sem o reset, a 1a destas 19 voltaria a levar o contador a 20 e a 2a ja
  // seria 429. Todas continuarem em 401 e o que prova que o bucket foi limpo.
  for (let i = 0; i < 19; i++) {
    const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: `DEPOIS-${i}`, pin: WRONG_PIN } }));
    assert.strictEqual(res.statusCode, 401, `falha pos-sucesso ${i} deveria ser 401`);
  }
});

test('login com credencial ja bloqueada nao infla o contador por IP', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_login') return { data: { error: 'INVALID_CREDENTIALS' }, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('login.js', fake);
  t.after(restore);

  // trava M-9 no limite de 5 por credencial
  for (let i = 0; i < 5; i++) {
    await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-9', pin: WRONG_PIN } }));
  }

  // martela o codigo ja bloqueado: cada uma responde 429 pelo limite de
  // credencial e retorna ANTES de registrar falha por IP. Se registrasse, 20
  // repetidas trancariam o IP inteiro -- um DoS que o proprio atacante
  // fabricaria contra o escritorio inteiro.
  for (let i = 0; i < 30; i++) {
    const res = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'M-9', pin: WRONG_PIN } }));
    assert.strictEqual(res.statusCode, 429, `martelada ${i} deveria ser 429 por credencial`);
  }

  // um codigo novo, sem falhas, ainda passa: o IP nao foi contaminado
  const fresh = await handler(makeEvent({ method: 'POST', body: { tenantSlug: 'x', internalCode: 'NOVO', pin: WRONG_PIN } }));
  assert.strictEqual(fresh.statusCode, 401, 'o IP nao pode ser trancado por martelada a um codigo bloqueado');
});