'use strict';

// Camada de comércios de terceiros no mapa de /cliente.
//
// O defeito que estes testes cobrem: a pagina chamava o Overpass direto do
// browser. O Overpass nao devolve Access-Control-Allow-Origin, a resposta era
// recusada por CORS, o catch engolia o erro e a camada de "outros comercios da
// regiao" nunca aparecia no mapa — sem nenhuma mensagem, so dois erros no
// console por abertura. Agora a consulta sai do servidor, onde CORS nao existe.
//
// A segunda parte e a saida do Overpass: a instancia publica tem 2 slots de
// consulta para o mundo inteiro e responde 504/429 sob carga, entao a camada
// aparecia em cerca de 1 em cada 3 aberturas. A consulta foi para a Geoapify
// (plano gratis, 3000 req/dia) sem mudar o contrato do endpoint.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { ROOT } = require('./helpers.cjs');

const cjs = require(path.join(ROOT, 'netlify', 'functions', '_mapPlaces.js'));
const { handler } = require(path.join(ROOT, 'netlify', 'functions', 'map-places.js'));

const CHAVE = 'chave-de-teste';
const originalKey = process.env.GEOAPIFY_API_KEY;

// Fecha a chave por padrao: o resto dos testes precisa de uma configurada, e
// nenhum deve depender do ambiente de quem roda.
process.env.GEOAPIFY_API_KEY = CHAVE;
test.after(() => {
  if (originalKey === undefined) delete process.env.GEOAPIFY_API_KEY;
  else process.env.GEOAPIFY_API_KEY = originalKey;
});

// Geom [lon, lat], como manda o GeoJSON.
function feature(nome, lon, lat, categories) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { name: nome, categories, street: 'Av. XYZ', housenumber: '100', place_id: 'abc123' },
  };
}

function comFetch(fake, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try { return fn(); } finally { globalThis.fetch = original; }
}

