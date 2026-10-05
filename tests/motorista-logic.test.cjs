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

// ------------------------------------------------------------
// Login simples: entrar no app nao e dirigir
// ------------------------------------------------------------

test('sessao de pendente e sucesso de login, com o status preservado', () => {
  // A RPC emite sessao para 'pending' e devolve o status no corpo. Se a tela
  // tratasse ausencia de 'approved' como falha, o motorista nao entraria nunca.
  const r = L.interpretLogin({ sessionToken: 's', driverId: 'd-2', status: 'pending' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.session.status, 'pending');
  assert.strictEqual(r.error, null);
});

test('rejeitado tambem entra, para poder reenviar o documento corrigido', () => {
  const r = L.interpretLogin({ sessionToken: 's', driverId: 'd-3', status: 'rejected' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.session.status, 'rejected');
});

test('suspenso continua sendo recusa, e a mensagem fala de suspensao', () => {
  const r = L.interpretLogin({ error: 'ACCOUNT_SUSPENDED', status: 'suspended' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.session, null);
  assert.match(r.error, /suspensa/i);
});

test('credenciais erradas dizem telefone ou PIN, nao "aguardando aprovacao"', () => {
  // A confusao classica: com o login destravado, tratar qualquer falha como
  // "cadastro pendente" manda o motorista cadastro novo em vez de conferir o PIN.
  const r = L.interpretLogin({ error: 'INVALID_CREDENTIALS' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Telefone ou PIN/i);
  assert.doesNotMatch(r.error, /aprovacao/i);
});

test('conta bloqueada por tentativas tem mensagem propria', () => {
  const r = L.interpretLogin({ error: 'ACCOUNT_LOCKED' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Muitas tentativas/i);
});

test('canDrive e verdadeiro so para aprovado', () => {
  assert.strictEqual(L.canDrive('approved'), true);
  for (const status of ['pending', 'rejected', 'suspended', '', null, undefined, 'APPROVED']) {
    assert.strictEqual(L.canDrive(status), false, `${status} nao pode dirigir`);
  }
});

test('entrar e dirigir sao decisiones separadas: pendente entra, nao dirige', () => {
  // Este e o contrato do login simples. Se alguem voltar a exigir 'approved'
  // para emitir sessao, a segunda assercao deste teste e a que quebra.
  const r = L.interpretLogin({ sessionToken: 's', driverId: 'd-2', status: 'pending' });
  assert.strictEqual(r.ok, true, 'pendente precisa entrar no app');
  assert.strictEqual(L.canDrive(r.session.status), false, 'mas nao pode dirigir');
});

// ------------------------------------------------------------
// Transmissao de posicao (driver-position)
// ------------------------------------------------------------

test('buildPositionRequest envia coords, campos opcionais e sessao no header', () => {
  const r = L.buildPositionRequest({
    session: SESSION,
    lat: -22.9068, lng: -43.1729, heading: 90, speedKmh: 40.2, shuttleId: 's-1',
  });
  assert.strictEqual(r.headerToken, 'sess-abc');
  assert.strictEqual(r.body.lat, -22.9068);
  assert.strictEqual(r.body.lng, -43.1729);
  assert.strictEqual(r.body.heading, 90);
  assert.strictEqual(r.body.speedKmh, 40.2);
  assert.strictEqual(r.body.shuttleId, 's-1');
  assert.strictEqual('driverSessionToken' in r.body, false, 'a sessao vai no header, nunca no corpo');
  assert.strictEqual('uploadToken' in r.body, false, 'driver-position nao aceita uploadToken');
});

test('buildPositionRequest aceita posicao sem rumo e sem velocidade', () => {
  const r = L.buildPositionRequest({ session: SESSION, lat: '1.5', lng: '2.5' });
  assert.strictEqual(typeof r.body.lat, 'number', 'coords viram numero antes de ir para a rede');
  assert.strictEqual(r.body.heading, null);
  assert.strictEqual(r.body.speedKmh, null);
  assert.strictEqual(r.body.shuttleId, null);
});

test('buildPositionRequest recusa coords invalidas antes da rede', () => {
  for (const ruim of [
    { lat: null, lng: null },
    { lat: 'abc', lng: 2 },
    { lat: 91, lng: 0 },
    { lat: 0, lng: -181 },
    { },
  ]) {
    assert.throws(() => L.buildPositionRequest({ session: SESSION, ...ruim }), /localizacao valida/, JSON.stringify(ruim));
  }
});

test('buildPositionRequest so deixa aprovado enviar', () => {
  assert.throws(
    () => L.buildPositionRequest({ session: { sessionToken: 'x', status: 'pending' }, lat: 1, lng: 2 }),
    /ainda nao foi aprovado/,
  );
  assert.throws(
    () => L.buildPositionRequest({ session: { sessionToken: 'x', status: 'suspended' }, lat: 1, lng: 2 }),
    /ainda nao foi aprovado/,
  );
  assert.throws(
    () => L.buildPositionRequest({ session: null, lat: 1, lng: 2 }),
    /Faca login/,
  );
});

test('friendlyMessage cobre os codigos novos de posicao', () => {
  assert.strictEqual(L.friendlyMessage('INVALID_COORDS'), 'Informe uma localizacao valida.');
  assert.strictEqual(L.friendlyMessage('SHUTTLE_NOT_FOUND'), 'Servico de translado nao encontrado.');
});

test('daysLabel traduz 0..6 e vazio vira todos os dias', () => {
  assert.strictEqual(L.daysLabel([1, 2, 3, 4, 5, 6]), 'Seg, Ter, Qua, Qui, Sex, Sab');
  assert.strictEqual(L.daysLabel([0]), 'Dom');
  assert.strictEqual(L.daysLabel([]), 'todos os dias');
  assert.strictEqual(L.daysLabel(null), 'todos os dias');
});

// ------------------------------------------------------------
// Corridas do dia (driver-shuttle-runs)
// ------------------------------------------------------------

test('buildRunsRequest leva a sessao no header e o dia local na query', () => {
  const r = L.buildRunsRequest({ session: SESSION, date: '2026-10-02' });
  assert.strictEqual(r.headerToken, 'sess-abc');
  assert.strictEqual(r.query, '?date=2026-10-02');
});

test('buildRunsRequest sem date assume o dia local, em YYYY-MM-DD', () => {
  // toISOString() daria UTC: no Brasil (UTC-3) a virada do dia seria sempre
  // errada e a corrida das 22:00 cairia na agenda de amanha.
  const r = L.buildRunsRequest({ session: SESSION });
  assert.ok(/^\?date=\d{4}-\d{2}-\d{2}$/.test(r.query), r.query);
  const hoje = L.localDateIso();
  assert.strictEqual(r.query, `?date=${hoje}`);
});

test('buildRunsRequest barra quem nao esta aprovado, como driver-position', () => {
  assert.throws(
    () => L.buildRunsRequest({ session: { sessionToken: 'x', status: 'pending' } }),
    /ainda nao foi aprovado/,
  );
  assert.throws(
    () => L.buildRunsRequest({ session: { sessionToken: 'x', status: 'rejected' } }),
    /ainda nao foi aprovado/,
  );
  assert.throws(() => L.buildRunsRequest({ session: null }), /Faca login/);
});

test('buildCompleteRunRequest monta o corpo e manda o token no header', () => {
  const r = L.buildCompleteRunRequest({ session: SESSION, reservationId: 'r-1', status: 'confirmed' });
  assert.deepStrictEqual(r.body, { reservationId: 'r-1' });
  assert.strictEqual(r.headerToken, 'sess-abc');
});

test('buildCompleteRunRequest recusa corrida fora de confirmed', () => {
  // Concluir uma corrida ja cancelada e 409 no banco; esconder o erro antes e
  // melhor do que deixar o motorista descobrir na tela.
  for (const status of ['completed', 'cancelled', 'pending', 'rejected']) {
    assert.throws(
      () => L.buildCompleteRunRequest({ session: SESSION, reservationId: 'r-1', status }),
      /nao pode mudar de situacao/,
      status,
    );
  }
});

test('buildCompleteRunRequest exige reserva e aprovacao', () => {
  assert.throws(
    () => L.buildCompleteRunRequest({ session: SESSION, reservationId: '' }),
    /nao encontrada/,
  );
  assert.throws(
    () => L.buildCompleteRunRequest({ session: { sessionToken: 'x', status: 'pending' }, reservationId: 'r-1' }),
    /ainda nao foi aprovado/,
  );
  assert.throws(
    () => L.buildCompleteRunRequest({ session: null, reservationId: 'r-1' }),
    /Faca login/,
  );
});

test('sortRunsByTime ordena por horario e nunca muta a lista original', () => {
  const runs = [
    { reservationId: 'r-2', scheduledFor: '2026-10-02T16:00:00-03:00' },
    { reservationId: 'r-1', scheduledFor: '2026-10-02T09:00:00-03:00' },
    { reservationId: 'r-3', scheduledFor: '2026-10-02T12:00:00-03:00' },
  ];
  const out = L.sortRunsByTime(runs);
  assert.deepStrictEqual(out.map((r) => r.reservationId), ['r-1', 'r-3', 'r-2']);
  assert.deepStrictEqual(runs.map((r) => r.reservationId), ['r-2', 'r-1', 'r-3']);
  assert.deepStrictEqual(L.sortRunsByTime(null), []);
});

test('formatRunWhen formata em pt-BR e devolve vazio em vez de Invalid Date', () => {
  const texto = L.formatRunWhen('2026-10-02T14:00:00-03:00');
  assert.ok(texto.includes('02/10'), texto);
  assert.ok(texto.includes('14:00'), texto);
  assert.strictEqual(L.formatRunWhen(null), '');
  assert.strictEqual(L.formatRunWhen('lixo'), '');
});

test('localDateIso usa o dia local, com dois digitos em mes e dia', () => {
  assert.strictEqual(L.localDateIso(new Date(2026, 0, 5)), '2026-01-05');
  assert.strictEqual(L.localDateIso(new Date(2026, 11, 31)), '2026-12-31');
});

test('friendlyMessage cobre os codigos novos das corridas', () => {
  assert.strictEqual(L.friendlyMessage('RESERVATION_NOT_FOUND'), 'Corrida nao encontrada na sua frota.');
  assert.strictEqual(L.friendlyMessage('INVALID_STATUS_TRANSITION'), 'Esta corrida nao pode mudar de situacao agora.');
  // Os dois que ja existiam continuam com o mesmo texto: NOT_APPROVED e o que
  // segura o card de corridas para quem nao esta na frota.
  assert.strictEqual(L.friendlyMessage('NOT_APPROVED'), 'Seu cadastro ainda nao foi aprovado pela empresa.');
  assert.strictEqual(L.friendlyMessage('SESSION_EXPIRED'), 'Sua sessao expirou. Entre de novo.');
});

test('canDrive continua barrando quem nao e approved, para o card de corridas', () => {
  assert.strictEqual(L.canDrive('approved'), true);
  for (const status of ['pending', 'rejected', 'suspended', null, undefined, '']) {
    assert.strictEqual(L.canDrive(status), false, String(status));
  }
});

// --- CPF / CNPJ --------------------------------------------------------------
//
// Os casos validos abaixo sao os mesmos que foram verificados contra
// public.is_valid_cpf e public.is_valid_cnpj no Postgres. Se um lado mudar e o
// outro nao, estes testes continuam verdes e o motorista passa a receber
// CPF_INVALID do servidor para um CPF que a tela aceitou -- o usuario ve um erro
// que nao consegue reproduzir. Por isso os valores vem do mesmo lugar nos dois
// lados, e nao sao inventados aqui.

test('digitsOnly aceita mascara e descarta o que nao e digito', () => {
  assert.strictEqual(L.digitsOnly('529.982.247-25'), '52998224725');
  assert.strictEqual(L.digitsOnly('11.222.333/0001-81'), '11222333000181');
  assert.strictEqual(L.digitsOnly('abc'), '');
  assert.strictEqual(L.digitsOnly(null), '');
  assert.strictEqual(L.digitsOnly(undefined), '');
});

test('CPF: os validos de referencia passam', () => {
  for (const cpf of ['52998224725', '11144477735', '529.982.247-25']) {
    assert.strictEqual(L.isValidCpf(cpf), true, cpf);
  }
});

test('CPF: o que nao pode passar', () => {
  const invalidos = [
    ['52998224726', 'DV1 errado'],
    ['52998224735', 'DV2 errado'],
    ['11111111111', 'sequencia de 1'],
    ['00000000000', 'zeros'],
    ['99999999999', 'sequencia de 9'],
    ['5299822472', '10 digitos'],
    ['529982247255', '12 digitos'],
    ['529982247a5', 'letra no meio'],
    ['', 'vazio'],
    [null, 'null'],
    [undefined, 'undefined'],
  ];
  for (const [cpf, motivo] of invalidos) {
    assert.strictEqual(L.isValidCpf(cpf), false, `${motivo}: ${cpf}`);
  }
});

test('CNPJ: os validos de referencia passam', () => {
  for (const cnpj of ['11222333000181', '11.222.333/0001-81']) {
    assert.strictEqual(L.isValidCnpj(cnpj), true, cnpj);
  }
});

test('CNPJ: o que nao pode passar', () => {
  const invalidos = [
    ['11222333000182', 'DV1 errado'],
    ['11222333000171', 'DV2 errado'],
    ['11111111111111', 'sequencia de 1'],
    ['00000000000000', 'zeros'],
    ['1122233300018', '13 digitos'],
    ['112223330001811', '15 digitos'],
    ['', 'vazio'],
    [null, 'null'],
  ];
  for (const [cnpj, motivo] of invalidos) {
    assert.strictEqual(L.isValidCnpj(cnpj), false, `${motivo}: ${cnpj}`);
  }
});

test('mascara e progressiva e trava no tamanho do documento', () => {
  assert.strictEqual(L.maskCpf('5'), '5');
  assert.strictEqual(L.maskCpf('5299'), '529.9');
  assert.strictEqual(L.maskCpf('529982247'), '529.982.247');
  assert.strictEqual(L.maskCpf('52998224725'), '529.982.247-25');
  // O 12o digito e ignorado: e o que impede CPF_INVALID num campo ja cheio.
  assert.strictEqual(L.maskCpf('52998224725999'), '529.982.247-25');
  assert.strictEqual(L.maskCnpj('11222333000181'), '11.222.333/0001-81');
  assert.strictEqual(L.maskCnpj('1122233300018'), '11.222.333/0001-8');
  assert.strictEqual(L.maskCnpj('11222333000181999'), '11.222.333/0001-81');
});

test('cpfText/cnpjText devolvem o mascarado e vazio quando nao ha numero', () => {
  assert.strictEqual(L.cpfText('52998224725'), '529.982.247-25');
  assert.strictEqual(L.cnpjText('11222333000181'), '11.222.333/0001-81');
  // Motorista cadastrado antes do CNPJ existe: a revisao da empresa tem de
  // mostrar o campo sem quebrar a tela.
  assert.strictEqual(L.cpfText(null), '');
  assert.strictEqual(L.cnpjText(null), '');
  assert.strictEqual(L.cpfText(''), '');
});

const REG_OK = {
  tenantId: 't-1',
  name: 'Joao da Silva',
  phone: '11988887777',
  email: 'Joao@Email.COM',
  cpf: '529.982.247-25',
  inviteCode: ' abc123 ',
};

test('buildRegisterRequest monta o corpo e normaliza para digitos', () => {
  const b = L.buildRegisterRequest(REG_OK);
  assert.strictEqual(b.tenantId, 't-1');
  assert.strictEqual(b.name, 'Joao da Silva');
  assert.strictEqual(b.email, 'joao@email.com', 'email normalizado em minusculas');
  assert.strictEqual(b.cpf, '52998224725', 'CPF sem mascara: e o que o indice unico compara');
  assert.strictEqual(b.cnpj, null, 'CNPJ ausente vira null, nunca ""');
  assert.strictEqual(b.legalName, null);
  assert.strictEqual(b.inviteCode, 'ABC123', 'convite em maiuscula, como a RPC compara');
});

test('buildRegisterRequest com CNPJ exige razao social', () => {
  const base = { ...REG_OK, cnpj: '11.222.333/0001-81' };
  assert.throws(() => L.buildRegisterRequest(base), /razao social/i);
  const comRazao = L.buildRegisterRequest({ ...base, legalName: '  Translado Azul ME  ' });
  assert.strictEqual(comRazao.cnpj, '11222333000181');
  assert.strictEqual(comRazao.legalName, 'Translado Azul ME', 'razao social aparada');
});

test('buildRegisterRequest aceita razao social sem CNPJ (campo so leitura a mais)', () => {
  const b = L.buildRegisterRequest({ ...REG_OK, legalName: 'Translado Azul ME' });
  assert.strictEqual(b.legalName, 'Translado Azul ME');
  assert.strictEqual(b.cnpj, null);
});

test('buildRegisterRequest barra CPF ausente, invalido ou CNPJ invalido', () => {
  const semCpf = { ...REG_OK, cpf: '' };
  assert.throws(() => L.buildRegisterRequest(semCpf), /CPF/i);

  const cpfInvalido = { ...REG_OK, cpf: '52998224726' };
  assert.throws(() => L.buildRegisterRequest(cpfInvalido), /CPF invalido/i);

  const cnpjInvalido = { ...REG_OK, cnpj: '11222333000182', legalName: 'X ME' };
  assert.throws(() => L.buildRegisterRequest(cnpjInvalido), /CNPJ invalido/i);
});

test('buildRegisterRequest ainda cobra nome, telefone e email', () => {
  assert.throws(() => L.buildRegisterRequest({ ...REG_OK, name: '   ' }), /nome/i);
  assert.throws(() => L.buildRegisterRequest({ ...REG_OK, phone: '' }), /telefone/i);
  assert.throws(() => L.buildRegisterRequest({ ...REG_OK, email: '' }), /email/i);
});

test('erros novos do servidor tem texto amigavel', () => {
  assert.match(L.friendlyMessage('CPF_REQUIRED'), /CPF/i);
  assert.match(L.friendlyMessage('CPF_INVALID'), /invalido/i);
  assert.match(L.friendlyMessage('CNPJ_INVALID'), /invalido/i);
  assert.match(L.friendlyMessage('LEGAL_NAME_REQUIRED'), /razao social/i);
  assert.match(L.friendlyMessage('CPF_ALREADY_REGISTERED'), /ja tem cadastro/i);
  assert.match(L.friendlyMessage('CNPJ_ALREADY_REGISTERED'), /ja tem cadastro/i);
});
