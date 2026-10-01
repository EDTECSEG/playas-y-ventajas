'use strict';

// Vinculo cliente <-> afiliado: guarda do caminho que decide se o premio da
// indicacao existe.
//
// CONTEXTO (verificado em producao, 2026-10-01)
// ----------------------------------------------------
// Um afiliado de teste (JOSDASCOUVE-EB29) recebeu uma indicacao real. O
// cliente entrou pelo link, resgatou o cupom e a empresa validou no caixa:
//
//   referrals.status       = 'converted'
//   referrals.converted_at = preenchida
//   coupons.status         = 'VALIDATED'
//
// O caminho inteiro funcionou. E mesmo assim:
//
//   referrals.reward_coupon_id = NULL
//
// O afiliado ganhou uma indicacao e zero recompensa. Duas causas
// empilhadas, e a segunda e a que estas guardas existem para travar:
//
//   1) affiliate_rewards.affiliate_reward_template_id IS NULL -- configuracao.
//      Se resolve pela tela do admin.
//
//   2) affiliates.customer_id IS NULL -- e NINGUEM ESCREVE ESSA COLUNA.
//      affiliate_register (modulo3-afiliados.sql:209) faz INSERT de
//      tenant_id, name, phone, email, kind e referral_code; customer_id fica
//      de fora. E referral_convert (linha 353) le exatamente esse campo para
//      creditar o premio:
//
//          p_customer_id := (select customer_id from affiliates where ...)
//
//      e grant_coupon_internal (linha 404) responde:
//
//          if p_customer_id is null then return null;
//
//      Portanto, mesmo COM o template configurado, o premio seria NULL para
//      qualquer afiliado do sistema. Nao e caso do afiliado de teste: e uma
//      coluna que nunca foi preenchida por ninguem.
//
// A correção (supabase/affiliate-link-customer.sql) é aditiva, no mesmo
// espirito do modulo3b: nao reescreve identify_customer nem users, que sao do
// base schema e NAO estao neste repositorio. Acrescenta funcoes ao lado e o
// endpoint chama best-effort.
//
// Nao da para rodar SQL neste runner, entao o padrao e travar o codigo-fonte,
// como nos demais guards. O que fica travado sao as condicoes que, se
// regredirem, trazem de volta o premio-fantasma: indicacao convertida sem
// cupom, sem motivo visivel.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sql = readFileSync(path.join(root, 'supabase', 'affiliate-link-customer.sql'), 'utf8');
const identify = readFileSync(path.join(root, 'netlify', 'functions', 'identify.js'), 'utf8');
const modulo3 = readFileSync(path.join(root, 'supabase', 'modulo3-afiliados.sql'), 'utf8');

// Recorta uma funcao/trigger do arquivo novo, para o teste nao casar com o
// comentario de outra secao que menciona o mesmo nome.
//
// O terminador no SQL dos modulos e "$function$" seguido de ";" na LINHA
// seguinte, e nao "$function$;" colado. Buscar pela forma colada devolvia -1 e
// o body saia vazio, fazendo todo assert.match falhar sem dizer por quê.
function bodyOf(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
  assert.ok(start >= 0, 'funcao ' + name + ' nao encontrada em affiliate-link-customer.sql');
  const fim = sql.indexOf('$function$', sql.indexOf('AS $function$', start) + 13);
  assert.ok(fim > start, 'corpo de ' + name + ' nao fechado');
  return sql.slice(start, fim);
}

// ---------------------------------------------------------------------------
// 1) O vinculo existe e preenche a coluna que nunca era preenchida
// ---------------------------------------------------------------------------

test('link_affiliate_customer preenche affiliates.customer_id pelo telefone', () => {
  const body = bodyOf('link_affiliate_customer');

  // O UPDATE tem de casar por digitos: o telefone vem do navegador como a
  // pessoa digitou ("22 99202-1576") e affiliates.phone_digits e coluna
  // gerada. Sem normalizar dos dois lados o vinculo nunca acha.
  assert.match(body, /regexp_replace\(coalesce\(u\.phone, ''\), '\\D', '', 'g'\)/,
    'a busca do telefone no users precisa normalizar por digitos');
  assert.match(body, /a\.phone_digits\s*=\s*v_digitos/,
    'o UPDATE tem que casar com affiliates.phone_digits');

  // customer_id is null no WHERE: quem ja estava ligado nao pode ser
  // trocado por uma segunda chamada com o mesmo telefone.
  assert.match(body, /a\.customer_id is null/,
    'o WHERE precisa de customer_id is null para nao sobrescrever vinculo existente');
});

