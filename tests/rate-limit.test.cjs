'use strict';

// Limite de requisicoes nos endpoints publicos.
//
// O ponto que estes testes existe para travar: o limite conta REQUISICOES, e
// nao falhas. Um limitador por falha (como o do login) seria zerado pelo proprio
// ataque, porque o objetivo de quem abusa de resgate/identify/affiliados e ter
// sucesso. Se alguem "consertar" o _rateLimit.js para voltar a contar so erro,
// o teste 'conta sucesso' abaixo falha -- de proposito.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, ROOT } = require('./helpers.cjs');

const CLAIM = {
  publicId: 'PUB-1',
  customerId: 'c-1',
  couponId: '11111111-1111-4111-8111-111111111111',
  shortCode: 'ABC',
};

const IP = '198.51.100.7';

function fromIp(ip) {
  return { 'x-forwarded-for': ip };
}

function claimFake() {
  return makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'claim_coupon') return { data: CLAIM, error: null };
      return { data: null, error: null };
    },
    from: async () => ({ data: null, error: null }),
  });
}

function identifyFake() {
  return makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'identify_customer') return { data: '11111111-2222-3333-4444-555555555555', error: null };
      return { data: null, error: null };
    },
  });
}

function affiliateFake() {
  return makeFakeSupabase({
    from: async () => ({ data: null, error: null }),
    rpc: async (name) => {
      if (name === 'affiliate_register') {
        return { data: { affiliateId: 'a-1', referralCode: 'ZZZ', shareUrl: '/?ref=ZZZ' }, error: null };
      }
      return { data: null, error: null };
    },
  });
}

async function drain(fn, times, build) {
  const statuses = [];
  for (let i = 0; i < times; i += 1) statuses.push((await fn(build(i))).statusCode);
  return statuses;
}

test('claim-coupon: barra a 21a requisicao do mesmo IP com 429 e Retry-After', async (t) => {
  const fake = claimFake();
  const { handler, restore } = loadFunction('claim-coupon.js', fake);
  t.after(restore);

  const call = () => handler(makeEvent({
    method: 'POST',
    headers: fromIp(IP),
    body: { templateId: 'tmpl-1', phone: '5511999999999' },
  }));

  const statuses = await drain(call, 21, () => null);
  assert.deepStrictEqual(statuses.slice(0, 20), Array(20).fill(200), 'as 20 primeiras passam');
  assert.strictEqual(statuses[20], 429, 'a 21a e barrada');

  const blocked = await call();
  assert.strictEqual(parseBody(blocked).error, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(blocked.headers['Retry-After']) > 0, 'Retry-After positivo');
});

test('claim-coupon: conta SUCESSO, nao so falha (o ataque se autolimpa num limitador por erro)', async (t) => {
  const fake = claimFake();
  const { handler, restore } = loadFunction('claim-coupon.js', fake);
  t.after(restore);

  // Todas estas chamadas dao 200 e criam cupom de verdade. Nenhuma e um erro.
  const call = () => handler(makeEvent({
    method: 'POST',
    headers: fromIp(IP),
    body: { templateId: 'tmpl-1', phone: '5511999999999' },
  }));

  const statuses = await drain(call, 21, () => null);
  assert.deepStrictEqual(statuses.slice(0, 20), Array(20).fill(200),
    '20 resgates bem-sucedidos ainda contam');
  assert.strictEqual(statuses[20], 429,
    'o limite fecha mesmo sem nenhum erro: e este o teste que impede voltar a contar falha');
});

test('claim-coupon: IP diferente nao divide o balde com o do atacante', async (t) => {
  const fake = claimFake();
  const { handler, restore } = loadFunction('claim-coupon.js', fake);
  t.after(restore);

  const call = (ip) => handler(makeEvent({
    method: 'POST',
    headers: fromIp(ip),
    body: { templateId: 'tmpl-1', phone: '5511999999999' },
  }));

  for (let i = 0; i < 20; i += 1) await call(IP);
  assert.strictEqual((await call(IP)).statusCode, 429, 'o IP saturado continua barrado');

  const outro = await call('198.51.100.8');
  assert.strictEqual(outro.statusCode, 200, 'vizinho de rede nao herda o balde');
});

