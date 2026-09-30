'use strict';

// /cliente: guarda do WhatsApp de um cupom que ja esta na lista "Meus cupons".
//
// Pedido do dono (setembro/2026): o mesmo mecanismo da mensagem de cupom
// tambem no fim da tela de resgates, ou seja, valendo tambem para os cupons
// com status VALIDATED.
//
// Nao da para renderizar JSX neste runner, entao o padrao e travar o
// codigo-fonte, como em cliente-shuttle-reservation-guard.test.cjs.
//
// Dois erros que estas guardas evitam:
//   1. botao sem telefone: buildWaLink sem numero cai no
//      https://wa.me/?text=..., que abre o "compartilhar" do proprio celular
//      do cliente em vez de conversationar com o estabelecimento.
//   2. texto errado por status: mandar "quero usar meu cupom" em um cupom ja
//      resgatado faz o caixa recusar com COUPON_ALREADY_USED. O cliente ficaria
//      achando que o cupom dele estava valendo.

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

const helper = bloco('function couponContactMessage', 'function timeAgo');
const detalhe = bloco('{openCoupon && (', '{msg && <p');

test('a mensagem de contato do cupom existe e se identifica antes de qualquer coisa', () => {
  assert.ok(src.includes('function couponContactMessage'), 'falta couponContactMessage');
  assert.ok(helper.includes("'*Playas y Ventajas*'"), 'a mensagem precisa abrir com a marca');
  assert.ok(helper.includes("'*Cupom:* '"), 'a mensagem precisa dizer qual cupom e');
  assert.ok(helper.includes("'*Estabelecimento:* '"), 'a mensagem precisa dizer o estabelecimento');
  assert.ok(helper.includes("'*Codigo:* '"), 'a mensagem precisa trazer o codigo do cupom');
});

test('em cupom resgatado a mensagem assume que o cupom JA foi usado', () => {
  // O texto de cupom disponivel vai no sentido contrario (cliente -> balcao,
  // "quero aplicar"). Para o VALIDATED ela so se apresenta e identifica o
  // cupom, com a data do resgate.
  assert.ok(/c\.status === 'VALIDATED'/.test(helper), 'a mensagem precisa bifurcar por status');
  assert.ok(helper.includes('ja resgatado'), 'o VALIDATED precisa aparecer como ja resgatado');
  assert.ok(/validatedAt/.test(helper), 'o VALIDATED precisa trazer a data do resgate');
  const ramalValidado = helper.slice(
    helper.indexOf("c.status === 'VALIDATED'"),
    helper.indexOf('} else {'),
  );
  assert.ok(!/Site/.test(ramalValidado), 'cupom resgatado nao deve mandar o cliente para o site como se fosse usar');
  assert.ok(ramalValidado.includes('resgatado'), 'o ramo VALIDATED precisa dizer que ja foi resgatado');
});

test('o botao de WhatsApp usa o telefone que veio do banco', () => {
  // O telefone nunca pode ser digitado no navegador: o destino do link vem do
  // businessPhone devolvido pela RPC list_customer_coupons.
  assert.ok(
    /buildWaLink\(\{\s*\n?\s*phone: openCoupon\.businessPhone/.test(src),
    'o botao precisa usar openCoupon.businessPhone',
  );
  assert.ok(
    /message: couponContactMessage\(openCoupon, window\.location\.origin\)/.test(src),
    'o botao precisa montar a mensagem com couponContactMessage',
  );
});

test('sem telefone valido o botao nem aparece', () => {
  // Sem esta guarda o wa.me abre a folha de compartilhar do proprio celular.
  assert.ok(
    /String\(openCoupon\.businessPhone \|\| ''\)\.replace\(\/\\D\/g, ''\)\.length >= 10/.test(src),
    'o botao precisa exigir 10+ digitos de telefone antes de renderizar',
  );
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

test('a RPC que alimenta a lista precisa devolver o telefone e a data do resgate', () => {
  // Sem businessPhone na RPC o botao nunca tem destino; sem validatedAt a data
  // do resgate nao aparece. A definicao foi versionada em
  // supabase/coupon-management.sql (a RPC vivia so no banco).
  const sql = readFileSync(path.join(__dirname, '..', 'supabase', 'coupon-management.sql'), 'utf8');
  const ini = sql.indexOf('create or replace function public.list_customer_coupons');
  assert.ok(ini !== -1, 'a definicao de list_customer_coupons precisa estar versionada em coupon-management.sql');
  const rpc = sql.slice(ini, ini + 1200);
  assert.ok(rpc.includes("'businessPhone', b.phone"), 'a RPC precisa devolver businessPhone');
  assert.ok(rpc.includes("'validatedAt', co.validated_at"), 'a RPC precisa devolver validatedAt');
  assert.ok(/search_path = public, extensions/.test(rpc), 'a RPC precisa manter o search_path fixo');
});
