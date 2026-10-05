// Contrato do worker de cadastro publico (netlify/functions/driver-register.js).
//
// Este handler e a fronteira onde o cadastro de motorista vira linha no banco.
// Tres coisas quebram aqui sem nenhuma testemunha, e por isso sao o que estes
// testes prende:
//
//   1. O NOME DOS ARGUMENTOS. A RPC e chamada por nome (p_cpf, p_cnpj,
//      p_legal_name). Errar a grafia nao da erro de sintaxe: o Supabase manda o
//      objeto, a RPC nao recebe o argumento, cai no DEFAULT NULL, e o cadastro
//      passa a gravar CPF/CNPJ vazio. O banco aceita e o bug so aparece no
//      cadastro do motorista seguinte. Por isso o teste exige as chaves exatas.
//   2. O AVISO DE CPF AUSENTE. A exigencia que vale mora na p7, mas aqui ha um
//      aviso antecipado para o erro sair em codigo. O aviso e worthless se a
//      chamada chegar ao banco: o ganho era nao gastar ida, entao o teste
//      verifica que a RPC NAO foi chamada.
//   3. VAZIO vs NULL. Mandar '' em vez de null nao quebra hoje (a RPC normaliza
//      com nullif), mas deixa o campo "parecendo preenchido" em qualquer log de
//      chamada feito no futuro -- e o comentario do arquivo avisa exatamente
//      isso. E um DEFAULT que o p8 ja usa como sentinela.
//
// O cliente Supabase e injetado via stub do modulo: nenhum teste toca rede nem
// banco. Padrao identico ao driver-login-status.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const raiz = path.join(__dirname, '..');

const adminPath = require.resolve(path.join(raiz, 'netlify', 'functions', '_supabaseAdmin.js'));
let respostaRpc = { data: null, error: null };
let lancamentos = [];
let lancarErro = null;

require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    getSupabaseAdminClient: () => ({
      rpc: async (fn, args) => {
        lancamentos.push({ fn, args });
        if (lancarErro) throw lancarErro;
        return respostaRpc;
      },
    }),
    rpcErrorCode: (e) => String((e && e.message) || '').split(':')[0].trim(),
    rpcErrorStatus: (e) => {
      const codigo = String((e && e.message) || '').split(':')[0].trim();
      if (codigo === 'REGISTRATION_RATE_LIMITED') return 429;
      if (codigo === 'INVITE_EXHAUSTED' || codigo === 'INVITE_EXPIRED') return 410;
      return 400;
    },
  },
};

const { handler } = require(path.join(raiz, 'netlify', 'functions', 'driver-register.js'));

const ev = (body) => ({ httpMethod: 'POST', body: JSON.stringify(body) });

const CPF = '529.982.247-25';
const CPF_DIG = '52998224725';
const CNPJ = '11.222.333/0001-81';
const CNPJ_DIG = '11222333000181';
const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

const base = {
  tenantId: TENANT,
  name: '  Maria Souza  ',
  phone: '5511999888777',
  email: '  MARIA@Exemplo.COM ',
  cpf: CPF,
};

const ok = (extra = {}) => {
  respostaRpc = {
    data: { driverId: 'd-1', status: 'pending', pinToken: 'pin-segredo', uploadToken: 'upload-segredo', message: 'ok' },
    error: null,
  };
  return handler(ev({ ...base, ...extra }));
};

test.beforeEach(() => {
  lancamentos = [];
  lancarErro = null;
  respostaRpc = { data: null, error: null };
});

// --- CPF: a exigencia que o dono pediu ---------------------------------------

test('CPF ausente e recusado ANTES de chamar a RPC', async () => {
  // O caso obrigatorio e `cpf: undefined`, nao `{}`: o spread de `{}` mantem o
  // cpf de `base`, e o teste passaria a exercitar outro caminho.
  for (const semCpf of [{ cpf: undefined }, { cpf: null }, { cpf: '' }, { cpf: '   ' }, { cpf: '.-/ ()' }, { cpf: 0 }]) {
    lancamentos = [];
    const r = await handler(ev({ ...base, ...semCpf }));
    assert.strictEqual(r.statusCode, 400, `cpf=${JSON.stringify(semCpf.cpf)} deveria ser 400`);
    assert.strictEqual(JSON.parse(r.body).error, 'CPF_REQUIRED');
    assert.strictEqual(lancamentos.length, 0, 'a RPC foi chamada: o aviso antecipado nao economizou nada');
  }
});