test('identify: barra a 21a requisicao do mesmo IP', async (t) => {
  const fake = identifyFake();
  const { handler, restore } = loadFunction('identify.js', fake);
  t.after(restore);

  const call = () => handler(makeEvent({
    method: 'POST',
    headers: fromIp(IP),
    body: { phone: '+5511999999999' },
  }));

  const statuses = await drain(call, 21, () => null);
  assert.deepStrictEqual(statuses.slice(0, 20), Array(20).fill(200));
  assert.strictEqual(statuses[20], 429);
});

test('affiliates: barra a 11a requisicao do mesmo IP (teto menor, janela maior)', async (t) => {
  const fake = affiliateFake();
  const { handler, restore } = loadFunction('affiliates.js', fake);
  t.after(restore);

  const call = () => handler(makeEvent({
    method: 'POST',
    headers: fromIp(IP),
    body: { name: 'Ana', phone: '5511999999999' },
  }));

  const statuses = await drain(call, 11, () => null);
  assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.strictEqual(statuses[10], 429);
});

test('validate-coupon: NAO limita por IP, porque exige sessao e e tenant-scoped', async (t) => {
  // Decisao, nao esquecimento. Limitar aqui bloquearia o balcao inteiro: varios
  // funcionarios da mesma empresa sao CGNAT no mesmo IP publico. E o endpoint
  // so enxerga o proprio tenant, entao nao ha o que enumerar.
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'validate_and_redeem_coupon') return { data: { ok: true }, error: null };
      return { data: null, error: null };
    },
  });
  const { handler, restore } = loadFunction('validate-coupon.js', fake);
  t.after(restore);

  const call = () => handler(makeEvent({
    method: 'POST',
    headers: { ...fromIp(IP), Authorization: 'Bearer s1' },
    body: { publicId: 'PUB-1' },
  }));

  const statuses = await drain(call, 30, () => null);
  assert.ok(statuses.every((s) => s !== 429), 'nenhum 429 por IP neste endpoint');
});

test('_rateLimit: a janela expira e o balde recomeca', () => {
  const rl = require(path.join(ROOT, 'netlify', 'functions', '_rateLimit.js'));
  const key = 'teste:janela';
  assert.strictEqual(rl.rateLimit(key, 2, 60 * 1000).allowed, true);
  assert.strictEqual(rl.rateLimit(key, 2, 60 * 1000).allowed, true);
  const barrado = rl.rateLimit(key, 2, 60 * 1000);
  assert.strictEqual(barrado.allowed, false);
  assert.ok(barrado.retryInMs > 0 && barrado.retryInMs <= 60 * 1000);

  // Janela curta: uma vez expirada, a mesma chave volta a passar.
  const curta = 'teste:curta';
  assert.strictEqual(rl.rateLimit(curta, 1, 1).allowed, true);
  assert.strictEqual(rl.rateLimit(curta, 1, 1).allowed, false);
  const wait = new Promise((r) => setTimeout(r, 12));
  return wait.then(() => {
    assert.strictEqual(rl.rateLimit(curta, 1, 1).allowed, true, 'balde expirado foi liberado');
  });
});

test('_rateLimit: clientIp usa o primeiro salto do X-Forwarded-For', () => {
  const rl = require(path.join(ROOT, 'netlify', 'functions', '_rateLimit.js'));
  assert.strictEqual(
    rl.clientIp({ headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' } }),
    '203.0.113.9',
    'o primeiro salto e o cliente; os demais sao proxies que acrescentaram o campo',
  );
  assert.strictEqual(rl.clientIp({ headers: { 'cf-connecting-ip': '198.51.100.9' } }), '198.51.100.9');
  assert.strictEqual(rl.clientIp({ headers: {} }), 'unknown');
  assert.strictEqual(rl.clientIp({}), 'unknown');
});

test('_rateLimit: tooManyAttempts devolve Retry-After de pelo menos 1s', () => {
  const rl = require(path.join(ROOT, 'netlify', 'functions', '_rateLimit.js'));
  const res = rl.tooManyAttempts(1);
  assert.strictEqual(res.statusCode, 429);
  assert.strictEqual(JSON.parse(res.body).error, 'TOO_MANY_ATTEMPTS');
  // 1ms arredondaria para 0s, e um Retry-After: 0 manda o cliente repetir na hora.
  assert.strictEqual(res.headers['Retry-After'], '1');
});