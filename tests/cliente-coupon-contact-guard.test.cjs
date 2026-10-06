'use strict';

// /cliente: guarda do botao de envio de cupom por WhatsApp em "Meus cupons".
//
// HISTORICO DESTE ARQUIVO (importante para nao "restaurar" o comportamento
// antigo sem querer): ele nasceu em setembro/2026 guardando o WhatsApp DIRETO
// com o estabelecimento -- buildWaLink com businessPhone, mensagem "quero usar
// meu cupom", e o botao escondido quando a empresa nao tinha telefone.
//
// Em outubro/2026 o dono trocou o sentido do botao: o cupom nao e mais uma
// conversa com o balcao, e uma DIVULGACAO. O cupom de resgate e individual e
// de uso unico (ver coupon-public-id), entao o codigo do proprio cliente so
// nao serve para o outro usar -- o que vale e levar o LINK DE INDICACAO, que
// da ao outro um cupom novo.
//
// Em 2026-10-06 o dono mandou o codigo (PYV-...) ser enviado JUNTO no
// WhatsApp: "no envio do cupom pelo whatsapp o codigo pyv-... e pra ser
// enviado junto". O link de indicacao continua sendo a forma de quem recebe
// resgatar o cupom dele proprio; o codigo acompanha a oferta no texto.
//
// As guardas abaixo existem para travar essa distincao. Sao exatamente as
// tres coisas que um "ajuste estetico" quebraria em silencio:
//
//   1. O link vai ser o de indicacao (invite.shareUrl), nao o codigo publico.
//   2. O codigo publico (PYV-...) ENTRA no texto, junto da oferta e do link
//      (decisao do dono, 2026-10-06).
//   3. O destino e a folha de compartilhar do WhatsApp (wa.me sem numero), e
//      nao uma conversa com a loja.
//
// Nao da para renderizar JSX neste runner, entao o padrao e travar o
// codigo-fonte, como em cliente-shuttle-reservation-guard.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'app', 'cliente', 'page.jsx');
const src = readFileSync(PAGE, 'utf8');

function bloco(inicio, fim) {
  const a = src.indexOf(inicio);
  assert.ok(a !== -1, `nao encontrei ${inicio} na pagina`);
  const b = src.indexOf(fim, a + 1);
  assert.ok(b !== -1, `nao encontrei ${fim} depois de ${inicio}`);
  return src.slice(a, b);
}

const mensagem = bloco('function couponShareMessage', 'function timeAgo');
const compartilhar = bloco('async function shareCouponOnWhatsApp', 'async function copyInviteLink');
const detalhe = bloco('{openCoupon && (', '{msg && <p');

test('a mensagem de compartilhamento se identifica antes de qualquer coisa', () => {
  assert.ok(mensagem.includes("'*Playas y Ventajas*'"), 'a mensagem precisa abrir com a marca');
  assert.ok(mensagem.includes("'*Cupom:* '"), 'a mensagem precisa dizer qual cupom e');
  assert.ok(mensagem.includes("'*Estabelecimento:* '"), 'a mensagem precisa dizer o estabelecimento');
});

test('a mensagem manda o LINK de indicacao, e nao um cupom pronto', () => {
  // O link vem do invite do cliente que esta compartilhando. E ele -- e nao o
  // codigo publico -- que gera um cupom novo para quem recebe.
  assert.ok(mensagem.includes('referralUrl'), 'a mensagem precisa empilhar o link de indicacao');
  assert.ok(mensagem.includes('t?.couponShareLead'), 'a mensagem precisa explicar que o outro resgata o cupom dele');
  assert.ok(
    /if \(!referralUrl && origin\) linhas\.push\(origin\)/.test(mensagem),
    'sem invite o texto ainda precisa cair na origem, e nao numa string vazia',
  );
});

test('o codigo publico (PYV-...) vai na mensagem compartilhada', () => {
  // Decisao do dono (2026-10-06): "no envio do cupom pelo whatsapp o codigo
  // pyv-... e pra ser enviado junto". O codigo e do cupom de quem ENVIA e nao
  // substitui o link de indicacao -- o texto precisa carrega-lo junto.
  assert.ok(mensagem.includes('c.publicId'), 'a mensagem precisa citar o publicId do cupom');
  assert.ok(
    /if \(c\.publicId\) linhas\.push\('\*Codigo:\* ' \+ c\.publicId\)/.test(mensagem),
    'o codigo precisa entrar como "*Codigo:* PYV-..." quando o cupom tem publicId',
  );
  assert.ok(
    !/buildCouponMessage/.test(mensagem),
    'o texto nao pode vir de buildCouponMessage, que manda "quero usar meu cupom" para o balcao',
  );
});

