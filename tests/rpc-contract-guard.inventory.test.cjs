'use strict';

// Refaz a inventario de quais RPCs os handlers chamam e tem .sql no repo, e
// confere contra a lista de `rpc-contract-guard.test.cjs`.
//
// O motivo de existir: o numero "6 RPCs sem .sql" que circulava aqui estava
// errado. A varredura anterior casava QUALQUER mencao do nome, e ai:
//
//   - contava comentario como definicao (auth_login aparece em
//     email-login-billing.sql:26 num comentario que so diz "espelha
//     auth_login"; a funcao definida no mesmo arquivo e auth_login_by_email);
//   - e perdia 8 que nao tem mencao nenhuma, sao invisiveis a busca por texto.
//
// O resultado correto sao 14. Este arquivo e a prova de que 14 continua sendo o
// numero: se alguem versionar um .sql novo, ou chamar uma RPC nova, a contagem
// muda e o teste falla pedindo reconciliacao em vez de deixar a lista envelhecer
// em silencio.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'netlify', 'functions');
const SQL_DIR = path.join(ROOT, 'supabase');

function handlerFiles() {
  return fs.readdirSync(FUNCTIONS_DIR).filter((f) => f.endsWith('.js'));
}

function sqlFiles() {
  return fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'));
}

// Toda RPC chamada por um handler. O nome vem do literal passado a .rpc().
function calledRpcs() {
  const names = new Set();
  for (const file of handlerFiles()) {
    const src = fs.readFileSync(path.join(FUNCTIONS_DIR, file), 'utf8');
    for (const m of src.matchAll(/\.rpc\(\s*'([a-z0-9_]+)'/g)) names.add(m[1]);
  }
  return [...names].sort();
}

// Definicao REAL, e nao mencao: exige CREATE [OR REPLACE] FUNCTION seguido do
// nome e abre-parentese. E o que separa `auth_login` (so comentado) de
// `auth_login_by_email` (definido).
function hasDefinition(name) {
  const re = new RegExp(
    `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\(`,
    'i',
  );
  for (const file of sqlFiles()) {
    if (re.test(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'))) return true;
  }
  return false;
}

// A lista do guard, lida do proprio arquivo: nao duplicamos as 14 aqui, senao
// as duas copias divergem sem ninguem perceber.
function guardedRpcs() {
  const src = fs.readFileSync(path.join(__dirname, 'rpc-contract-guard.test.cjs'), 'utf8');
  const start = src.indexOf('const ASSINATURAS = {');
  assert.notStrictEqual(start, -1, 'nao achei ASSINATURAS no guard');
  const body = src.slice(start, src.indexOf('\n};', start));
  const names = new Set();
  for (const m of body.matchAll(/^\s{2}([a-z0-9_]+):\s*\[/gm)) names.add(m[1]);
  return [...names].sort();
}

const CHAMADAS = calledRpcs();
const SEM_SQL = CHAMADAS.filter((r) => !hasDefinition(r));
const COM_SQL = CHAMADAS.filter((r) => hasDefinition(r));
const GUARDADAS = guardedRpcs();

test('a inventario bate com a lista do guard (nenhuma RPC sem .sql escapando)', () => {
  assert.deepStrictEqual(
    SEM_SQL,
    GUARDADAS,
    `divergencia entre as RPCs sem .sql no repo e a lista travada no guard.\n`
    + `  sem .sql mas fora do guard: ${SEM_SQL.filter((r) => !GUARDADAS.includes(r)).join(', ') || '(nenhuma)'}\n`
    + `  no guard mas com .sql agora:  ${GUARDADAS.filter((r) => !SEM_SQL.includes(r)).join(', ') || '(nenhuma)'}`,
  );
});

test('contagem de RPCs sem .sql continua sendo 14', () => {
  assert.strictEqual(SEM_SQL.length, 14, `hoje sem .sql: ${SEM_SQL.join(', ')}`);
});

// Trava o metodo, que e onde o numero errado veio. Se `hasDefinition` voltar a
// casar mencao em vez de definicao, business_coupon_stats (que so aparece num
// comentario em business-report-v3.sql:18) voltaria a contar como versionada.
test('hasDefinition distingue definicao de mencao em comentario', () => {
  // So aparece em comentario; nao pode contar como versionada.
  assert.strictEqual(hasDefinition('business_coupon_stats'), false);
  // Definida de verdade.
  assert.strictEqual(hasDefinition('affiliate_reward_status'), true);
  // auth_login: o nome aparece no repo, mas so como comentario.
  assert.strictEqual(hasDefinition('auth_login'), false);
  // auth_login_by_email: a funcao realmente definida ao lado do comentario.
  assert.strictEqual(hasDefinition('auth_login_by_email'), true);
});

// RPC que o guard trava mas ninguem chama mais: a lista envelheceu.
test('toda RPC travada no guard ainda e chamada por algum handler', () => {
  const orfas = GUARDADAS.filter((r) => !CHAMADAS.includes(r));
  assert.deepStrictEqual(orfas, [], `travando RPC que ninguem chama: ${orfas.join(', ')}`);
});

test('a maioria tem .sql: o repo volta a ser fonte da verdade', () => {
  assert.ok(
    COM_SQL.length > SEM_SQL.length,
    `so ${COM_SQL.length} com .sql contra ${SEM_SQL.length} sem`,
  );
});