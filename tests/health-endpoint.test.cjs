// Regressao e contrato do /.netlify/functions/health.
//
// O sintoma que este endpoint existe para resolver: hoje um erro em producao
// so aparece quando um cliente reclama. O worker loga no tail, que e privado e
// exige abrir o dashboard do Cloudflare, e nao ha alerta nenhum. Um 500 chega
// para o usuario como "erro interno" e para ninguem mais.
//
// O risco especifico deste handler e o oposto de um health check comum: ele e
// PUBLICO de proposito (para servir a uptime monitor externo e para quem esta
// com o navegador travado), entao qualquer erro que vaze valor de variavel de
// ambiente se transforma em incidente de segredo exposto. Da mesma forma, um
// 200 onde tudo esta quebrado e pior que nenhum endpoint -- e o que faz
// alguem desligar o alerta depois de dois falsos positivos.
//
// Estes testes injetam o cliente Supabase via stub do modulo, entao nao tocam
// a rede nem o banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const raiz = path.join(__dirname, '..');

let respostaRpc = { data: null, error: null };
let falhaAoCriarCliente = null;

const adminPath = require.resolve(path.join(raiz, 'netlify', 'functions', '_supabaseAdmin.js'));
require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    getSupabaseAdminClient: () => {
      if (falhaAoCriarCliente) throw new Error(falhaAoCriarCliente);
      return { rpc: async () => respostaRpc };
    },
  },
};

const { handler } = require(path.join(raiz, 'netlify', 'functions', 'health.js'));

// Valores deliberadamente distintivos: se algum deles aparecer na resposta, o
// teste de vazamento pega pelo nome e nao por acaso.
const SEGREDOS = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://exemplo.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-NAO-VAZAR-123',
  RESEND_API_KEY: 're_send-NAO-VAZAR-456',
  GEOAPIFY_API_KEY: 'geo-NAO-VAZAR-789',
  MP_ACCESS_TOKEN: 'APP_USR-mp-NAO-VAZAR-012',
  MP_WEBHOOK_SECRET: 'hmac-NAO-VAZAR-345',
  MP_NOTIFICATION_URL: 'https://exemplo.pages.dev/retorno',
};

const TODAS = Object.keys(SEGREDOS);
const get = () => handler({ httpMethod: 'GET' }, {});

function limpar() {
  respostaRpc = { data: null, error: null };
  falhaAoCriarCliente = null;
  for (const nome of TODAS) delete process.env[nome];
  for (const nome of TODAS) process.env[nome] = SEGREDOS[nome];
}

test('a rota que o worker aceita de fato alcanca o handler health', () => {
  const src = require('node:fs').readFileSync(path.join(raiz, 'worker', 'main.js'), 'utf8');
  const linha = src.split('\n').find((l) => l.includes('path.match(') && l.includes('netlify'));
  assert.ok(linha, 'nao achei a linha que extrai o nome da rota');
  // Este teste existe porque a rota nao e /api/<nome>. O padrao real e
  // /.netlify/functions/<nome>, e nao ha rewrite em next.config.js: escrever
  // /api/health no relatorio e no comentario faria o endpoint responder 404
  // com a SPA, que e exatamente o modo de falha que um health check nao pode
  // ter -- o monitor ficaria verde sobre uma pagina que nao existe.
  //
  // O literal termina em "$/" (ancorado), nao em "/", por isso o fim do padrao
  // e procurado como "$\/".
  const re = linha.match(/path\.match\((\/.*\$\/)\)/);
  assert.ok(re, 'nao consegui extrair a regex da rota: ' + linha.trim());
  const padrao = new RegExp(re[1].slice(1, -1));
  const m = '/.netlify/functions/health'.match(padrao);
  assert.ok(m, 'a URL real do health nao casa com a rota do worker');
  assert.equal(m[1], 'health', 'o nome capturado tem que ser o que esta no ROUTES');
});

test('rota health esta registrada no worker', () => {
  const src = require('node:fs').readFileSync(path.join(raiz, 'worker', 'main.js'), 'utf8');
  assert.match(src, /import health from '\.\.\/netlify\/functions\/health\.js'/);
  // Sem isto no ROUTES, o handler existe mas a rota devolve 404 e o
  // monitor fica verde sobre um endpoint inexistente.
  const bloco = src.slice(src.indexOf('const ROUTES'), src.indexOf('const CORS_HEADERS'));
  assert.match(bloco, /^\s*health,$/m, 'health precisa estar no ROUTES');
});

test('tudo presente e RPC respondendo devolve 200', async () => {
  limpar();
  const r = await get();
  assert.equal(r.statusCode, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.status, 'ok');
  assert.deepEqual(j.quebradas, []);
});