test('link_affiliate_customer nunca propaga erro', () => {
  const body = bodyOf('link_affiliate_customer');
  // O cadastro do cliente ja aconteceu antes desta chamada. Se a RPC
  // levantar excecao, o identify.js respondia 500 para um cadastro que
  // deu certo.
  assert.match(body, /when others then[\s\S]*?return false/,
    'a RPC precisa engolir excecao e devolver false');
});

// ---------------------------------------------------------------------------
// 2) O trigger do caminho inverso
// ---------------------------------------------------------------------------

test('o trigger liga pelo affiliate_id, nao pelo indicado', () => {
  const body = bodyOf('trg_referral_reward_link');

  // Esta e a guarda que impede um erro real de identidade. Uma versao
  // anterior passava new.referred_user_id (a pessoa INDICADA) para a
  // funcao de link; isso amarraria o indicado ao afiliado errado sempre
  // que o telefone dele casasse com o de outro afiliado.
  assert.match(body, /link_affiliate_by_id\(new\.tenant_id, new\.affiliate_id\)/,
    'o trigger tem que linkar pelo affiliate_id da propria linha');
  assert.ok(!/link_affiliate_customer\s*\(\s*new\.tenant_id\s*,\s*new\.referred_user_id\s*\)/.test(body),
    'o trigger nao pode linkar pelo referred_user_id: isso aponta o indicado para o afiliado errado');
});

test('o trigger so age em conversao sem premio', () => {
  const body = bodyOf('trg_referral_reward_link');
  assert.match(body, /new\.status = 'converted'/,
    'so conversao interessa');
  assert.match(body, /new\.reward_coupon_id is null/,
    'conversao que ja creditou nao precisa de vinculo');
});

test('o trigger e AFTER, e AFTER INSERT OR UPDATE', () => {
  // BEFORE rodaria antes do status virar 'converted' e referral_convert nao
  // encontraria a linha 'pending'.
  assert.match(sql, /CREATE TRIGGER trg_referral_reward_link\s+AFTER INSERT OR UPDATE ON public\.referrals/,
    'o trigger tem que ser AFTER INSERT OR UPDATE');
});

// ---------------------------------------------------------------------------
// 3) O motivo do silencio fica visivel
// ---------------------------------------------------------------------------

test('affiliate_reward_status distingue os tres motivos do premio faltar', () => {
  const body = bodyOf('affiliate_reward_status');

  // Sem isso o afiliado ve "1 indicacao convertida" e nenhum cupom, sem
  // distinguir "ja recebeu" de "nao pode receber ainda".
  assert.match(body, /'semCadastroCliente'/,
    'falta o motivo semCadastroCliente (afiliado nunca passou pelo /cliente)');
  assert.match(body, /'semTemplate'/,
    'falta o motivo semTemplate (configuracao do admin)');
  assert.match(body, /else 'ok'/,
    'falta o caso ok');

  // A ordem importa: semCadastroCliente e a causa que a configuracao nao
  // resolve. Se viesse depois de semTemplate, o afiliado seria mandado
  // configurar template que ele ja tem.
  const iCliente = body.indexOf("'semCadastroCliente'");
  const iTemplate = body.indexOf("'semTemplate'");
  assert.ok(iCliente < iTemplate, 'semCadastroCliente tem que ser avaliado antes de semTemplate');
});

test('affiliate_reward_status conta quantas indicacoes ficaram sem premio', () => {
  const body = bodyOf('affiliate_reward_status');
  // Convertidas SEM cupom e convertidas COM cupom sao numeros diferentes, e
  // o afiliado precisa ver os dois: e o que distingue "nao pode receber" de
  // "recebeu".
  assert.match(body, /'rewardedCount'[\s\S]*?r\.reward_coupon_id is not null/,
    'rewardedCount precisa contar apenas as indicacoes que creditaram premio');
  assert.match(body, /'convertedCount'/,
    'falta convertedCount');
});

