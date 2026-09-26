'use strict';

// /cliente quebrava inteiro quando o endpoint de ofertas falhava. O handler
// devolve array no caminho feliz e {"error": ...} com 4xx/5xx, e a pagina fazia
// setOffers(await res.json()) sem olhar res.ok nem o tipo: o objeto chegava no
// state, offers.length era undefined e offers.map estourava, derrubando a tela
// com "Application error: a client-side exception has occurred".
//
// Nao da para renderizar JSX neste runner (sem jsdom, sem testing-library), entao
// estes testes travam o padrao no codigo-fonte. O que eles garantem e que a
// linha perigosa nao volta e que as guardas continuam la; a prova de comportamento
// foi feita no navegador, com o endpoint respondendo erro: a pagina renderizou e
// mostrou "Nao foi possivel carregar as ofertas" em vez de quebrar.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'app', 'cliente', 'page.jsx');
const src = readFileSync(PAGE, 'utf8');

test('a pagina nao passa a resposta do offers direto para o state', () => {
  assert.ok(
    !/setOffers\(\s*await\s+\w+\.json\(\)/.test(src),
    'voltou setOffers(await res.json()): um objeto de erro no state quebra o render em offers.map',
  );
});

test('loadOffers checa res.ok antes de usar o corpo', () => {
  assert.ok(
    /async function loadOffers\(\)[\s\S]*?if \(!res\.ok\)/.test(src),
    'loadOffers precisa rejeitar resposta nao-2xx antes de setar o state',
  );
});

test('loadOffers so aceita array e descarta o resto', () => {
  assert.ok(
    /async function loadOffers\(\)[\s\S]*?if \(!Array\.isArray\(data\)\)/.test(src),
    'sem guarda de tipo, qualquer objeto inesperado volta a derrubar offers.map',
  );
});

test('falha ao carregar ofertas deixa lista vazia e erro visivel', () => {
  // setOffers([]) junto do setOffersErro evita deixar a lista velha na tela
  // quando um filtro posterior falha.
  assert.ok(
    /setOffers\(\[\]\);\s*\n\s*setOffersErro\(/.test(src),
    'no caminho de erro, limpa a lista e registra o erro no mesmo passo',
  );
  assert.ok(src.includes('offersErro'), 'falta o estado offersErro');
});

test('o erro de ofertas tem lugar proprio no render, sem passar por "nao ha ofertas"', () => {
  // Se offersErro nao for a primeira opcao do ternario, o consumidor ve
  // "Nenhuma oferta no momento" quando o servidor esta quebrado, e conclui que a
  // loja sumiu.
  assert.ok(
    /offersErro\s*\?\s*\(/.test(src),
    'o render precisa testar offersErro antes de offers.length === 0',
  );
  assert.ok(
    /offersErro\s*\?[\s\S]{0,400}?offers\.length === 0\s*\?/.test(src),
    'offersErro precisa preceder o "sem ofertas" no mesmo ternario',
  );
});

test('loadOffers trata erro de rede sem rejeitar', () => {
  // Sem try/catch, uma falha de rede rejeita a promise dentro do useEffect e vira
  // unhandled rejection, sem nenhuma mensagem para o usuario.
  const corpo = src.slice(src.indexOf('async function loadOffers'), src.indexOf('async function loadCityAndCategoryOptions'));
  assert.ok(corpo.includes('try {'), 'loadOffers precisa de try/catch para erro de rede');
  assert.ok(corpo.includes('catch'), 'loadOffers precisa tratar o erro de rede');
});

test('loadOffers aborta requisicao pendurada em vez de esperar para sempre', () => {
  // Requisicao que nao responde nao rejeita: sem timeout o fetch fica
  // pendurado indefinidamente e a tela mostra "Nenhuma oferta", fazendo o
  // usuario achar que a loja esta vazia. Foi assim que o travamento do
  // endpoint passou despercebido.
  assert.ok(
    /function fetchComTimeout\(/.test(src) && /ctrl\.abort\(\)/.test(src),
    'fetchComTimeout precisa abortar via AbortController',
  );
  assert.ok(
    /async function loadOffers\(\)[\s\S]*?await fetchComTimeout\(/.test(src),
    'loadOffers precisa passar pelo fetch com timeout, nao pelo fetch cru',
  );
  assert.ok(
    /const res = await fetch\(`\/\.netlify\/functions\/offers\?\$\{params\.toString\(\)\}`\)/.test(src) === false,
    'voltou o fetch sem timeout em loadOffers',
  );
  assert.ok(
    /clearTimeout\(timer\)/.test(src),
    'o timer do timeout precisa ser limpo, senao vaza a cada requisicao',
  );
});

test('loadMyCoupons e chamada com catch, sem unhandled rejection', () => {
  // loadMyCoupons faz fetch sem try/catch e era disparada sem await: uma falha
  // virava unhandled rejection e nao afetava a tela, mas poluia o console e
  // escondia falha real de cupons.
  assert.ok(
    /loadMyCoupons\([^)]*\)\.catch\(/.test(src),
    'a chamada de loadMyCoupons precisa de .catch()',
  );
});
