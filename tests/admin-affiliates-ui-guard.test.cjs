'use strict';

// O painel de afiliados do admin mostrava "Nenhum afiliado cadastrado ainda"
// mesmo com o cadastro existente no banco: a RPC admin_affiliate_report
// estourava (agregado aninhado no jsonb_agg), o fetch devolvia 4xx e a tela
// caia no texto de "nao existe nenhum". Isso e pior que tela quebrada: e tela
// que mente.
//
// A RPC ja foi corrigida (migration fix_admin_affiliate_report_nested_aggregate).
// Este teste trava o segundo mitad do conserto: falha de leitura e "nao existe
// nenhum" precisam aparecer diferentes.
//
// Nao da para renderizar JSX neste runner (sem jsdom), entao o padrao e travado
// no codigo-fonte, como em cliente-offers-guard.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'app', 'admin', 'page.jsx');
const src = readFileSync(PAGE, 'utf8');

test('loadAffiliates guarda o erro do carregamento em estado proprio', () => {
  assert.ok(
    /async function loadAffiliates\([\s\S]*?if \(!res\.ok\)[\s\S]*?setAffErr\(/.test(src),
    'loadAffiliates precisa registrar o erro: sem isso a lista zerada vira "nenhum afiliado cadastrado"',
  );
});

test('loadAffiliates limpa o erro quando a leitura da certo', () => {
  assert.ok(
    /async function loadAffiliates\([\s\S]*?setAffErr\(''\)/.test(src),
    'um erro antigo nao pode sobreviver a uma leitura bem-sucedida',
  );
});

test('a lista de afiliados nao mostra "nenhum cadastrado" quando ha erro', () => {
  assert.ok(
    /\{affErr \? \(/.test(src),
    'o bloco de erro precisa vir ANTES do fallback de lista vazia',
  );
  assert.ok(
    /affErr[\s\S]{0,200}affiliates\.length === 0 \? \(/.test(src),
    'a condicao de lista vazia tem de vir depois do teste de affErr',
  );
});

test('a tela nao depende so do toast global para avisar que o filtro falhou', () => {
  assert.ok(
    /affLoadError/.test(src),
    'o aviso de erro precisa aparecer na secao de afiliados, nao so no setMsg do topo da pagina',
  );
});

test('a chave affLoadError existe nos tres idiomas', () => {
  const i18n = readFileSync(path.join(__dirname, '..', 'lib', 'i18n.js'), 'utf8');
  const ocorrencias = i18n.match(/affLoadError:/g) || [];
  assert.strictEqual(ocorrencias.length, 3, 'affLoadError precisa existir em pt, en e es');
});