// ---------------------------------------------------------------------------
// 4) Autorizacao
// ---------------------------------------------------------------------------

test('as tres RPCs novas sao SECURITY DEFINER com search_path fixo', () => {
  for (const nome of ['link_affiliate_customer', 'link_affiliate_by_id',
                      'affiliate_reward_status', 'backfill_affiliate_rewards']) {
    const body = bodyOf(nome);
    assert.match(body, /SECURITY DEFINER/, nome + ' precisa ser SECURITY DEFINER');
    assert.match(body, /SET search_path = public, extensions/,
      nome + ' precisa de search_path fixo');
  }
});

test('as RPCs novas nao sao executaveis pelo cliente', () => {
  // Sem o REVOKE, uma SECURITY DEFINER com these argumentos seria um
  // caminho para o anon ler estado de afiliado e, no caso da
  // backfill_affiliate_rewards, disparar UPDATE em massa.
  for (const nome of ['link_affiliate_customer', 'link_affiliate_by_id',
                      'affiliate_reward_status', 'backfill_affiliate_rewards']) {
    assert.ok(
      sql.includes('REVOKE EXECUTE ON FUNCTION public.' + nome),
      'falta REVOKE EXECUTE em ' + nome
    );
  }
});

// ---------------------------------------------------------------------------
// 5) O endpoint chama, e so depois do cadastro
// ---------------------------------------------------------------------------

test('identify.js chama link_affiliate_customer', () => {
  assert.match(identify, /rpc\('link_affiliate_customer'/,
    'identify.js nao chama a RPC de vinculo');
});

test('o vinculo no identify.js vem depois do cadastro, nao antes', () => {
  // Se viesse antes, uma falha no vinculo impediria o cadastro inteiro.
  const iCadastro = identify.indexOf("rpc('identify_customer'");
  const iVinculo = identify.indexOf("rpc('link_affiliate_customer'");
  assert.ok(iCadastro >= 0 && iVinculo >= 0, 'as duas chamadas precisam existir');
  assert.ok(iCadastro < iVinculo,
    'o cadastro do cliente tem que acontecer ANTES do vinculo com o afiliado');
});

test('falha no vinculo nao quebra o cadastro no identify.js', () => {
  const iVinculo = identify.indexOf("rpc('link_affiliate_customer'");
  const trecho = identify.slice(iVinculo, iVinculo + 400);
  assert.match(trecho, /catch/,
    'a chamada de vinculo precisa estar em try/catch');
});

// ---------------------------------------------------------------------------
// 6) A causa-raiz continua documentada onde ela acontece
// ---------------------------------------------------------------------------

test('a migracao registra que customer_id nunca era preenchido', () => {
  // Se alguem ler so o modulo3-afiliados.sql, o INSERT da linha 209 sugere
  // que a coluna e preenchida em algum lugar. Esta nota e o que impede a
  // proxima pessoa de criar uma terceira recompensa que nunca credita.
  assert.match(sql, /NINGUEM NUNCA ESCREVE ESSA\s+COLUNA|customer_id e NULL/,
    'a migracao precisa dizer que a coluna nunca era preenchida');
  assert.match(sql, /base schema/i,
    'a migracao precisa registrar que identify_customer/users nao estao no repo');
});

test('a migracao diz por que o grant_coupon_internal devolve null', () => {
  // O sintoma (reward_coupon_id NULL) e distante da causa (indice
  // customer_id na linha 353 e o if na linha 404). Sem esta referencia o
  // debug começa pelo lugar errado.
  assert.match(sql, /grant_coupon_internal/);
  assert.match(sql, /modulo3-afiliados\.sql:353|linha 353/,
    'a migracao precisa apontar a linha que le o customer_id');
});

test('a migracao nao reescreve o base schema', () => {
  // O motivo de tudo ser aditivo. Se alguem "simplificar" colocando um
  // CREATE OR REPLACE aqui, o cadastro inteiro quebra sem diff visivel.
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.identify_customer/.test(sql),
    'esta migracao nao pode reescrever identify_customer (base schema fora do repo)');
  assert.ok(!/CREATE TABLE[^;]*public\.users/.test(sql),
    'esta migracao nao pode mexer na tabela users');
});