test('supabase ausente devolve 503 e nomeia a integracao', async () => {
  limpar();
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const r = await get();
  assert.equal(r.statusCode, 503);
  const j = JSON.parse(r.body);
  assert.ok(j.quebradas.includes('supabase'), 'a resposta tem que dizer O QUE caiu');
  assert.equal(j.status, 'degradado');
});

test('falha de rede no supabase vira 503, nao 200', async () => {
  limpar();
  respostaRpc = { data: null, error: { code: 'PGRST116', message: 'conexao recusada' } };
  const r = await get();
  assert.equal(r.statusCode, 503);
  const j = JSON.parse(r.body);
  const sb = j.integracoes.find((i) => i.nome === 'supabase');
  assert.equal(sb.status, 'erro');
});

test('cliente admin que nem instancia vira erro, nao 500 cru', async () => {
  limpar();
  falhaAoCriarCliente = 'Env vars ausentes';
  const r = await get();
  assert.equal(r.statusCode, 503);
  const j = JSON.parse(r.body);
  assert.equal(j.integracoes.find((i) => i.nome === 'supabase').status, 'erro');
});

test('uma quebra no supabase nao impede o diagnostico das outras', async () => {
  limpar();
  delete process.env.RESEND_API_KEY;
  respostaRpc = { data: null, error: { code: 'X', message: 'fora' } };
  const r = await get();
  const j = JSON.parse(r.body);
  // Este e o ponto do loop por integracao: se o primeiro check lancasse, o
  // health diria "degradado" sem dizer o que mais caiu, e o operador
  // teria de adivinhar.
  assert.ok(j.integracoes.some((i) => i.nome === 'resend' && i.status === 'ausente'));
  assert.ok(j.integracoes.some((i) => i.nome === 'geoapify' && i.status === 'ok'));
});

test('variaveis do Mercado Pago faltando nao derrubam o site inteiro', async () => {
  limpar();
  for (const nome of ['MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'MP_NOTIFICATION_URL']) delete process.env[nome];
  const r = await get();
  // A assinatura e opcional para o restante do site: quem nao usa
  // assinatura mensal nao pode ver o site fora do ar por causa dela. Por
  // isso o token entra como nao-opcional e o resto como opcional.
  assert.equal(r.statusCode, 503);
  const j = JSON.parse(r.body);
  assert.ok(j.quebradas.includes('mercadopago'));
  assert.ok(!j.quebradas.includes('mercadopago_webhook'));
});

test('so o token do Mercado Pago faltando ainda sinaliza', async () => {
  limpar();
  delete process.env.MP_ACCESS_TOKEN;
  const r = await get();
  const j = JSON.parse(r.body);
  assert.ok(j.quebradas.includes('mercadopago'), 'assinatura inoperante precisa aparecer');
  assert.ok(!j.quebradas.includes('mercadopago_notify_url'), 'a URL de retorno e opcional');
});

test('a resposta nunca carrega valor de variavel de ambiente', async () => {
  limpar();
  respostaRpc = { data: null, error: { code: 'X', message: 'conexao recusada' } };
  const r = await get();
  for (const [nome, valor] of Object.entries(SEGREDOS)) {
    assert.ok(!r.body.includes(valor), `vazou o valor de ${nome}`);
  }
  // Nem por referencia parcial: o nome pode aparecer, o valor nao.
  assert.ok(!r.body.includes('NAO-VAZAR'));
});

test('a resposta lista o NOME da variavel faltando, para o operador saber o que cadastrar', async () => {
  limpar();
  delete process.env.RESEND_API_KEY;
  const r = await get();
  const j = JSON.parse(r.body);
  const resend = j.integracoes.find((i) => i.nome === 'resend');
  assert.deepEqual(resend.variaveis, ['RESEND_API_KEY']);
});

test('apenas GET e aceito', async () => {
  limpar();
  for (const metodo of ['POST', 'PUT', 'DELETE']) {
    const r = await handler({ httpMethod: metodo }, {});
    assert.equal(r.statusCode, 405, metodo + ' nao deveria passar');
  }
});

test('variavel em branco conta como ausente', async () => {
  limpar();
  // Espaco e o caso classico de "configurei mas o valor nao foi": o
  // ProcessInfo do painel mostra a variavel como cadastrada e o codigo
  // acha que tem credencial. Por isso o .trim().
  process.env.RESEND_API_KEY = '   ';
  const r = await get();
  const j = JSON.parse(r.body);
  assert.equal(j.integracoes.find((i) => i.nome === 'resend').status, 'ausente');
});