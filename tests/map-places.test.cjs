'use strict';

// Proxy do Overpass para o mapa de /cliente.
//
// O defeito que estes testes cobrem: a pagina chamava o Overpass direto do
// browser. O Overpass nao devolve Access-Control-Allow-Origin, a resposta era
// recusada por CORS, o catch engolia o erro e a camada de terceiros nunca
// aparecia no mapa — sem nenhuma mensagem, so dois erros no console por
// abertura. Agora a consulta sai do servidor, onde CORS nao existe.
//
// A parte que mais importa aqui e a validacao de lat/lng: os dois valores sao
// interpolados na query do Overpass e chegam da URL. Sem checar que sao numero
// finito dentro da faixa, um valor como "-22.9,lat)" entraria como QL e viraria
// injecao de consulta contra o servico de terceiro.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ROOT } = require('./helpers.cjs');

const cjs = require(path.join(ROOT, 'netlify', 'functions', '_mapPlaces.js'));

test('lat/lng fora de faixa ou nao numericos sao rejeitados', () => {
  const invalidos = [
    { lat: 'abc', lng: '-22.9' },
    { lat: '-22.9', lng: 'abc' },
    { lat: '', lng: '' },
    { lat: null, lng: null },
    { lat: 'NaN', lng: '1' },
    { lat: 'Infinity', lng: '1' },
    { lat: '91', lng: '0' },       // latitude acima de 90
    { lat: '-91', lng: '0' },
    { lat: '0', lng: '181' },      // longitude acima de 180
    { lat: '0', lng: '-181' },
    // Tentativas de injecao de QL: nao sao numero, entao nao entram na query.
    { lat: '-22.9,lat)', lng: '-43.1' },
    { lat: '0);out;//', lng: '0' },
  ];
  for (const q of invalidos) {
    assert.strictEqual(
      cjs.resolverParametros(q),
      null,
      `deveria rejeitar ${JSON.stringify(q)}`,
    );
  }
});

test('lat/lng validos passam e sao arredondados', () => {
  const p = cjs.resolverParametros({ lat: '-22.88599', lng: '-43.123456' });
  assert.ok(p, 'coordenada valida nao deveria ser rejeitada');
  assert.strictEqual(p.lat, -22.886);
  assert.strictEqual(p.lng, -43.1235);
});

test('raio e limite tem padrao e teto', () => {
  const base = cjs.resolverParametros({ lat: '0', lng: '0' });
  assert.strictEqual(base.raioM, cjs.RAIO_PADRAO_M);
  assert.strictEqual(base.limite, cjs.LIMITE_PADRAO);

  // Pedir o mapa inteiro ou 10000 lugares nao pode virar consulta ilimitada.
  const alto = cjs.resolverParametros({ lat: '0', lng: '0', radiusM: '999999', limit: '99999' });
  assert.strictEqual(alto.raioM, cjs.RAIO_MAX_M);
  assert.strictEqual(alto.limite, cjs.LIMITE_MAX);
});

test('a query e exatamente a montada, sem sobra do valor recebido', () => {
  const p = cjs.resolverParametros({ lat: '-22.88599', lng: '-43.123456' });
  // Comparacao exata: se qualquer caractere do dado recebido vazasse para a
  // query, a string montada deixaria de bater e o teste acusa. E mais forte que
  // procurar "caractere suspeito", que erra porque a query legitima tem
  // parenteses, aspas e colchetes.
  assert.strictEqual(
    cjs.montarQueryOverpass(p),
    '[out:json][timeout:15];(' +
      'node["tourism"](around:6000,-22.886,-43.1235);' +
      'way["tourism"](around:6000,-22.886,-43.1235);' +
      'node["amenity"~"restaurant|cafe|bar"](around:6000,-22.886,-43.1235);' +
      ');out center 80;',
  );
});

