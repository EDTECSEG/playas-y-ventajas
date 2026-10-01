// Regressao: a indicacao ficava pending para sempre quando o resgate acontecia
// SEM um identify anterior.
//
// Dois bugs na mesma regiao, nao um:
//
// 1. ORDEM. try_referral_convert era chamada antes de referral_track. Ela
//    delega para referral_convert, que seleciona a indicacao PENDING do
//    cliente -- e referral_track e que INSERE essa linha. Na ordem antiga, o
//    convert nao tinha nada para converter, devolvia false, e o track criava
//    a indicacao em pending. Nada mais a convertia: identify.js so chama
//    referral_track, nunca try_referral_convert. Quem chegava pelo link sem
//    antes passar por /cliente ficava com a indicacao pendurada sem premio.
//
//    O fluxo normal (identify -> claim) funcionava e escondia o bug, porque
//    o identify ja tinha registrado a indicacao antes do resgate.
//
// 2. ACOPLAMENTO. O bloco de indicacao ficava dentro de `if (ctx)`. Se
//    loadOfferContext falhasse, a indicacao nao era registrada nunca -- sem
//    erro, sem aviso, resgate 200. O contexto do cupom nao tem relacao com o
//    codigo de indicacao.
//
// O teste exige ORDEM, nao so resultado final: afirmar apenas que
// try_referral_convert rodaria depois de referral_track deixaria passar uma
// inversao feita com um Promise.all. E o que interessa nao e so a ordem -- e
// que o track happening antes facade a conversao acontecer na MESMA requisicao,
// sem depender de outra chamada.
//
// Cliente Supabase injetado via stub do modulo: nada de rede nem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const raiz = path.join(__dirname, '..');

let contextoVazio = false;
const chamadas = [];
const RCs = { referral_track: null, try_referral_convert: null };

const adminPath = require.resolve(path.join(raiz, 'netlify', 'functions', '_supabaseAdmin.js'));
require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    getSupabaseAdminClient: () => ({
      rpc: async (nome) => {
        chamadas.push(nome);
        if (nome === 'claim_coupon') {
          return { data: { couponId: 'c1', customerId: 'cli-1', publicId: 'pub-1' }, error: null };
        }
        if (nome === 'billing_record_coupon_tax') return { data: null, error: null };
        if (nome === 'referral_track' || nome === 'try_referral_convert') {
          return { data: true, error: RCs[nome] };
        }
        if (nome === 'customer_notification_enqueue') return { data: null, error: null };
        // Qualquer outra RPC (findReferralCodeOfAffiliate e companhia) responde
        // vazio: aqui so o fluxo de indicacao importa.
        return { data: null, error: null };
      },
      from: () => {
        const q = {
          select: () => q,
          eq: () => q,
          single: async () => (contextoVazio
            ? { data: null, error: { code: 'PGRST116', message: 'nao encontrado' } }
            : {
                data: {
                  template: { title: '10% OFF', id: 't1' },
                  business: { name: 'Edtec Seg Lagos', phone: '5511999999999', id: 'b1' },
                },
                error: null,
              }),
          maybeSingle: async () => ({ data: null, error: null }),
          limit: () => q,
        };
        return q;
      },
    }),
    // claim-coupon usa o token HMAC do cliente na resposta. Sem isto o handler
    // cai no catch e devolve 500, e o teste mediria o stub e nao o fluxo.
    buildCustomerToken: (id) => 'tok-' + id,
  },
};

const { handler } = require(path.join(raiz, 'netlify', 'functions', 'claim-coupon.js'));

const post = (corpo) => handler({ httpMethod: 'POST', body: JSON.stringify(corpo) }, {});

const COM_REF = {
  tenantId: '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9',
  templateId: 't1',
  phone: '5511998888777',
  name: 'Uenderson santos',
  ref: 'JOSDASCOUVE-EB29',
};

function preparar() {
  chamadas.length = 0;
  contextoVazio = false;
  RCs.referral_track = null;
  RCs.try_referral_convert = null;
}

test('resgate com codigo registra a indicacao antes de tentar converter', async () => {
  preparar();
  const r = await post(COM_REF);
  assert.equal(r.statusCode, 200);

  const iTrack = chamadas.indexOf('referral_track');
  const iConvert = chamadas.indexOf('try_referral_convert');
  assert.ok(iTrack >= 0, 'a indicacao precisa ser registrada');
  assert.ok(iConvert >= 0, 'a conversao precisa ser tentada');
  // A linha que define o bug. Sem isto, o teste passa mesmo com a ordem
  // invertida, que e exatamente como estava.
  assert.ok(iTrack < iConvert, 'referral_track tem que vir ANTES de try_referral_convert');
});

