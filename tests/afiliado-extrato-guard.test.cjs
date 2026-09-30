'use strict';

// /afiliado: guarda do extrato de resgates.
//
// A tela mostrava so "quem indicou" e o status da conversao. O afiliado nao
// conseguia responder a pergunta que importa: quantos cupons as pessoas que
// ele indicou pegaram de fato, e quantos chegaram a ser usados no caixa.
//
// Tres erros que estas guardas evitam:
//
//   1. Contagem dentro de agregacao. admin_affiliate_report ja quebrou em
//      producao por um count() dentro de jsonb_agg (Postgres 42803:
//      "aggregate function calls cannot be nested"). A extrato tem contadores
//      E duas listas; a CTE monta a linha e tudo e lido no mesmo nivel.
//
//   2. Extrato que so conta resgate. Filtrar o cupom por
//      status = 'VALIDATED' faz o cupom que a pessoa PEGOU e nunca usou
//      desaparecer, e o afiliado passa a contar menos reward do que recebeu.
//      O cupom da indicacao e o primeiro emitido depois dela.
//
//   3. Tratar "pegou" como "resgatou". converted_at dispara no CLAIM, e o
//      resgatado no caixa e coupons.validated_at, que pode nunca acontecer.
//
// Nao da para renderizar JSX nem rodar a RPC neste runner, entao o padrao e
// travar o codigo-fonte, como em afiliado-folha-guard.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sql = readFileSync(path.join(root, 'supabase', 'affiliates-wiring.sql'), 'utf8');
const page = readFileSync(path.join(root, 'app', 'afiliado', 'page.jsx'), 'utf8');

// Recorta uma unica funcao do arquivo de SQL, para nao pegar codigo de
// admin_affiliate_report quando o teste for sobre affiliate_dashboard.
function functionBody(name) {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.' + name);
  assert.ok(start >= 0, 'funcao ' + name + ' nao encontrada no arquivo versionado');
  const end = sql.indexOf('$function$;', start);
  assert.ok(end > start, 'corpo de ' + name + ' nao fechado');
  return sql.slice(start, end);
}

// Devolve o trecho de cada jsonb_agg(...), contando parenteses para nao
// encerrar no primeiro ")" do jsonb_build_object que vem dentro.
function aggregateWindows(body) {
  const windows = [];
  const re = /jsonb_agg\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    windows.push(body.slice(m.index, i));
  }
  return windows;
}

test('extrato: affiliate_dashboard devolve a lista resgates', () => {
  const body = functionBody('affiliate_dashboard');
  assert.match(body, /'resgates'/, 'a RPC precisa devolver o array resgates');
  assert.match(body, /coalesce\(\s*jsonb_agg\(/, 'resgates precisa cair em [] quando nao ha nada');
});

test('extrato: nenhuma contagem dentro de agregacao (o 42803 de admin_affiliate_report)', () => {
  const body = functionBody('affiliate_dashboard');
  const windows = aggregateWindows(body);
  assert.ok(windows.length >= 2, 'esperado referrals e resgates como dois agregados');
  for (const w of windows) {
    assert.ok(!/\bcount\s*\(/.test(w), 'count() dentro de jsonb_agg: Postgres devolve 42803');
    assert.ok(!/\bsum\s*\(/.test(w), 'sum() dentro de jsonb_agg: Postgres devolve 42803');
    // A janela comeca no proprio jsonb_agg( de abertura, entao so interessa
    // uma segunda ocorrencia dentro dela.
    assert.strictEqual((w.match(/jsonb_agg\(/g) || []).length, 1,
      'jsonb_agg aninhado: Postgres devolve 42803');
  }
});

test('extrato: os contadores saem da mesma CTE das listas', () => {
  const body = functionBody('affiliate_dashboard');
  // Uma CTE so, lida duas vezes (contadores e listas). Se as listas voltarem a
  // ler referrals direto, os numeros e as linhas podem divergir.
  assert.match(body, /with indicacoes as \(/i);
  assert.match(body, /left join indicacoes i on true/i);
  assert.match(body, /count\(i\.id\)/);
  assert.match(body, /i\.tenant_id = p_tenant_id|r\.tenant_id = p_tenant_id/,
    'a CTE precisa filtrar por tenant');
});

test('extrato: o cupom da indicacao e o primeiro emitido depois dela', () => {
  const body = functionBody('affiliate_dashboard');
  assert.match(body, /issued_at >= r\.created_at/,
    'sem isso o extrato mistura cupom de outra visita');
  assert.match(body, /order by co\.issued_at asc\s+limit 1/i,
    'o cupom da indicacao e o primeiro, nao o mais recente');
});

test('extrato: nao filtra o cupom por VALIDATED (esconderia o cupom pego e nao usado)', () => {
  const body = functionBody('affiliate_dashboard');
  const lateral = body.slice(body.indexOf('left join lateral'), body.indexOf(') c on true'));
  assert.ok(lateral.length > 0, 'esperava o join lateral do cupom');
  assert.ok(!/status\s*=\s*'VALIDATED'/.test(lateral),
    'filtrar por VALIDATED esconde cupom pegado e ainda nao usado');
});

test('extrato: a autenticacao por telefone continua obrigatoria', () => {
  const body = functionBody('affiliate_dashboard');
  assert.match(body, /a\.id = p_affiliate_id/);
  assert.match(body, /a\.tenant_id = p_tenant_id/);
  assert.match(body, /a\.phone_digits = regexp_replace/,
    'comparar os digitos e o que faz o telefone com mascara funcionar');
});

test('extrato: a tela desenha a lista de resgates', () => {
  assert.match(page, /dash\.resgates/);
  assert.match(page, /Extrato de resgates/);
  assert.match(page, /r\.cupomCodigo/, 'o extrato mostra o codigo do cupom');
  assert.match(page, /r\.estabelecimento/, 'o extrato mostra onde foi usado');
});

test('extrato: "pegou" e "resgatou" aparecem como coisas diferentes', () => {
  // Os dois rotulos precisam existir e ser distintos: e o que impede o
  // afiliado de contar uma recompensa que ainda nao existe.
  assert.match(page, /Resgatado no caixa/);
  assert.match(page, /ainda não usado/);
  assert.match(page, /r\.resgatadoEm/, 'o resgate no caixa vem de validated_at');
  assert.match(page, /r\.cupomEm/, 'a data do cupom vem separada do resgate');
  // A ordem de decisao tem que testar o resgate ANTES do cupom em maos.
  const fn = page.slice(page.indexOf('function statusResgate'));
  assert.ok(fn.indexOf('r.resgatadoEm') < fn.indexOf('r.cupomCodigo'),
    'o resgate no caixa tem preceder o cupom em maos');
});

test('extrato: estado vazio nao quebra a tela quando ninguem indicou ainda', () => {
  assert.match(page, /Nenhum resgate ainda/);
  assert.match(page, /\(dash\.resgates \|\| \[\]\)\.length === 0/,
    'precisa tratar lista ausente sem quebrar');
});

test('extrato: o beneficio nunca vira undefined% na tela', () => {
  const fn = page.slice(page.indexOf('function beneficioLabel'));
  assert.ok(fn.indexOf("includes('percent')") >= 0, 'percent precisa ser reconhecido');
  assert.match(fn, /return null/, 'valor ausente nao vira rotulo');
});
