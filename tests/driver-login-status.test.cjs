// Regressao: `driver_login` recusava login com HTTP 200.
//
// A RPC nao levanta erro — devolve jsonb_build_object('error', ...) como dado de
// sucesso. O handler so olhava `error` (que chega null) e devolvia 200 com
// {error:'INVALID_CREDENTIALS'} no corpo. O cliente do motorista contornava com
// interpretLogin(), mas qualquer outro consumidor trataria a recusa como
// sucesso, e nenhuma tentativa de login errada apareceria em monitoramento.
//
// Estes testes exercitam o handler com o cliente Supabase injetado via stub do
// modulo, entao nao tocam a rede nem o banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const raiz = path.join(__dirname, '..');

// Troca o _supabaseAdmin por um stub antes de carregar o handler, para poder
// simular a RPC devolvendo recusa no corpo.
const adminPath = require.resolve(path.join(raiz, 'netlify', 'functions', '_supabaseAdmin.js'));
let respostaRpc = { data: null, error: null };
require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    getSupabaseAdminClient: () => ({
      rpc: async () => respostaRpc,
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }),
    }),
    resolveSession: async () => ({ tenantId: 't', userId: 'u', businessId: 'b' }),
    extractSessionToken: () => null,
    rpcErrorCode: (e) => String((e && e.message) || '').split(':')[0].trim(),
    rpcErrorStatus: () => 400,
  },
};

const { handler } = require(path.join(raiz, 'netlify', 'functions', 'driver-login.js'));

const ev = (body) => ({ httpMethod: 'POST', body: JSON.stringify(body) });
const valido = { tenantId: '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9', phone: '5511999888777', pin: '1234' };

test('telefone ou PIN errado responde 401, nao 200', async () => {
  respostaRpc = { data: { error: 'INVALID_CREDENTIALS' }, error: null };
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 401);
  assert.deepEqual(JSON.parse(r.body), { error: 'INVALID_CREDENTIALS' });
});

test('cadastro pendente responde 403, para o app dizer "aguardando aprovacao"', async () => {
  respostaRpc = { data: { error: 'PENDING_APPROVAL', status: 'pending' }, error: null };
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(JSON.parse(r.body).error, 'PENDING_APPROVAL');
});

test('rejeitado, suspenso e nao-aprovado tambem respondem 403', async () => {
  for (const codigo of ['REGISTRATION_REJECTED', 'ACCOUNT_SUSPENDED', 'NOT_APPROVED']) {
    respostaRpc = { data: { error: codigo }, error: null };
    const r = await handler(ev(valido));
    assert.strictEqual(r.statusCode, 403, `${codigo} deveria ser 403`);
  }
});

test('conta bloqueada responde 429', async () => {
  respostaRpc = { data: { error: 'ACCOUNT_LOCKED' }, error: null };
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 429);
});

test('login valido continua 200 e devolve a sessao', async () => {
  respostaRpc = { data: { sessionToken: 'tok', driverId: 'd1', status: 'approved' }, error: null };
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(JSON.parse(r.body).sessionToken, 'tok');
  assert.strictEqual(r.headers['Cache-Control'], 'no-store');
});

test('nenhum caminho de recusa devolve 200', async () => {
  for (const codigo of ['INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'PENDING_APPROVAL', 'REGISTRATION_REJECTED', 'ACCOUNT_SUSPENDED', 'NOT_APPROVED']) {
    respostaRpc = { data: { error: codigo }, error: null };
    const r = await handler(ev(valido));
    assert.notStrictEqual(r.statusCode, 200, `${codigo} nao pode ser 200`);
    assert.ok(r.statusCode >= 400, `${codigo} deveria ser 4xx, veio ${r.statusCode}`);
  }
});

test('erros de validacao nao mudaram', async () => {
  respostaRpc = { data: null, error: null };
  assert.strictEqual((await handler(ev({ phone: 'x', pin: 'y' }))).statusCode, 400); // sem tenantId
  assert.strictEqual((await handler(ev({ tenantId: 't', pin: 'y' }))).statusCode, 400); // sem phone
  assert.strictEqual((await handler(ev({ tenantId: 't', phone: 'x' }))).statusCode, 400); // sem pin
  assert.strictEqual((await handler({ httpMethod: 'GET' })).statusCode, 405);
});
