'use strict';

// app/motorista/logic.js em ESM puro, importado de um .cjs por import dinamico.
// Sem jsdom, sem testing-library, sem transformador: o runner continua sendo o
// node --test de sempre.

const { test } = require('node:test');
const assert = require('node:assert');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const LOGIC = path.join(__dirname, '..', 'app', 'motorista', 'logic.js');

let L;
test.before(async () => {
  L = await import(pathToFileURL(LOGIC).href);
});

const SESSION = { sessionToken: 'sess-abc', driverId: 'd-1', name: 'Joao', phone: '5511999', status: 'approved' };
const PENDING = { driverId: 'd-2', phone: '5511888', pinToken: 'pin-xyz', uploadToken: 'up-abc', status: 'pending' };
const PENDING_SEM_PIN = { driverId: 'd-2', phone: '5511888', uploadToken: 'up-abc', status: 'pending' };

test('com sessao, a credencial vai no header e nada no corpo', () => {
  const c = L.resolveCredential({ session: SESSION, pending: null });
  assert.strictEqual(c.mode, 'session');
  assert.strictEqual(c.headerToken, 'sess-abc');
  assert.strictEqual(c.bodyToken, null);
});

test('sem sessao, usa uploadToken no corpo e nada no header', () => {
  const c = L.resolveCredential({ session: null, pending: PENDING });
  assert.strictEqual(c.mode, 'upload');
  assert.strictEqual(c.bodyToken, 'up-abc');
  assert.strictEqual(c.headerToken, null);
});

test('sessao tem precedencia sobre cadastro pela metade, e nunca os dois', () => {
  const c = L.resolveCredential({ session: SESSION, pending: PENDING });
  assert.strictEqual(c.mode, 'session');
  assert.strictEqual(c.bodyToken, null, 'os dois tokens juntos e o que o endpoint recusa');
  assert.strictEqual(c.headerToken, 'sess-abc');
});

test('sem sessao e sem uploadToken, recusa', () => {
  assert.throws(() => L.resolveCredential({ session: null, pending: null }), /Faca login/);
  assert.throws(() => L.resolveCredential({ session: null, pending: { uploadToken: '' } }), /Faca login/);
  assert.throws(() => L.resolveCredential({}), /Faca login/);
});