test('lat/lng fora de faixa ou nao numericos sao rejeitados', () => {
  const invalidos = [
    { lat: 'abc', lng: '-22.9' },
    { lat: '-22.9', lng: 'abc' },
    { lat: '', lng: '' },
    { lat: null, lng: null },
    // Number('') e Number(null) valem 0: sem a guarda estes dois cairiam em
    // lat=0,lng=0, o Golfo da Guine, em vez de 400.
    { lat: 'NaN', lng: '1' },
    { lat: 'Infinity', lng: '1' },
    { lat: '91', lng: '0' },
    { lat: '-91', lng: '0' },
    { lat: '0', lng: '181' },
    { lat: '0', lng: '-181' },
    { lat: '-22.9,lat)', lng: '-43.1' },
    { lat: '0);out;//', lng: '0' },
  ];
  for (const q of invalidos) {
    assert.strictEqual(cjs.resolverParametros(q), null, `deveria rejeitar ${JSON.stringify(q)}`);
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

test('a URL usa circle:lon,lat,raio — longitude primeiro', () => {
  // A Geoapify documenta "circle:lon,lat,radiusMeters". Inverter para lat,lng
  // nao da erro: devolve lugares no hemisferio oposto, e o bug so aparece como
  // "o mapa nao tem nada por perto". Por isso a comparacao e literal.
  const p = cjs.resolverParametros({ lat: '-22.886', lng: '-43.1235' });
  const url = new URL(cjs.montarUrlGeoapify(p, CHAVE));
  assert.strictEqual(url.origin + url.pathname, 'https://api.geoapify.com/v2/places');
  assert.strictEqual(url.searchParams.get('filter'), 'circle:-43.1235,-22.886,6000');
  assert.strictEqual(url.searchParams.get('limit'), '60');
  assert.strictEqual(url.searchParams.get('apiKey'), CHAVE);
  assert.strictEqual(url.searchParams.get('lang'), 'pt');
  // Hospedagem, restaurant, cafe, bar e atracoes: e o que o hóspede procura.
  for (const c of ['accommodation', 'catering.restaurant', 'catering.cafe', 'catering.bar', 'tourism']) {
    assert.ok(url.searchParams.get('categories').includes(c), `categoria ${c} ausente`);
  }
});

test('a chave fica na query e nunca num campo de texto que o mapa exiba', () => {
  const p = cjs.resolverParametros({ lat: '0', lng: '0' });
  const url = cjs.montarUrlGeoapify(p, CHAVE);
  // Ela vai na URL porque a Geoapify exige, mas e parametro de query da chamada
  // do servidor — o que o navegador recebe e so a lista normalizada.
  assert.ok(url.includes(`apiKey=${CHAVE}`));
  const lugares = cjs.normalizarLugares(
    { features: [feature('Hotel X', -43.1, -22.8, ['accommodation', 'accommodation.hotel'])] },
    60,
  );
  assert.ok(!JSON.stringify(lugares).includes(CHAVE));
});

test('a coordenada de um mapa nao injeta parametro na URL', () => {
  // Valores maliciosos morrem em resolverParametros, e URLSearchParams escapa o
  // resto. As duas barreiras juntas significam que a URL so pode conter
  // circulo:<lon>,<lat>,<raio> com numeros.
  const p = cjs.resolverParametros({ lat: '-22.88599', lng: '-43.123456' });
  const filtro = new URL(cjs.montarUrlGeoapify(p, CHAVE)).searchParams.get('filter');
  assert.strictEqual(filtro, 'circle:-43.1235,-22.886,6000');
  assert.match(filtro, /^circle:-?\d+(\.\d+)?,-?\d+(\.\d+)?,\d+$/);
});

test('o rotulo vem da categoria mais especifica, sem o prefixo de topo', () => {
  assert.strictEqual(cjs.rotularCategoria(['catering', 'catering.restaurant.brazilian']), 'restaurant');
  assert.strictEqual(cjs.rotularCategoria(['accommodation', 'accommodation.hotel']), 'hotel');
  assert.strictEqual(cjs.rotularCategoria(['catering', 'catering.cafe.coffee_shop']), 'cafe');
  assert.strictEqual(cjs.rotularCategoria(['tourism']), 'tourism');
  for (const ruim of [null, undefined, [], 'catering', {}, 42]) {
    assert.strictEqual(cjs.rotularCategoria(ruim), '', `entrada ${JSON.stringify(ruim)} deveria virar ''`);
  }
});

test('normalizarLugares so deixa passar posicao, nome e rotulo', () => {
  const data = {
    features: [
      feature('Hotel X', -43.12, -22.885, ['accommodation', 'accommodation.hotel']),
      feature('Restaurante Y', -43.13, -22.88, ['catering', 'catering.restaurant.brazilian']),
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.14, -22.87] }, properties: { categories: ['tourism'] } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.15] }, properties: { name: 'So longitude' } },
      { type: 'Feature', properties: { name: 'Sem geometria', lat: -22.8, lon: -43.1 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.16, -22.8] }, properties: {} },
      null,
    ],
  };
  const lugares = cjs.normalizarLugares(data, 60);
  assert.deepStrictEqual(
    lugares.map((l) => [l.nome, l.categoria]),
    [
      ['Hotel X', 'hotel'],
      ['Restaurante Y', 'restaurant'],
      ['Sem geometria', ''],
    ],
  );
  // Endereco e place_id ficam no servidor: nada disso e desenhado no mapa.
  assert.ok(!JSON.stringify(lugares).includes('Av. XYZ'));
  assert.ok(!JSON.stringify(lugares).includes('abc123'));
  assert.deepStrictEqual(Object.keys(lugares[0]).sort(), ['categoria', 'lat', 'lng', 'nome']);
});

test('normalizarLugares respeita o limite e entradas invalidas', () => {
  const muitos = { features: Array.from({ length: 40 }, (_, i) => feature(`L${i}`, -43 + i / 1000, -22.8, ['tourism'])) };
  assert.strictEqual(cjs.normalizarLugares(muitos, 10).length, 10);
  for (const ruim of [null, undefined, {}, { features: null }, { features: 'x' }, 'texto', 42]) {
    assert.deepStrictEqual(cjs.normalizarLugares(ruim, 60), [], `entrada ${JSON.stringify(ruim)} deveria virar lista vazia`);
  }
});

test('o handler responde 400 para coordenada invalida, sem chamar a Geoapify', async () => {
  await comFetch(() => { throw new Error('nao deveria consultar a Geoapify'); }, async () => {
    const r = await handler({ queryStringParameters: { lat: 'abc', lng: '1' } });
    assert.strictEqual(r.statusCode, 400);
    assert.match(r.headers['cache-control'], /no-store/);
  });
});