test('o destino e a folha de compartilhar do WhatsApp, sem numero', () => {
  // Sem telefone, wa.me cai em https://wa.me/?text=... e o WhatsApp oferece a
  // lista de contatos do proprio cliente. E isso que o dono pediu: ele escolhe
  // para quem mandar.
  assert.ok(
    /buildWaLink\(\{\s*\n?\s*message: couponShareMessage/.test(src),
    'o envio precisa montar a mensagem e passar para buildWaLink',
  );
  const semTelefone = compartilhar.slice(
    compartilhar.indexOf('buildWaLink({'),
    compartilhar.indexOf('});', compartilhar.indexOf('buildWaLink({')),
  );
  assert.ok(
    !/phone:/.test(semTelefone),
    'o envio nao pode ter phone: o numero da loja traria de volta a conversa com o balcao',
  );
});

test('a aba do WhatsApp e aberta ANTES de qualquer await', () => {
  // Sao dois awaits antes de mountar a URL (ensureInvite e a propria leitura do
  // invite). Chrome e Safari bloqueiam pop-up aberto fora do gesto
  // do usuario; a aba em branco aberta no primeiro synchronous resolve isso,
  // e so e fechada no caminho de erro -- assim nunca sobra aba em branco.
  const abre = compartilhar.indexOf("window.open('about:blank'");
  const espera = compartilhar.indexOf('await');
  assert.ok(abre !== -1, 'o envio precisa abrir about:blank no click');
  assert.ok(espera !== -1, 'o envio precisa ter um await (garantia de que o teste faz sentido)');
  assert.ok(abre < espera, 'about:blank precisa ser aberto antes do primeiro await, ou o pop-up e bloqueado');
  assert.ok(/win\.close\(\)/.test(compartilhar), 'o caminho de erro precisa fechar a aba vazia');
});

test('o botao aparece mesmo sem telefone da empresa cadastrado', () => {
  // A regra antiga era o contrario: sem 10+ digitos de telefone o botao nem
  // renderizava, para nao abrir o "compartilhar" do proprio celular. Isso
  // agora e o comportamento desejado -- e o botao que mais importa e o da
  // empresa que ainda nao cadasturou telefone.
  assert.ok(
    !/openCoupon\.businessPhone \|\| ''\)\.replace\(\/\\D\/g, ''\)\.length >= 10/.test(src),
    'o botao nao pode mais exigir telefone da loja para aparecer',
  );
  assert.ok(
    detalhe.includes('shareCouponOnWhatsApp(openCoupon)'),
    'o detalhe do cupom precisa chamar shareCouponOnWhatsApp',
  );
  assert.ok(
    detalhe.includes('t.couponSendWhatsapp'),
    'falta o rotulo couponSendWhatsapp',
  );
  assert.ok(
    detalhe.includes('sharingCoupon === openCoupon.publicId'),
    'o botao precisa travar enquanto o envio esta sendo preparado',
  );
});

test('o caminho antigo de falar com o balcao sumiu do detalhe do cupom', () => {
  // couponContactMessage falava com o estabelecimento. Se voltar a ser usada em
  // algum lugar do modal, o dono volta a receber "quero usar meu cupom" de
  // clientes que estao so divulgando.
  assert.ok(!/couponContactMessage/.test(src), 'couponContactMessage nao deve mais existir na pagina');
  assert.ok(
    !/phone: openCoupon\.businessPhone/.test(src),
    'nada no detalhe deve mais montar wa.me com o telefone da loja',
  );
});

test('o texto e as traducoes existem nos tres idiomas', () => {
  const i18n = readFileSync(path.join(__dirname, '..', 'lib', 'i18n.js'), 'utf8');
  // A busca e pela DEFINICAO da chave (`chave:`), e nao pelo nome: o arquivo
  // explica em comentario por que ela saiu, e esse comentario tem de poder
  // citar o nome antigo.
  assert.ok(!/couponContactWhatsapp\s*:/.test(i18n), 'a chave antiga couponContactWhatsapp deve ter sido removida');
  for (const chave of ['couponSendWhatsapp', 'couponSharePreparing', 'couponShareHint', 'couponShareFailed', 'couponShareLead', 'couponShareCode', 'businessContactLabel']) {
    const ocorrencias = i18n.split(`${chave}:`).length - 1;
    assert.strictEqual(ocorrencias, 3, `${chave} precisa existir em pt, en e es (achei ${ocorrencias})`);
  }
});

test('a lista de cupons traz a data do resgate quando ela existe', () => {
  // Sem a data, o cliente que filtra por "Resgatados" ve so um selo verde sem
  // saber quando usou.
  assert.ok(
    /openCoupon\.status === 'VALIDATED' && openCoupon\.validatedAt/.test(detalhe),
    'o detalhe precisa mostrar a data do resgate no cupom VALIDATED',
  );
  assert.ok(detalhe.includes('t.couponRedeemedOn'), 'falta o rotulo couponRedeemedOn');
  assert.ok(detalhe.includes('formatWhen(openCoupon.validatedAt)'), 'falta formatar a data');
});

test('a tela do cliente nao mostra mais o codigo curto', () => {
  // O codigo curto foi retirado (decisao do dono): o balcao nao tem campo para
  // digitar e o codigo longo sozinho ja autoriza. Ver netlify/functions/_wa.js.
  assert.ok(
    !/shortCode/.test(src),
    'voltou o codigo curto na tela do cliente: ninguem no balcao consegue usar esse numero',
  );
});

test('o backend ainda aceita o par codigo + curto de material antigo', () => {
  // Tirar o numero do texto NAO pode invalidar quem ja tem print/link salvo.
  // A assercao olha SO o corpo da funcao: o arquivo tem comentarios explicando
  // a remocao, e eles citem "Codigo curto" de proposito.
  const wa = readFileSync(path.join(__dirname, '..', 'netlify', 'functions', '_wa.js'), 'utf8');
  const ini = wa.indexOf('function buildCouponMessage');
  assert.ok(ini !== -1, 'falta buildCouponMessage em _wa.js');
  const corpo = wa.slice(ini, wa.indexOf('function buildWaLink', ini));
  assert.ok(
    !corpo.includes('shortCode') && !corpo.includes('Codigo curto'),
    'a mensagem nao deve mais citar o codigo curto',
  );
  const validate = readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'validate-coupon.js'), 'utf8');
  assert.ok(
    /shortCode/.test(validate),
    'validate-coupon precisa continuar repassando shortCode para o backend aceitar material antigo',
  );
});

