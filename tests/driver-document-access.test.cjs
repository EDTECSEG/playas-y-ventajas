// Autorizacao de driver-list-for-business e driver-document-url.
//
// Sao as duas rotas que faltavam para o caminho da aprovacao ter interface, e as
// duas mexem em dado de terceiro: nome e telefone de motorista, e o arquivo de
// CNH/RG. O que estes testes travam e o que o resto do modulo ja faz — ator vem
// da sessao, nunca da query, e nenhuma das duas assina nem devolve caminho de
// arquivo sem a RPC ter aprovado antes.
//
// exercised com o cliente Supabase injetado via stub do modulo, entao nao tocam
// a rede nem o banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const raiz = path.join(__dirname, '..');

const adminPath = require.resolve(path.join(raiz, 'netlify', 'functions', '_supabaseAdmin.js'));

let respostaRpc = { data: null, error: null };
let argsRpc = null;          // para verificar o que o handler mandou para a RPC
let assinatura = { data: { signedUrl: 'https://signed.example/x.pdf?token=abc' }, error: null };
let bucketAssinado = null;   // qual bucket recebeu createSignedUrl
let pathAssinado = null;
let sessaoValida = true;
let tokenPresente = true;
let sessaoLanca = null;

require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    getSupabaseAdminClient: () => ({
      rpc: async (nome, args) => {
        argsRpc = { nome, args };
        return respostaRpc;
      },
      storage: {
        from: (bucket) => ({
          createSignedUrl: async (p) => {
            bucketAssinado = bucket;
            pathAssinado = p;
            return assinatura;
          },
        }),
      },
    }),
    resolveSession: async () => {
      if (sessaoLanca) throw new Error(sessaoLanca);
      if (!sessaoValida) throw new Error('SESSION_EXPIRED');
      return { tenantId: 'tenant-da-sessao', userId: 'ator-da-sessao', businessId: 'negocio-do-ator' };
    },
    extractSessionToken: () => (tokenPresente ? 'tok-de-sessao' : null),
    rpcErrorCode: (e) => String((e && e.message) || '').split(':')[0].trim(),
    rpcErrorStatus: (e) => {
      const c = String((e && e.message) || '');
      if (c.includes('FORBIDDEN')) return 403;
      if (c.includes('NOT_FOUND')) return 404;
      return 400;
    },
  },
};

const listar = require(path.join(raiz, 'netlify', 'functions', 'driver-list-for-business.js')).handler;
const signedUrl = require(path.join(raiz, 'netlify', 'functions', 'driver-document-url.js')).handler;

const ev = (qs) => ({ httpMethod: 'GET', queryStringParameters: qs });

function reset() {
  respostaRpc = { data: null, error: null };
  argsRpc = null;
  assinatura = { data: { signedUrl: 'https://signed.example/x.pdf?token=abc' }, error: null };
  bucketAssinado = null;
  pathAssinado = null;
  sessaoValida = true;
  tokenPresente = true;
  sessaoLanca = null;
}

const DOC = {
  documentId: 'doc-1',
  docType: 'cnh',
  status: 'pending',
  docNumber: '12345678900',
  driverId: 'drv-1',
  driverName: 'Maria Souza',
  docPath: 'driver-documents/tenant-1/drv-1/abc-123.pdf',
};

test('listagem: sem token nao devolve nada e nao chama a RPC', async () => {
  reset();
  tokenPresente = false;
  const r = await listar(ev({}));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(argsRpc, null, 'nao deve consultar a RPC sem sessao');
});

test('listagem: documentId/query do cliente nao substitui o ator da sessao', async () => {
  reset();
  await listar(ev({ status: 'pending', tenantId: 'tenant-do-atacante', actorUserId: 'atacante' }));
  assert.strictEqual(argsRpc.args.p_tenant_id, 'tenant-da-sessao');
  assert.strictEqual(argsRpc.args.p_actor_user_id, 'ator-da-sessao');
  assert.strictEqual(argsRpc.args.p_status, 'pending');
});

test('listagem: resposta normalizada com documents sempre array', async () => {
  reset();
  respostaRpc = { data: [{ driverId: 'd1', name: 'A', documents: null }], error: null };
  const r = await listar(ev({}));
  const b = JSON.parse(r.body);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(b.count, 1);
  assert.deepStrictEqual(b.drivers[0].documents, []);
});

test('listagem: RPC devolvendo algo que nao e array nao quebra a tela', async () => {
  reset();
  respostaRpc = { data: null, error: null };
  const b = JSON.parse((await listar(ev({}))).body);
  assert.deepStrictEqual(b.drivers, []);
  assert.strictEqual(b.count, 0);
});

test('listagem: recusa da RPC e repassada, nao engolida em 200', async () => {
  reset();
  respostaRpc = { data: null, error: { message: 'FORBIDDEN' } };
  const r = await listar(ev({}));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(JSON.parse(r.body).error, 'FORBIDDEN');
});

test('listagem: sessao expirada responde 401, e nao 500', async () => {
  reset();
  sessaoLanca = 'SESSION_EXPIRED';
  const r = await listar(ev({}));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(JSON.parse(r.body).error, 'SESSION_EXPIRED');
});

