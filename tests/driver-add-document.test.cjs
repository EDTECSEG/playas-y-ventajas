'use strict';

// driver-add-document. O ponto central deste arquivo e o doc_url: a versao
// anterior aceitava a URL pronta do cliente e a RPC so checava tamanho e
// nao-vazio, o que deixava passar documento de terceiros. O endpoint agora faz
// o upload e monta o path no servidor, entao o teste central e o de recusa.

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, PDF_BYTES, PNG_BYTES } = require('./helpers.cjs');

const OK_RPC = (name, args) => {
  if (name === 'driver_add_document') {
    return { data: { documentId: 'doc-1', status: 'pending' }, error: null };
  }
  return { data: null, error: null };
};

function baseBody(extra) {
  return {
    tenantId: 't-1',
    driverId: 'd-1',
    docType: 'cnh',
    uploadToken: 'tok-upload',
    contentType: 'application/pdf',
    fileBase64: PDF_BYTES.toString('base64'),
    ...extra,
  };
}

test('recusa docUrl do cliente em vez de aceitar em silencio', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  // A URL de um PDF que o cliente nao controla. Antes isso era aceito.
  const res = await handler(makeEvent({
    method: 'POST',
    body: baseBody({ docUrl: 'https://exemplo-malicioso.test/cnh.pdf' }),
  }));

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'DOC_URL_NOT_ACCEPTED');
  assert.strictEqual(fake.calls.uploads.length, 0, 'nao pode gravar nada antes de recusar');
  assert.strictEqual(fake.calls.rpc.length, 0, 'nao pode chamar a RPC antes de recusar');
});

test('upload gera path no servidor e a RPC recebe a URL do Storage', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: baseBody() }));

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), { documentId: 'doc-1', status: 'pending' });

  assert.strictEqual(fake.calls.uploads.length, 1);
  const up = fake.calls.uploads[0];
  assert.match(up.filePath, /^driver-documents\/t-1\/d-1\/[0-9a-f-]{36}\.pdf$/);
  assert.strictEqual(up.opts.contentType, 'application/pdf');
  assert.strictEqual(up.opts.upsert, false);
  assert.ok(Buffer.isBuffer(up.body));
  assert.ok(up.body.equals(PDF_BYTES), 'os bytes gravados tem de ser os enviados');

  // O que chega na RPC tem de ser a URL do Storage, nunca a do cliente.
  const call = fake.calls.rpc.find((c) => c.name === 'driver_add_document');
  assert.strictEqual(call.args.p_doc_url, 'https://cdn.example.test/' + up.filePath);
  assert.strictEqual(call.args.p_upload_token, 'tok-upload');
  assert.strictEqual(call.args.p_session_token, null);
});

test('path traversal em driverId nao escapa da pasta de documentos', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    method: 'POST',
    body: baseBody({ driverId: '../../admin' }),
  }));

  assert.strictEqual(res.statusCode, 200);
  const up = fake.calls.uploads[0];
  assert.ok(
    !up.filePath.includes('..'),
    'path com .. no Storage: ' + up.filePath,
  );
  assert.ok(
    up.filePath.startsWith('driver-documents/'),
    'saiu da pasta de documentos: ' + up.filePath,
  );
});

test('conteudo que nao bate com o contentType e recusado antes do upload', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  // Diz PDF, mas manda PNG.
  const res = await handler(makeEvent({
    method: 'POST',
    body: baseBody({ fileBase64: PNG_BYTES.toString('base64') }),
  }));

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(fake.calls.uploads.length, 0, 'nao pode gravar arquivo que nao bate com o tipo');
});

test('tipo fora da lista e recusado', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  for (const contentType of ['image/webp', 'application/zip', 'text/html', 'image/svg+xml']) {
    const res = await handler(makeEvent({ method: 'POST', body: baseBody({ contentType }) }));
    assert.strictEqual(res.statusCode, 400, 'contentType aceito indevidamente: ' + contentType);
  }
  assert.strictEqual(fake.calls.uploads.length, 0);
});

test('arquivo acima de 6 MB e recusado pelo base64 codificado', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  // Nao precisa ser um PDF valido de verdade: o tamanho e barrado antes do
  // decode, entao nem chega a checar magic bytes.
  const grande = 'A'.repeat(9 * 1024 * 1024);
  const res = await handler(makeEvent({
    method: 'POST',
    body: baseBody({ fileBase64: grande }),
  }));

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'arquivo excede o limite de 6 MB');
  assert.strictEqual(fake.calls.uploads.length, 0);
});

test('zero credencial e dois credenciais recusados antes do upload', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  const semNada = baseBody({ uploadToken: undefined });
  const r1 = await handler(makeEvent({ method: 'POST', body: semNada }));
  assert.strictEqual(r1.statusCode, 400);
  assert.strictEqual(parseBody(r1).error, 'AUTH_REQUIRED');

  const dois = baseBody({ driverSessionToken: 'sess-1', uploadToken: 'tok-upload' });
  const r2 = await handler(makeEvent({ method: 'POST', body: dois }));
  assert.strictEqual(r2.statusCode, 400);
  assert.strictEqual(parseBody(r2).error, 'MULTIPLE_CREDENTIALS');

  assert.strictEqual(fake.calls.uploads.length, 0, 'nao grava antes de decidir a autenticacao');
});

test('RPC que recusa apaga o arquivo que ja tinha subido', async (t) => {
  const fake = makeFakeSupabase({
    rpc: (name) => {
      if (name === 'driver_add_document') {
        return { data: null, error: { message: 'driving licence already on file', code: '23505' } };
      }
      return { data: null, error: null };
    },
  });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: baseBody() }));

  assert.ok(res.statusCode >= 400, 'RPC recusou, mas a resposta foi ' + res.statusCode);
  assert.strictEqual(fake.calls.uploads.length, 1, 'deveria ter gravado antes de chamar a RPC');
  assert.strictEqual(fake.calls.removals.length, 1, 'o arquivo orfao tem de ser apagado');
  assert.deepStrictEqual(fake.calls.removals[0], [fake.calls.uploads[0].filePath]);
});

test('docType fora da lista e recusado', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  for (const docType of ['cnh', 'rg', 'crv', 'CNH', 'RG']) {
    const r = await handler(makeEvent({ method: 'POST', body: baseBody({ docType }) }));
    assert.strictEqual(r.statusCode, 200, 'docType valido recusado: ' + docType);
  }
  const ruim = await handler(makeEvent({ method: 'POST', body: baseBody({ docType: 'passaporte' }) }));
  assert.strictEqual(ruim.statusCode, 400);
  assert.strictEqual(parseBody(ruim).error, 'DOC_TYPE_INVALID');
});

test('metodo diferente de POST e recusado', async (t) => {
  const fake = makeFakeSupabase({ rpc: OK_RPC });
  const { handler, restore } = loadFunction('driver-add-document.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'GET' }));
  assert.strictEqual(res.statusCode, 405);
  assert.strictEqual(parseBody(res).error, 'METHOD_NOT_ALLOWED');
});
