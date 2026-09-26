// Regressao do bug que impedia TODO email de OTP de sair em producao.
//
// Os dois dialetos (_otp/_resend em CJS e em ESM) exportam helpers de nome igual
// e assinatura quase igual. O CJS ficou para tras: `sendOtp` recebia so o
// payload e repassava UM argumento para `sendEmail(env, { to, ... })`. O payload
// caia no lugar do `env` e o segundo argumento chegava `undefined`, estourando
// em "Cannot destructure property 'to' of 'undefined'". Nenhum email de
// confirmacao saia, e o motivo so aparecia no log do servidor.
//
// O teste de consistencia nao pega isso: ele confere o grafo de rotas, nao a
// convencao de chamada. E os testes de OTP ja existentes exercitavam
// `isValidOtp`, cuja divergencia de assinatura e DOCUMENTADA e intencional
// (CJS sincrono lendo process.env; ESM assincrono lendo env via crypto.subtle).
// Aqui entao verificamos so o que foi quebrado: a aridade e o repasse do env.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const raiz = path.join(__dirname, '..');
const cjsOtp = require(path.join(raiz, 'netlify', 'functions', '_otp.js'));
const cjsResend = require(path.join(raiz, 'netlify', 'functions', '_resend.js'));
const sendOtpHandler = require(path.join(raiz, 'netlify', 'functions', 'send-otp.js')).handler;

test('sendOtp e sendEmail recebem env como primeiro argumento', () => {
  // Se alguem voltar a assinatura para um so argumento, o `.length` cai para 1
  // e este teste quebra.
  assert.strictEqual(cjsOtp.sendOtp.length, 2, 'sendOtp deveria receber (env, { email, name })');
  assert.strictEqual(cjsResend.sendEmail.length, 2, 'sendEmail deveria receber (env, { to, subject, html })');
});

test('sendOtp degrada em vez de estourar quando nao ha chave de email', async () => {
  // Este e o teste que reproduz o bug sem tocar a rede: o email aqui e valido,
  // entao o sendOtp chega de fato na chamada do sendEmail. Antes da correcao
  // essa linha lancava TypeError; agora tem de devolver um motivo.
  //
  // O motivo devolvido ao CHAMADOR e generico de proposito. O `sendEmail`
  // continua devolvendo o detalhe (teste abaixo) porque ele e a camada interna:
  // quem loga precisa saber a causa, quem mostra na tela nao.
  const r = await cjsOtp.sendOtp({ RESEND_API_KEY: '' }, { email: 'alguem@example.com' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason, 'precisa devolver algum motivo');
  assert.doesNotMatch(r.reason, /RESEND_API_KEY|Cloudflare|Settings|painel/i,
    'o frontend imprime esse motivo na tela: nao pode revelar chave nem hospedagem');
});

test('sendOtp nao repassa a mensagem de erro do transporte', async () => {
  // Mesmo motivo pelo caminho do fetch: a Resend responde 403 com um texto
  // proprio, e esse texto era repassado direto para o corpo da resposta.
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ message: 'You can only send testing emails to your own email address.' }),
  });
  try {
    const r = await cjsOtp.sendOtp({ RESEND_API_KEY: 'k' }, { email: 'alguem@example.com' });
    assert.strictEqual(r.ok, false);
    assert.doesNotMatch(r.reason, /testing emails|own email address/i,
      'a mensagem do provedor nao pode vazar para o cliente');
  } finally {
    globalThis.fetch = real;
  }
});

test('o codigo do OTP nunca aparece no motivo de falha', async () => {
  // `buildOtpCode` e chamado antes do envio, entao o codigo ja existe em
  // memoria quando o transporte falha. Ele nao pode vazar pelo motivo.
  const r = await cjsOtp.sendOtp({ RESEND_API_KEY: '' }, { email: 'alguem@example.com' });
  assert.doesNotMatch(r.reason, /\d{6}/, 'o motivo nao pode conter um codigo de 6 digitos');
});

test('sendOtp rejeita email vazio antes de qualquer envio', async () => {
  // O validador so checa vazio e tamanho: nao ha validacao de formato. Por isso
  // o caso "sem chave nenhuma" acima usa um email de verdade, e este usa o
  // unico input que o codigo realmente recusa.
  for (const email of ['', '   ', null, undefined]) {
    const r = await cjsOtp.sendOtp({}, { email });
    assert.deepEqual(r, { ok: false, reason: 'Email inválido' }, `email ${JSON.stringify(email)}`);
  }
  const longo = `${'a'.repeat(250)}@example.com`;
  assert.deepEqual(await cjsOtp.sendOtp({}, { email: longo }), { ok: false, reason: 'Email inválido' });
});

test('sendEmail devolve { ok:false, reason } quando falta a chave, sem lancar', async () => {
  const r = await cjsResend.sendEmail({ RESEND_API_KEY: '' }, { to: 'x@example.com', subject: 's', html: '<p>x</p>' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /RESEND_API_KEY/);
});

test('o handler send-otp repassa context.env para o sendOtp', async () => {
  // Se o handler voltar a chamar `sendOtp({ email, name })`, o payload entra no
  // lugar do env e o segundo argumento fica undefined: o mesmo bug volta.
  // O email vai vazio, o que faz o sendOtp encerrar antes de qualquer rede.
  const r = await sendOtpHandler({ httpMethod: 'POST', body: JSON.stringify({ email: '' }) }, { env: {} });
  assert.strictEqual(r.statusCode, 400);
  assert.deepEqual(JSON.parse(r.body), { error: 'Email inválido' });
});

test('o handler send-otp repassa 405 em GET sem tocar no sendOtp', async () => {
  const r = await sendOtpHandler({ httpMethod: 'GET', body: null }, { env: {} });
  assert.strictEqual(r.statusCode, 405);
});

test('o handler devolve 500 sem vazar a excecao quando algo estoura de verdade', async () => {
  // Guarda o contrato de erro do handler: nao vaza stack, nao engole o motivo
  // (a causa vai para o log) e nao devolve `err.message` no corpo. O corpo
  // invalido abaixo faria o parse lancar com o proprio input na mensagem.
  const r = await sendOtpHandler({ httpMethod: 'POST', body: 'nao-e-json' }, { env: {} });
  assert.strictEqual(r.statusCode, 500);
  const { error } = JSON.parse(r.body);
  assert.ok(error, 'a resposta de erro precisa trazer um motivo');
  assert.doesNotMatch(error, /nao-e-json|Unexpected token|JSON/i,
    'o erro do parse nao pode ser devolvido ao cliente');
});