test('quem resgata sem identify converte na mesma requisicao', async () => {
  preparar();
  const r = await post(COM_REF);
  const j = JSON.parse(r.body);
  // Este e o sintoma que o usuario via: converted:false com uma indicacao
  // recem-criada em pending.
  assert.equal(j.referral.converted, true);
});

test('sem codigo: nao registra indicacao nova, mas ainda tenta converter a que ja existe', async () => {
  preparar();
  const r = await post({ ...COM_REF, ref: undefined });
  assert.equal(r.statusCode, 200);
  // referral_track so com codigo: sem ele nao ha indicacao nova a criar.
  assert.ok(!chamadas.includes('referral_track'));
  // try_referral_convert SEMPRE, com codigo ou nao. Quem foi indicado num
  // identify anterior chega ao resgate sem ?ref= nesta requisicao, e este
  // e o unico momento em que a indicacao dele e convertida. Condicionar
  // esta chamada ao codigo quebraria o fluxo normal -- e foi um erro
  // plausivel de introduzir justamente ao corrigir a ordem.
  assert.ok(chamadas.includes('try_referral_convert'));
});

test('contexto do cupom falhando NAO impede de registrar a indicacao', async () => {
  preparar();
  contextoVazio = true; // loadOfferContext devolve erro -> ctx = null
  const r = await post(COM_REF);
  assert.equal(r.statusCode, 200, 'o resgate nao pode quebrar por causa de indicacao');
  assert.ok(
    chamadas.includes('referral_track'),
    'a indicacao estava acoplada ao `if (ctx)` e sumia sem erro quando o contexto falhava'
  );
});

test('falha no track nao quebra o resgate, e a conversao ainda e tentada', async () => {
  preparar();
  RCs.referral_track = { code: 'XX000', message: 'boom' };
  const r = await post(COM_REF);
  assert.equal(r.statusCode, 200);
  assert.ok(chamadas.includes('try_referral_convert'));
});

test('falha na conversao nao quebra o resgate', async () => {
  preparar();
  RCs.try_referral_convert = { code: 'XX000', message: 'boom' };
  const r = await post(COM_REF);
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).referral, null);
});

test('o resgate acontece antes de qualquer coisa de indicacao', async () => {
  preparar();
  await post(COM_REF);
  const iClaim = chamadas.indexOf('claim_coupon');
  assert.ok(iClaim >= 0);
  assert.ok(iClaim < chamadas.indexOf('referral_track'));
});

test('o booleano da conversao nao sombrea mais o codigo de indicacao', () => {
  const src = require('node:fs').readFileSync(path.join(raiz, 'netlify', 'functions', 'claim-coupon.js'), 'utf8');
  // Antes o resultado da conversao se chamava `ref`, o mesmo nome do codigo
  // que vem no request, dentro do mesmo escopo. Funcionava por acaso e era
  // o convite mais obvio para editar a variavel errada.
  assert.ok(
    !/const \{ data: ref, error: refErr \} = await supabase\.rpc\('try_referral_convert'/.test(src),
    'o booleano da conversao nao pode se chamar ref'
  );
  assert.match(src, /const \{ data: converted, error: refErr \} = await supabase\.rpc\('try_referral_convert'/);
});

test('o bloco de indicacao nao esta dentro do if (ctx)', () => {
  const src = require('node:fs').readFileSync(path.join(raiz, 'netlify', 'functions', 'claim-coupon.js'), 'utf8');
  // Compara a POSICAO no arquivo, nao a presenca da string: o comentario que
  // explica o bug menciona "`if (ctx)`" entre crases, e um teste de substring
  // casaria com a propria explicacao em vez do codigo. Por isso a ancora de
  // linha com indentacao, que so o statement real satisfaz.
  const iTrack = src.indexOf("await supabase.rpc('referral_track'");
  const iCtx = src.search(/^\s{4}if \(ctx\) \{$/m);
  assert.ok(iCtx >= 0, 'nao achei o if (ctx) do bloco de contexto');
  assert.ok(
    iTrack < iCtx,
    'registrar indicacao nao pode depender do contexto do cupom ter carregado'
  );
});