test('interpretLogin so aceita sessionToken como sucesso', () => {
  const ok = L.interpretLogin({ sessionToken: 's', driverId: 'd-1', status: 'approved' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.session.sessionToken, 's');
});

test('NOT_APPROVED com HTTP 200 nao entra como login', () => {
  // Este e o caso que quebra em silencio: a RPC devolve o erro no corpo e o
  // endpoint responde 200, entao quem so olha o status HTTP deixa o motorista
  // nao aprovado entrar.
  const r = L.interpretLogin({ error: 'NOT_APPROVED', status: 'pending' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.session, null);
  assert.strictEqual(r.error, 'Seu cadastro ainda nao foi aprovado pela empresa.');
});

test('conta suspensa e Password errada viram mensagem, nao codigo cru', () => {
  assert.strictEqual(
    L.interpretLogin({ error: 'ACCOUNT_SUSPENDED' }).error,
    'Sua conta esta suspensa. Fale com a empresa.',
  );
  assert.strictEqual(
    L.interpretLogin({ error: 'PIN_INVALID' }).error,
    'Informe um PIN valido.',
  );
});

test('resposta sem token e sem erro vira erro generico, nao sucesso silencioso', () => {
  const r = L.interpretLogin({});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test('pin igual passa; diferente e curto recusam', () => {
  assert.strictEqual(L.checkPin('1234', '1234'), true);
  assert.throws(() => L.checkPin('1234', '9999'), /nao batem/);
  assert.throws(() => L.checkPin('12', '12'), /pelo menos 4/);
  assert.throws(() => L.checkPin('1234', ''), /nao batem/);
});

test('definir o PIN consome pinToken e preserva uploadToken', () => {
  const depois = L.pinConsumed(PENDING);
  assert.strictEqual('pinToken' in depois, false, 'pinToken vale uma vez e nao pode sobrar');
  assert.strictEqual(depois.uploadToken, 'up-abc', 'uploadToken e o que autoriza o documento');
  assert.strictEqual(depois.driverId, 'd-2');
  // O original nao pode ser mutado: a tela ainda pode ler o pinToken dele.
  assert.strictEqual(PENDING.pinToken, 'pin-xyz');
});

test('upload com sessao leva driverId da sessao e token no header', () => {
  const r = L.buildDocumentRequest({
    session: SESSION,
    pending: null,
    docType: 'cnh',
    fileBase64: 'JVBERi0xLjc=',
    contentType: 'application/pdf',
    docNumber: '  123456  ',
  });

  assert.strictEqual(r.body.driverId, 'd-1');
  assert.strictEqual(r.body.docType, 'cnh');
  assert.strictEqual(r.body.docNumber, '123456', 'numero com espaco em volta e normalizado');
  assert.strictEqual(r.body.docExpiresAt, null);
  assert.strictEqual(r.headerToken, 'sess-abc');
  assert.strictEqual('uploadToken' in r.body, false);
  assert.strictEqual('driverSessionToken' in r.body, false);
  assert.strictEqual('docUrl' in r.body, false, 'o servidor monta a URL; mandar seria recusado');
});

test('upload sem sessao leva uploadToken no corpo e nenhum header', () => {
  const r = L.buildDocumentRequest({
    session: null,
    pending: PENDING_SEM_PIN,
    docType: 'crv',
    fileBase64: 'JVBERi0xLjc=',
    contentType: 'application/pdf',
  });

  assert.strictEqual(r.body.driverId, 'd-2');
  assert.strictEqual(r.body.uploadToken, 'up-abc');
  assert.strictEqual(r.headerToken, null);
});

test('upload nao manda a credencial duas vezes mesmo com sessao e pending', () => {
  const r = L.buildDocumentRequest({
    session: SESSION,
    pending: PENDING,
    docType: 'rg',
    fileBase64: 'JVBERi0xLjc=',
    contentType: 'application/pdf',
  });

  const noBody = [r.body.uploadToken, r.body.driverSessionToken].filter(Boolean);
  assert.strictEqual(noBody.length, 0, 'o endpoint recusa credencial dupla com 400');
  assert.ok(r.headerToken, 'a credencial foi no header');
});

test('upload sem arquivo, sem tipo ou com tipo invalido recusa antes da rede', () => {
  const base = { session: SESSION, docType: 'cnh', fileBase64: 'x', contentType: 'application/pdf' };
  assert.throws(() => L.buildDocumentRequest({ ...base, fileBase64: '' }), /Escolha um arquivo/);
  assert.throws(() => L.buildDocumentRequest({ ...base, contentType: '' }), /Escolha um arquivo/);
  assert.throws(() => L.buildDocumentRequest({ ...base, docType: 'passaporte' }), /tipo de documento/);
  assert.throws(() => L.buildDocumentRequest({ ...base, docType: '' }), /tipo de documento/);
});

test('upload sem nenhuma credencial recusa com mensagem de login', () => {
  assert.throws(
    () => L.buildDocumentRequest({
      session: null, pending: null, docType: 'cnh', fileBase64: 'x', contentType: 'application/pdf',
    }),
    /Faca login/,
  );
});

test('friendlyMessage traduz o que o usuario ve e nao engole o resto', () => {
  assert.strictEqual(L.friendlyMessage('DOCUMENT_NOT_FOUND'), 'Documento nao encontrado.');
  assert.strictEqual(L.friendlyMessage('erro interno'), 'Erro no servidor. Tente de novo.');
  assert.strictEqual(L.friendlyMessage(''), '');
  assert.strictEqual(L.friendlyMessage(null), '');
  // Codigo desconhecido passa direto: melhor mostrar do que esconder.
  assert.strictEqual(L.friendlyMessage('CODIGO_NOVO_NAO_MAPEADO'), 'CODIGO_NOVO_NAO_MAPEADO');
});

test('situacao vem da sessao, ou do cadastro pela metade, ou nada', () => {
  assert.strictEqual(L.situationFor({ session: SESSION, pending: null }), 'approved');
  assert.strictEqual(L.situationFor({ session: null, pending: PENDING }), 'pending');
  assert.strictEqual(L.situationFor({ session: null, pending: null }), null);
  // A sessao e mais nova que o registro do cadastro pela metade e manda nela.
  assert.strictEqual(L.situationFor({ session: { status: 'approved' }, pending: { status: 'rejected' } }), 'approved');
});

test('limite de 6 MB e o mesmo do servidor', () => {
  assert.strictEqual(L.MAX_BYTES, 6 * 1024 * 1024);
});

test('cadastro pela metade ainda volta depois do PIN definido', () => {
  // Este e o bug que a extracao expôs: pinToken e consumido ao definir o PIN,
  // entao guardar a reidratacao no pinToken fazia o cadastro pela metade
  // desaparecer no primeiro recarregamento, levando junto o bloco de
  // documentos. Quem manda no upload e o uploadToken.
  const depois = L.pinConsumed(PENDING);
  const raw = JSON.stringify(depois);

  const p = L.pendingFromStorage(raw);
  assert.ok(p, 'o cadastro pela metade precisa sobreviver ao reload');
  assert.strictEqual(p.uploadToken, 'up-abc');
  assert.strictEqual(p.driverId, 'd-2');
  assert.strictEqual(L.pendingFromStorage(JSON.stringify(PENDING)).pinToken, 'pin-xyz');
});

test('sessao volta so com sessionToken', () => {
  assert.ok(L.sessionFromStorage(JSON.stringify(SESSION)));
  assert.strictEqual(L.sessionFromStorage(JSON.stringify({ driverId: 'd-1' })), null);
  assert.strictEqual(L.sessionFromStorage(null), null);
  assert.strictEqual(L.sessionFromStorage(''), null);
});

test('localStorage corrompido vira null em vez de quebrar a tela', () => {
  for (const ruim of ['{nao e json', 'undefined', '[1,2', 'null']) {
    assert.strictEqual(L.pendingFromStorage(ruim), null, `pendente com ${ruim}`);
    assert.strictEqual(L.sessionFromStorage(ruim), null, `sessao com ${ruim}`);
  }
});

test('logic.js nao depende de nada: nem React, nem theme, nem rede', () => {
  // O valor de extrair a logica e exatamente este: o runner nativo do Node
  // importa o modulo sem DOM, sem transformador e sem config. Se alguem
  // adicionar um import aqui, este teste quebra e avisa o motivo.
  const src = require('node:fs').readFileSync(LOGIC, 'utf8');
  const imports = src.match(/^\s*import\s.*$/gm) || [];
  assert.deepStrictEqual(imports, [], 'logic.js precisa continuar sem imports');
});