test('listagem: metodo diferente de GET e 405', async () => {
  reset();
  assert.strictEqual((await listar({ httpMethod: 'POST', queryStringParameters: {} })).statusCode, 405);
});

test('documento: sem documentId nao assina nada', async () => {
  reset();
  const r = await signedUrl(ev({}));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(bucketAssinado, null, 'nao pode assinar sem documentId');
});

test('documento: sem token nao assina nada', async () => {
  reset();
  tokenPresente = false;
  const r = await signedUrl(ev({ documentId: 'doc-1' }));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(bucketAssinado, null, 'nao pode assinar sem sessao');
});

test('documento: ator e tenant vem da sessao, nunca da query', async () => {
  reset();
  respostaRpc = { data: DOC, error: null };
  await signedUrl(ev({ documentId: 'doc-1', tenantId: 'tenant-do-atacante', actorUserId: 'atacante' }));
  assert.strictEqual(argsRpc.args.p_tenant_id, 'tenant-da-sessao');
  assert.strictEqual(argsRpc.args.p_actor_user_id, 'ator-da-sessao');
  assert.strictEqual(argsRpc.args.p_document_id, 'doc-1');
});

test('documento: FORBIDDEN da RPC vira 403 e NAO assina URL', async () => {
  reset();
  respostaRpc = { data: null, error: { message: 'FORBIDDEN' } };
  const r = await signedUrl(ev({ documentId: 'doc-de-outra-empresa' }));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(JSON.parse(r.body).error, 'FORBIDDEN');
  assert.strictEqual(bucketAssinado, null, 'recusa da RPC precisa ocorrer ANTES da assinatura');
});

test('documento: NOT_FOUND da RPC vira 404 e nao assina', async () => {
  reset();
  respostaRpc = { data: null, error: { message: 'NOT_FOUND' } };
  const r = await signedUrl(ev({ documentId: 'inexistente' }));
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(bucketAssinado, null);
});

test('documento: assina o bucket e o path do doc_url, com validade de 5 min', async () => {
  reset();
  respostaRpc = { data: DOC, error: null };
  const r = await signedUrl(ev({ documentId: 'doc-1' }));
  const b = JSON.parse(r.body);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(bucketAssinado, 'driver-documents');
  assert.strictEqual(pathAssinado, 'tenant-1/drv-1/abc-123.pdf');
  assert.strictEqual(b.expiresIn, 300);
  assert.strictEqual(b.url, 'https://signed.example/x.pdf?token=abc');
  assert.ok(!r.body.includes('docPath'), 'o path interno nao deve vazar na resposta');
});

test('documento: resposta traz no-store, senao proxy reentrega a URL assinada', async () => {
  reset();
  respostaRpc = { data: DOC, error: null };
  const r = await signedUrl(ev({ documentId: 'doc-1' }));
  assert.strictEqual(r.headers['Cache-Control'], 'no-store');
});

test('documento: path malformado ou de outro bucket nao e assinado', async () => {
  // O bucket vem do codigo, nao do doc_url. Entanto TODOS estes valores sao
  // recusados com 500 e sem assinatura, inclusive `pyv-images/logo.png`: um
  // arquivo publico nao deve virar URL "assinada" por engano de gravacao.
  for (const mau of ['', 'sem-barra', 'driver-documents/', 'pyv-images/logo.png', 'driver-documents/../../pyv-images/logo.png']) {
    reset();
    respostaRpc = { data: { ...DOC, docPath: mau }, error: null };
    const r = await signedUrl(ev({ documentId: 'doc-1' }));
    assert.strictEqual(r.statusCode, 500, `path "${mau}" deveria ser rejeitado`);
    assert.strictEqual(bucketAssinado, null, `path "${mau}" nao pode assinar nada`);
    assert.strictEqual(pathAssinado, null);
  }
});

test('documento: bucket fixo no codigo, nao vem do doc_url', async () => {
  reset();
  respostaRpc = { data: { ...DOC, docPath: 'driver-documents/tenant-1/drv-1/abc-123.pdf' }, error: null };
  await signedUrl(ev({ documentId: 'doc-1' }));
  assert.strictEqual(bucketAssinado, 'driver-documents');
});

test('documento: falha do storage vira 500, sem URL no corpo', async () => {
  reset();
  respostaRpc = { data: DOC, error: null };
  assinatura = { data: null, error: { message: 'boom' } };
  const r = await signedUrl(ev({ documentId: 'doc-1' }));
  assert.strictEqual(r.statusCode, 500);
  assert.ok(!r.body.includes('token='), 'nao pode vazar URL parcial em caso de erro');
});

test('documento: sessao expirada responde 401, e nao 500', async () => {
  reset();
  sessaoLanca = 'SESSION_EXPIRED';
  const r = await signedUrl(ev({ documentId: 'doc-1' }));
  assert.strictEqual(r.statusCode, 401);
});

test('documento: metodo diferente de GET e 405', async () => {
  reset();
  assert.strictEqual((await signedUrl({ httpMethod: 'POST', queryStringParameters: {} })).statusCode, 405);
});