test('sem GEOAPIFY_API_KEY o mapa degrada em vez de quebrar', async () => {
  const saved = process.env.GEOAPIFY_API_KEY;
  delete process.env.GEOAPIFY_API_KEY;
  try {
    await comFetch(() => { throw new Error('nao deveria consultar a Geoapify sem chave'); }, async () => {
      const r = await handler({ queryStringParameters: { lat: '-22.8859', lng: '-43.1234' } });
      assert.strictEqual(r.statusCode, 200);
      const body = JSON.parse(r.body);
      assert.deepStrictEqual(body.lugares, []);
      assert.ok(body.aviso, 'a degradacao precisa se anunciar no corpo');
    });
  } finally {
    process.env.GEOAPIFY_API_KEY = saved;
  }
});

test('o handler degrada para lista vazia quando a Geoapify falha', async () => {
  // A tela ja tem os estabelecimentos da plataforma; um 500 aqui derrubaria a
  // experiencia do mapa por causa de um servico de terceiro fora do ar.
  for (const falha of [new Error('geoapify fora do ar'), Object.assign(new Error('rate limit'), { status: 429 })]) {
    await comFetch(async () => { throw falha; }, async () => {
      const r = await handler({ queryStringParameters: { lat: '-22.8859', lng: '-43.1234' } });
      assert.strictEqual(r.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(r.body).lugares, []);
    });
  }
  // HTTP de erro da API tambem degrada, em vez de vazar o corpo do terceiro.
  await comFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }), async () => {
    const r = await handler({ queryStringParameters: { lat: '-22.8859', lng: '-43.1234' } });
    assert.strictEqual(r.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(r.body).lugares, []);
  });
});

test('o handler entrega lugares, consulta pelo servidor e expoe o cache', async () => {
  const chamado = { url: null };
  await comFetch(async (url) => {
    chamado.url = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        features: [
          feature('Hotel X', -43.12, -22.885, ['accommodation', 'accommodation.hotel']),
          feature('Restaurante Y', -43.13, -22.88, ['catering', 'catering.restaurant']),
        ],
      }),
    };
  }, async () => {
    const r = await handler({ queryStringParameters: { lat: '-22.8859', lng: '-43.1234' } });
    assert.strictEqual(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.lugares.length, 2);
    assert.strictEqual(body.lugares[0].nome, 'Hotel X');
    assert.strictEqual(body.lugares[0].categoria, 'hotel');
    assert.match(r.headers['cache-control'], /public/);
    assert.match(chamado.url, /api\.geoapify\.com\/v2\/places/);
    // Parse em vez de comparar string: URLSearchParams escapa ":" e ",", e o
    // teste nao deve depender do formato exato da percent-encoding.
    const enviada = new URL(chamado.url);
    assert.strictEqual(enviada.searchParams.get('filter'), 'circle:-43.1234,-22.8859,6000');
    assert.strictEqual(enviada.searchParams.get('apiKey'), CHAVE);
  });
});

test('a segunda chamada no mesmo ponto nao gasta cota', async () => {
  let chamadas = 0;
  await comFetch(async () => {
    chamadas += 1;
    return { ok: true, status: 200, json: async () => ({ features: [feature('Hotel X', -43.12, -22.885, ['accommodation', 'accommodation.hotel'])] }) };
  }, async () => {
    // Coordenada propria deste teste, para nao colidir com o cache do teste acima.
    const q = { lat: '10.1234', lng: '20.5678' };
    await handler({ queryStringParameters: q });
    await handler({ queryStringParameters: q });
  });
  assert.strictEqual(chamadas, 1, 'a segunda leitura deveria vir do cache');
});

test('a chave da Geoapify nao esta no bundle nem na pagina do cliente', () => {
  const cliente = readFileSync(path.join(ROOT, 'app', 'cliente', 'page.jsx'), 'utf8');
  assert.ok(!/geoapify/i.test(cliente), 'a pagina nao deve conhecer a Geoapify: a chave vive so no servidor');
  assert.ok(!/overpass-api\.de/.test(cliente), 'voltou a chamada direta ao Overpass: o browser toma CORS de novo');
  assert.ok(/\.netlify\/functions\/map-places\?lat=/.test(cliente), 'a pagina precisa buscar os lugares no nosso endpoint');

  const helper = readFileSync(path.join(ROOT, 'netlify', 'functions', '_mapPlaces.js'), 'utf8');
  assert.ok(
    !/apiKey\s*[:=]\s*['"][A-Za-z0-9]{10,}/.test(helper),
    'parece haver uma chave da Geoapify hard-coded no helper',
  );
});
