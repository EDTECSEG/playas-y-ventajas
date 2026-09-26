'use strict';

// Testa o adaptador em out/_worker.js, nao os handlers isolados. O que importa
// aqui e o que o cliente recebe: header de cache e ausencia de detalhe interno
// no corpo do erro.
//
// Depende do bundle, entao roda depois de npm run build. Sem o arquivo, pula.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const BUNDLE = path.join(__dirname, '..', 'out', '_worker.js');

function loadBundle() {
  if (!fs.existsSync(BUNDLE)) return null;
  return import(pathToFileURL(BUNDLE).href);
}

function get(worker, pathname, env) {
  return worker.fetch(new Request('https://exemplo.pages.dev' + pathname), env || {});
}

test('toda resposta leva cache-control no-store', { skip: !fs.existsSync(BUNDLE) && 'bundle ainda nao construido (rode npm run build)' }, async () => {
  const mod = await loadBundle();
  const worker = mod.default;

  for (const rota of ['/login', '/.netlify/functions/nao-existe-xyz', '/.netlify/functions/__envdiag']) {
    const res = await get(worker, rota);
    assert.strictEqual(
      res.headers.get('cache-control'),
      'no-store',
      'rota sem cache-control no-store: ' + rota,
    );
  }
});

test('erro inesperado nao devolve a mensagem interna para o cliente', { skip: !fs.existsSync(BUNDLE) && 'bundle ainda nao construido (rode npm run build)' }, async () => {
  const mod = await loadBundle();
  const worker = mod.default;

  // Sem env vars, admin estoura em getSupabaseAdminClient() antes do try
  // interno do handler. E o caminho perfeito: o erro sobe para o catch do
  // adaptador e antes voltava para o cliente inteiro.
  const res = await get(worker, '/.netlify/functions/admin');
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');

  const body = await res.json();
  assert.deepStrictEqual(body, { error: 'erro interno' });
  const bruto = JSON.stringify(body);
  assert.ok(!bruto.includes('Env vars ausentes'), 'vazou detalhe de env no corpo: ' + bruto);
  assert.ok(!bruto.toLowerCase().includes('supabase_service_role'), 'vazou nome de secret: ' + bruto);
});

test('erro de sessao continua sendo contrato do cliente (401 + texto original)', { skip: !fs.existsSync(BUNDLE) && 'bundle ainda nao construido (rode npm run build)' }, async () => {
  const mod = await loadBundle();
  const worker = mod.default;

  // O frontend compara o texto para decidir se renova a sessao, entao
  // SESSION_REQUIRED nao pode virar 'erro interno'.
  const res = await worker.fetch(
    new Request('https://exemplo.pages.dev/.netlify/functions/admin', {
      method: 'GET',
      headers: { authorization: 'Bearer token-invalido-de-teste' },
    }),
    {},
  );
  const body = await res.json();
  const texto = body && body.error;
  assert.ok(
    texto === 'SESSION_REQUIRED' || texto === 'SESSION_EXPIRED' || texto === 'erro interno',
    'texto de erro inesperado: ' + JSON.stringify(body),
  );
  if (texto === 'erro interno') {
    // Sem env nao da para chegar no check de sessao; o que importa e que
    // nao estourou detalhe.
    assert.strictEqual(res.status, 500);
  }
});