test('CPF so com pontuacao e recusado, nao tratado como preenchido', async () => {
  // Sem digito nenhum, String(cpf).replace(/\D+/g,'') fica vazio. Se o teste
  // deixasse passar, a RPC receberia p_cpf vazio e o cadastro entraria sem CPF --
  // que e exatamente o que o dono nao quer.
  lancamentos = [];
  const r = await handler(ev({ ...base, cpf: '...' }));
  assert.strictEqual(JSON.parse(r.body).error, 'CPF_REQUIRED');
  assert.strictEqual(lancamentos.length, 0);
});

test('CPF mascarado vai para a RPC so com digitos', async () => {
  await ok();
  assert.strictEqual(lancamentos.length, 1);
  assert.strictEqual(lancamentos[0].args.p_cpf, CPF_DIG);
});

// --- o contrato de argumentos: onde o bug seria silencioso --------------------

test('a RPC e chamada com o nome e a contagem exatos de argumentos', async () => {
  await ok({ cnpj: CNPJ, legalName: '  Transportes LTDA  ' });

  assert.strictEqual(lancamentos[0].fn, 'driver_register');
  assert.deepEqual(
    Object.keys(lancamentos[0].args).sort(),
    ['p_business_id', 'p_cnpj', 'p_cpf', 'p_email', 'p_invite_code', 'p_legal_name', 'p_name', 'p_phone', 'p_tenant_id'],
    'as chaves drifted da assinatura da RPC: argumento faltando vira DEFAULT NULL silencioso',
  );
  assert.strictEqual(Object.keys(lancamentos[0].args).length, 9);
});

test('nome, email e convite sao normalizados antes de sair', async () => {
  await ok({ inviteCode: '  abcd-1234 ' });
  const a = lancamentos[0].args;
  assert.strictEqual(a.p_name, 'Maria Souza', 'espaco nas pontas no nome vira parte da chave de duplicidade');
  assert.strictEqual(a.p_email, 'maria@exemplo.com');
  assert.strictEqual(a.p_invite_code, 'ABCD-1234', 'o codigo e comparado em maiuscula na RPC');
  assert.strictEqual(a.p_tenant_id, TENANT);
});

test('CPF, CNPJ e razao social sao null quando nao vem nada -- nunca ""', async () => {
  await ok();
  const a = lancamentos[0].args;
  assert.strictEqual(a.p_cnpj, null);
  assert.strictEqual(a.p_legal_name, null);
  assert.strictEqual(a.p_business_id, null);
  assert.strictEqual(a.p_invite_code, null);
});

test('CNPJ e razao social seguem opcionais e vao normalizados quando vem', async () => {
  // O dono deixou o CNPJ opcional de proposito. Este teste existe para travar
  // isso: a tentacao natural de "deixa eu exigir CNPJ tambem" ja passou por
  // este arquivo, e so nao entrou porque ninguem checou o cadastro seguinte.
  await ok({ cnpj: CNPJ, legalName: '  Transportes LTDA  ' });
  const a = lancamentos[0].args;
  assert.strictEqual(a.p_cnpj, CNPJ_DIG);
  assert.strictEqual(a.p_legal_name, 'Transportes LTDA');
});

test('campo em branco vira null, nao string vazia', async () => {
  await ok({ cnpj: '   ', legalName: '   ' });
  const a = lancamentos[0].args;
  assert.strictEqual(a.p_cnpj, null, 'cnpj em branco foi mandado como texto');
  assert.strictEqual(a.p_legal_name, null);
});

// --- validacao de presenca ---------------------------------------------------

test('exige metodo POST', async () => {
  const r = await handler({ httpMethod: 'GET', body: null });
  assert.strictEqual(r.statusCode, 405);
  assert.strictEqual(JSON.parse(r.body).error, 'METHOD_NOT_ALLOWED');
});