test('normalizarLugares so deixa passar posicao, nome e tipo', () => {
  const data = {
    elements: [
      { lat: -22.885, lon: -43.12, tags: { name: 'Hotel X', tourism: 'hotel', 'addr:street': 'Rua Secreta' } },
      { center: { lat: -22.88, lon: -43.13 }, tags: { amenity: 'restaurant', name: 'Restaurante Y' } },
      { lat: -22.87, lon: -43.14, tags: { tourism: 'hotel' } },        // sem name: entra com o tipo
      { tags: { name: 'Sem coordenada nenhuma' } },                    // sem lat/lon: descartado
      { center: { lat: -22.86 }, tags: { name: 'So latitude' } },      // lat sem lon: descartado
    ],
  };
  const lugares = cjs.normalizarLugares(data, 80);
  assert.strictEqual(lugares.length, 3, 'elemento sem coordenada nao pode entrar');
  assert.deepStrictEqual(
    lugares.map((l) => l.nome),
    ['Hotel X', 'Restaurante Y', 'hotel'],
  );
  // As tags cruas do OSM nao podem atravessar para o navegador.
  assert.ok(
    !JSON.stringify(lugares).includes('Rua Secreta'),
    'tag livre do OSM vazou para a resposta',
  );
  assert.deepStrictEqual(Object.keys(lugares[0]).sort(), ['categoria', 'lat', 'lng', 'nome']);
});

test('normalizarLugares respeita o limite e entradas invalidas', () => {
  const muitos = { elements: Array.from({ length: 50 }, (_, i) => ({ lat: -22 + i / 100, lon: -43, tags: { name: `L${i}` } })) };
  assert.strictEqual(cjs.normalizarLugares(muitos, 10).length, 10);
  // Resposta inesperada do Overpass nao pode estourar o render do mapa.
  for (const ruim of [null, undefined, {}, { elements: null }, { elements: 'x' }, 'texto', 42]) {
    assert.deepStrictEqual(cjs.normalizarLugares(ruim, 80), [], `entrada ${JSON.stringify(ruim)} deveria virar lista vazia`);
  }
});

test('o handler responde 400 para coordenada invalida', async () => {
  const { handler } = require(path.join(ROOT, 'netlify', 'functions', 'map-places.js'));
  const r = await handler({ queryStringParameters: { lat: 'abc', lng: '1' } });
  assert.strictEqual(r.statusCode, 400);
  assert.match(r.headers['cache-control'], /no-store/);
});

test('o handler degrada para lista vazia quando o Overpass falha', async () => {
  // A tela ja tem os estabelecimentos da plataforma; a camada de terceiros e
  // complemento. Um 500 aqui derrubaria aExperience do mapa por causa de um
  // servico de terceiro fora do ar.
  const { handler } = require(path.join(ROOT, 'netlify', 'functions', 'map-places.js'));
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('overpass fora do ar'); };
  try {
    const r = await handler({ queryStringParameters: { lat: '-22.8859', lng: '-43.1234' } });
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.deepStrictEqual(body.lugares, []);
    assert.ok(body.aviso, 'a degradacao precisa se anunciar no corpo');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('o handler entrega lugares e o cache e publico quando o Overpass responde', async () => {
  const { handler } = require(path.join(ROOT, 'netlify', 'functions', 'map-places.js'));
  const fetchOriginal = globalThis.fetch;
  const chamado = { url: null, body: null };
  globalThis.fetch = async (url, opts) => {
    chamado.url = String(url);
    chamado.body = opts.body;
    return {
      ok: true,
      status: 200,
      json: async () => ({ elements: [{ lat: -22.88, lon: -43.12, tags: { name: 'Hotel X', tourism: 'hotel' } }] }),
    };
  };
  try {
    const r = await handler({ queryStringParameters: { lat: '-22.8859', lng: '-43.1234' } });
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.lugares.length, 1);
    assert.strictEqual(body.lugares[0].nome, 'Hotel X');
    assert.match(r.headers['cache-control'], /public/);
    // A consulta precisa ter ido para o Overpass de verdade, pelo servidor.
    assert.match(chamado.url, /overpass-api\.de/);
    // O corpo vai como application/x-www-form-urlencoded, entao a query esta
    // percent-encoded: "around:" chega como "around%3A".
    assert.ok(chamado.body.includes('around'), 'a query Overpass nao foi enviada');
    assert.ok(chamado.body.includes('%3A'), 'a query deveria ir percent-encoded');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('a pagina do cliente nao chama mais o Overpass direto', () => {
  const { readFileSync } = require('node:fs');
  const src = readFileSync(path.join(ROOT, 'app', 'cliente', 'page.jsx'), 'utf8');
  assert.ok(
    !/overpass-api\.de/.test(src),
    'voltou a chamada direta ao Overpass: o browser vai tomar CORS de novo e a camada nao aparece',
  );
  assert.ok(
    /\.netlify\/functions\/map-places\?lat=/.test(src),
    'a pagina precisa buscar os lugares no nosso endpoint',
  );
});
