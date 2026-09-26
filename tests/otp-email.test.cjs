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
  const r = await cjsOtp.sendOtp({ RESEND_API_KEY: '' }, { email: 'alguem@example.com' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /RESEND_API_KEY/);
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

test('o handler devolve 500 com o motivo quando algo estoura de verdade', async () => {
  // Guarda o contrato de erro do handler: nao vaza stack, mas nao engole o motivo.
  const r = await sendOtpHandler({ httpMethod: 'POST', body: 'nao-e-json' }, { env: {} });
  assert.strictEqual(r.statusCode, 500);
  assert.ok(JSON.parse(r.body).error, 'a resposta de erro precisa trazer um motivo');
});