test('JSON invalido responde 400, sem chegar na RPC', async () => {
  lancamentos = [];
  const r = await handler({ httpMethod: 'POST', body: '{nao é json' });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(JSON.parse(r.body).error, 'INVALID_JSON');
  assert.strictEqual(lancamentos.length, 0);
});

test('campos obrigatorios faltando sao barrados por codigo', async () => {
  const casos = [
    [{ tenantId: null }, 'TENANT_REQUIRED'],
    [{ name: '   ' }, 'NAME_REQUIRED'],
    [{ phone: null }, 'PHONE_INVALID'],
    [{ email: '' }, 'EMAIL_INVALID'],
  ];
  for (const [override, esperado] of casos) {
    lancamentos = [];
    const r = await handler(ev({ ...base, ...override }));
    assert.strictEqual(r.statusCode, 400, `${JSON.stringify(override)}`);
    assert.strictEqual(JSON.parse(r.body).error, esperado);
    assert.strictEqual(lancamentos.length, 0);
  }
});

// --- traducao do erro da RPC -------------------------------------------------

test('erro da RPC sai em codigo, com o status do codigo', async () => {
  lancamentos = [];
  respostaRpc = { data: null, error: { message: 'CPF_INVALID: digits only' } };
  const r = await handler(ev(base));
  assert.strictEqual(r.statusCode, 400);
  assert.deepEqual(JSON.parse(r.body), { error: 'CPF_INVALID' });
});

test('rate limit e convite esgotado nao viram 400 generico', async () => {
  // Um 429 apresentado como 400 faz o navegador/retry tratarem limite de taxa
  // como erro do cliente e reenviarem mais forte.
  for (const [codigo, status] of [['REGISTRATION_RATE_LIMITED', 429], ['INVITE_EXHAUSTED', 410]]) {
    lancamentos = [];
    respostaRpc = { data: null, error: { message: codigo } };
    const r = await handler(ev(base));
    assert.strictEqual(r.statusCode, status, `${codigo} deveria ser ${status}`);
    assert.strictEqual(JSON.parse(r.body).error, codigo);
  }
});

test('falha inesperada responde 500 sem vazar detalhe interno', async () => {
  lancamentos = [];
  lancarErro = new Error('ECONNREFUSED 10.0.0.5:5432');
  const r = await handler(ev(base));
  assert.strictEqual(r.statusCode, 500);
  assert.deepEqual(JSON.parse(r.body), { error: 'erro interno' });
});

// --- os tokens de posse: a parte que nao pode vazar --------------------------

test('sucesso devolve os dois tokens e nunca os loga', async () => {
  const logs = [];
  const logOriginal = console.log;
  const errOriginal = console.error;
  console.log = (...a) => logs.push(a);
  console.error = (...a) => logs.push(a);
  let r;
  try {
    r = await ok({ cnpj: CNPJ, legalName: 'Transportes LTDA' });
  } finally {
    console.log = logOriginal;
    console.error = errOriginal;
  }

  const corpo = JSON.parse(r.body);
  assert.strictEqual(corpo.pinToken, 'pin-segredo');
  assert.strictEqual(corpo.uploadToken, 'upload-segredo');
  assert.strictEqual(r.headers['Cache-Control'], 'no-store');

  // pinToken e uploadToken sao a unica prova de posse do cadastro: quem os tem
  // Assume a conta. O arquivo diz que nunca entra em log, e e a unica garantia
  // -- nao ha CSP, nao ha proxy: e a disciplina do codigo.
  const tudo = JSON.stringify(logs);
  assert.strictEqual(logs.length, 0, 'o caminho de sucesso nao deveria logar nada');
  assert.ok(!tudo.includes('pin-segredo'), 'token de posse foi para o log');
  assert.ok(!tudo.includes('upload-segredo'), 'token de posse foi para o log');
});

test('o corpo nao devolve cpf nem cnpj crus de volta', async () => {
  const r = await ok({ cnpj: CNPJ, legalName: 'Transportes LTDA' });
  assert.ok(!r.body.includes(CPF_DIG), 'o CPF voltou no corpo: dado pessoal sem motivo');
  assert.ok(!r.body.includes(CNPJ_DIG), 'o CNPJ voltou no corpo');
});