test('a ficha da empresa vem do banco, e nao do armazenamento local do navegador', () => {
  // businessId/businessLogoUrl/businessWebsite/businessInstagram chegam em
  // list_customer_coupons (ver p9-contato-publico-empresa.sql). Sem isso, o
  // contato sob o QR so apareceria na mesma sessao em que o cupom foi
  // resgatado -- e sumiria ao recarregar a pagina.
  const sql = readFileSync(path.join(__dirname, '..', 'supabase', 'p9-contato-publico-empresa.sql'), 'utf8');
  const ini = sql.indexOf('create or replace function public.list_customer_coupons');
  assert.ok(ini !== -1, 'a p9 precisa redefinir list_customer_coupons');
  const rpc = sql.slice(ini, ini + 2400);
  for (const campo of ['businessId', 'businessLogoUrl', 'businessPhone', 'businessWebsite', 'businessInstagram', 'validatedAt']) {
    assert.ok(rpc.includes(`'${campo}'`), `a RPC precisa devolver ${campo}`);
  }
  assert.ok(/search_path to public, extensions/.test(rpc), 'a RPC precisa manter o search_path fixo');
});

test('a lista ainda mostra a data do resgate, e ela vem da RPC versionada', () => {
  // A definicao antiga esta em supabase/coupon-management.sql (a RPC vivia so no
  // banco); a p9 adiciona os campos de contato em cima dela.
  const sql = readFileSync(path.join(__dirname, '..', 'supabase', 'coupon-management.sql'), 'utf8');
  const ini = sql.indexOf('create or replace function public.list_customer_coupons');
  assert.ok(ini !== -1, 'a definicao de list_customer_coupons precisa estar versionada em coupon-management.sql');
  const rpc = sql.slice(ini, ini + 1200);
  assert.ok(rpc.includes("'businessPhone', b.phone"), 'a RPC precisa devolver businessPhone');
  assert.ok(rpc.includes("'validatedAt', co.validated_at"), 'a RPC precisa devolver validatedAt');
});