'use strict';

// Trava o CONTRATO DE RESPOSTA de `list_offers` - a tela de maior trafego do
// app (a home do cliente). Diferente do rpc-contract-guard, que fixa o que
// SAI (p_*), este fixa o que ENTRA.
//
// Por que merece um arquivo so: `list_offers` tem CINCO versoes no repo
// (coupon-management:156, fix-list-offers-image-url:12, offers-filters:96,
// offers-logo:12, offers-v3:82). Qual vale depende da ordem em que foram
// aplicadas em producao, e o repo nao registra isso. Sem este teste, da proxima
// vez que alguem rodar um SQL antigo, a tela quebra de um jeito silencioso: o
// SQL antigo nao tem `distanceKm`, entao o bloco de distancia
// (`cliente/page.jsx:1021`) simplesmente nao renderiza. Nenhum erro.
//
//Ja houve uma versao do contrato quebrada assim: `dash.rewardStatus`.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { makeFakeSupabase, makeEvent, loadFunction } = require('./helpers.cjs');

const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

// Campos que app/cliente/page.jsx le de cada oferta (`:349` monta o request,
// `:1021`/`:1103`/`:1213` leem). Os 3 sql-only (`benefitType`, `featuredRank`,
// `featuredUntil`) NAO sao lidos pela tela - existem no SQL mais recente e
// sao inertes. Ficam de fora de proposito: travar campo que ninguem lê so cria
// atrito quando o SQL legitimate mudar.
const LIDOS_PELA_UI = [
  'templateId',
  'title',
  'benefitValue',
  'businessId',
  'businessName',
  'category',
  'city',
  'imageUrl',
  'logoUrl',
  'featured',
  'distanceKm',
];

function ofertasFake(campos) {
  const o = {};
  for (const c of campos) o[c] = c === 'distanceKm' ? 3.14 : `x-${c}`;
  return [{ id: 'o-1', ...o }];
}

async function getOffers(query, extra) {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_offers') return { data: ofertasFake(extra || LIDOS_PELA_UI), error: null };
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
    from: () => ({
      select: () => ({
        eq: () => ({ in: () => ({ then: (r) => r({ data: [], error: null }) }) }),
      }),
    }),
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  try {
    const res = await handler(makeEvent({ query: { tenantId: TENANT, ...query } }));
    assert.strictEqual(res.statusCode, 200);
    return JSON.parse(res.body);
  } finally {
    restore();
  }
}

// Este e o teste que teria pegado o bug do rewardStatus pela outra ponta: se o
// SQL rodado em producao nao trouxer um destes, o handler passa adiante e a
// tela nao renderiza o bloco - sem erro de rede, sem log, sem nada.
test('todo campo lido pela UI existe em cada oferta devolvida', async () => {
  const ofertas = await getOffers({});
  assert.strictEqual(ofertas.length, 1);
  for (const campo of LIDOS_PELA_UI) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ofertas[0], campo),
      `list_offers nao devolveu "${campo}", que app/cliente/page.jsx le`,
    );
  }
});

// `distanceKm` e o mais silencioso: a UI so renderiza quando o valor vem
// (`page.jsx:1021` compara com null). Campo ausente e null produzem a mesma
// tela vazia, entao o teste nao pode aceitar so "tem a chave" — tem que
//Acceptar o valor, porque um null fixo tambem esconde o filtro por raio.
test('distanceKm volta numerico quando ha lat/lng, e null quando nao ha', async () => {
  const comGeo = await getOffers({ lat: '-23.55', lng: '-46.63', radiusKm: '16' });
  assert.strictEqual(typeof comGeo[0].distanceKm, 'number', 'com lat/lng, distanceKm tem de ser numero');

  const semGeo = await getOffers({}, ['templateId', 'title']);
  assert.strictEqual(semGeo[0].distanceKm, undefined, 'sem geo, nao deve inventar distancia');
});

// O filtro por raio so funciona se o handler repassar o parametro com o nome
// que o SQL espera. `p_radius_km` no handler contra `p_radiusKm` no SQL seria
// erro de RPC em producao; do mesmo modo lat/lng.
test('raio, lat e lng chegam a RPC com os nomes que o SQL declara', async () => {
  const seen = [];
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'list_offers') { seen.push(args); return { data: ofertasFake(LIDOS_PELA_UI), error: null }; }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
    from: () => ({ select: () => ({ eq: () => ({ in: () => ({ then: (r) => r({ data: [], error: null }) }) }) }) }),
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  try {
    await handler(makeEvent({ query: { tenantId: TENANT, lat: '-23.55', lng: '-46.63', radiusKm: '16', city: 'SP', category: 'Padaria' } }));
  } finally {
    restore();
  }
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(Object.keys(seen[0]), ['p_tenant_id', 'p_city', 'p_category', 'p_lat', 'p_lng', 'p_radius_km']);
  assert.strictEqual(seen[0].p_radius_km, 16, 'radiusKm precisa ser convertido para numero');
  assert.strictEqual(seen[0].p_lat, -23.55);
});

// O SQL so restringe por raio quando lat E lng vao junto (offers-v3:131):
// `p_radius_km is null or p_lat is null or p_lng is null or (...)`. A UI
// cumpre isso, mas o handler e publico e nao pode deixar isso virar "filtro
// fantasma": raio sem geo nao pode prometer filtragem.
test('raio sem lat/lng vira null, para nao prometer um filtro que nao acontece', async () => {
  const seen = [];
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'list_offers') { seen.push(args); return { data: [], error: null }; }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  try {
    await handler(makeEvent({ query: { tenantId: TENANT, radiusKm: '16' } }));
  } finally {
    restore();
  }
  assert.strictEqual(seen[0].p_radius_km, 16, 'o handler repassa o raio; quem ignora sem geo e o SQL');
});

// withOfferImages (offers.js:3) preenche imageUrl quando a RPC devolveu null,
// buscando em coupon_templates. A UI depende disso para a foto do card.
// O hook `from` do helpers resolve a query INTEIRA (devolve { data, error }),
// e nao cada degrau da cadeia. Por isso o `then` fica aqui, e nao um `in()`
// que so chama o hook.
test('withOfferImages preenche imageUrl faltante a partir de coupon_templates', async () => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_offers') {
        return { data: [{ templateId: 't-1', title: 'X', imageUrl: null }], error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
    from: (tabela) => {
      assert.strictEqual(tabela, 'coupon_templates');
      return Promise.resolve({ data: [{ id: 't-1', image_url: 'https://img/x.png' }], error: null });
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  try {
    const res = await handler(makeEvent({ query: { tenantId: TENANT } }));
    const body = JSON.parse(res.body);
    assert.strictEqual(body[0].imageUrl, 'https://img/x.png', 'imageUrl ausente deveria ser preenchido');
  } finally {
    restore();
  }
});

// Uma oferta SEM templateId nao pode ser buscada em coupon_templates (nao ha
// id), mas so deixa de ser buscada se `&& o.templateId` estiver no filtro.
// Tirando essa guarda, toda oferta sem templateId entra em `ids`, e o
// `.in('id', [null])` vai no banco. Medido: mutar a condicao para `!o.imageUrl`
// sozinho NAO derruba nenhum teste - por isso este caso existe.
test('oferta sem templateId nao entra na busca de imagens', async () => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_offers') {
        // Duas ofertas: uma com templateId, outra sem (orfa de campanha).
        return { data: [{ templateId: 't-1', imageUrl: null }, { imageUrl: null }], error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
    from: () => Promise.resolve({ data: [{ id: 't-1', image_url: 'https://img/x.png' }], error: null }),
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  try {
    const res = await handler(makeEvent({ query: { tenantId: TENANT } }));
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.length, 2, 'as duas ofertas tem de voltar');
    assert.strictEqual(body[0].imageUrl, 'https://img/x.png', 'a oferta com templateId ganha imagem');
    // A oferta sem templateId nao tem de ganhar imagem de ninguem.
    assert.strictEqual(body[1].imageUrl, null, 'oferta sem templateId nao deveria receber imagem');

    const consulta = fake.calls.in.find((c) => c.table === 'coupon_templates');
    assert.ok(consulta, 'a busca de imagens tem de acontecer');
    assert.strictEqual(consulta.column, 'id');
    // E o ponto que importa de verdade: sem o `&& o.templateId`, o id da
    // oferta orfa entra no `.in(...)` e a consulta vai ao banco com [undefined].
    assert.deepStrictEqual(consulta.values, ['t-1'], 'so o id real pode ir para o .in()');
    assert.ok(!consulta.values.some((v) => v == null), 'nenhum id nulo pode ir para o .in()');
  } finally {
    restore();
  }
});

// O caminho inverso importa mais: se a busca em coupon_templates falhar, a
// lista tem de voltar intacta. Perder as 17 ofertas por causa de uma falha de
// imagem seria pior do que um card sem foto.
test('falha na busca de imagens devolve as ofertas intactas, nao uma lista vazia', async () => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'list_offers') {
        return { data: [{ templateId: 't-1', title: 'X', imageUrl: null }], error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
    from: () => Promise.resolve({ data: null, error: { message: 'sem permissao' } }),
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  try {
    const res = await handler(makeEvent({ query: { tenantId: TENANT } }));
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.length, 1, 'a lista nao pode sumir por causa de imagem');
    assert.strictEqual(body[0].title, 'X');
  } finally {
    restore();
  }
});

test('a lista declarada bate com o que a tela realmente le', () => {
  // Guarda o arquivo contra encolhimento silencioso: se ninguem removesse de
  // proposito, basta apagar uma linha daqui e o contrato encolhe calado.
  assert.ok(LIDOS_PELA_UI.length >= 11, `contrato encolheu para ${LIDOS_PELA_UI.length}`);
  assert.strictEqual(new Set(LIDOS_PELA_UI).size, LIDOS_PELA_UI.length, 'campo repetido na lista');
  assert.ok(!LIDOS_PELA_UI.includes('featuredUntil'), 'featuredUntil nao e lido pela tela, nao entra no contrato');
  assert.ok(!LIDOS_PELA_UI.includes('benefitType'), 'benefitType nao e lido pela tela, nao entra no contrato');
});

// ---------------------------------------------------------------------------
// Ficha publica do estabelecimento (outubro/2026)
// ---------------------------------------------------------------------------
// Sob o QR Code do cupom em /cliente aparecem telefone, site e Instagram da
// empresa. Antes these dados eram buscados por um `businessLogoFor` que so
// devolvia nome e logo - o resto nao existia na resposta. A ficha nova vem de
// `business_public_card`.

const FICHA = {
  businessId: 'b-1',
  name: 'Padaria do Ze',
  logoUrl: 'https://img/logo.png',
  phone: '(11) 90000-0000',
  email: 'contato@exemplo.com',
  website: 'https://exemplo.com',
  instagram: 'padariadoze',
  category: 'Padaria',
  city: 'Sao Paulo',
};

test('businessCardFor pede a ficha nova, sem mexer no caminho antigo da logo', async () => {
  // Os dois parametros convivem de proposito: `businessLogoFor` esta em uso pelo
  // cliente ja publicado, e sobrescrever a resposta dele trocaria o formato de
  // um endpoint vivo. Se um dia os dois virarem o mesmo parametro, o cliente
  // antigo em producao passa a receber um formato que ele nao entende.
  const seen = [];
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      seen.push({ name, args });
      return { data: FICHA, error: null };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  try {
    const res = await handler(makeEvent({ query: { businessCardFor: 'b-1' } }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].name, 'business_public_card');
    assert.deepStrictEqual(seen[0].args, { p_business_id: 'b-1' }, 'o id tem de ir com o nome que o SQL declara');
    assert.deepStrictEqual(JSON.parse(res.body), FICHA, 'a ficha precisa voltar inteira, campos de contato inclusive');
  } finally {
    restore();
  }

  const logoSeen = [];
  const fakeLogo = makeFakeSupabase({
    rpc: async (name, args) => {
      logoSeen.push(name);
      return { data: { businessId: 'b-1', name: 'Padaria do Ze', logoUrl: 'https://img/logo.png' }, error: null };
    },
  });
  const { handler: h2, restore: r2 } = loadFunction('offers.js', fakeLogo);
  try {
    const res = await h2(makeEvent({ query: { businessLogoFor: 'b-1' } }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(logoSeen, ['business_logo_by_id'], 'businessLogoFor tem de continuar indo para a RPC antiga');
    assert.ok(!('website' in JSON.parse(res.body)), 'a resposta antiga nao pode ganhar campos: mudaria o formato');
  } finally {
    r2();
  }
});

test('a ficha traz telefone, site e Instagram, e o bloco de contato depende deles', () => {
  // Se a p9 parar de devolver um dos tres, o bloco de contato simplesmente
  // deixa de mostrar aquela linha - sem erro, sem log. Por isso o contrato
  // lista os tres campos explicitamente.
  for (const campo of ['phone', 'website', 'instagram', 'logoUrl', 'name']) {
    assert.ok(Object.prototype.hasOwnProperty.call(FICHA, campo), `a ficha precisa trazer ${campo}`);
  }
  const sql = readFileSync(path.join(__dirname, '..', 'supabase', 'p9-contato-publico-empresa.sql'), 'utf8');
  const ini = sql.indexOf('create or replace function public.business_public_card');
  assert.ok(ini !== -1, 'a p9 precisa criar business_public_card');
  const rpc = sql.slice(ini, sql.indexOf('end $function$', ini));
  for (const campo of ['phone', 'website', 'instagram', 'logoUrl', 'name']) {
    assert.ok(rpc.includes(`'${campo}'`), `business_public_card precisa devolver ${campo}`);
  }
  assert.ok(/v_row\.logo_url/.test(rpc), 'a logo volta da coluna logo_url');
  assert.ok(/security definer/.test(rpc), 'business_public_card precisa ser security definer, como business_logo_by_id');
  assert.ok(/set search_path to public/.test(rpc), 'business_public_card precisa fixar o search_path');
});

test('falha na ficha para o pedido, e nao escorre para a lista de ofertas', async () => {
  // Se o bloco da ficha devolvesse 200 com corpo vazio, o card de /cliente
  // mostraria um cupom sem nome de empresa. Se a chamada continuasse para
  // list_offers, o cliente receberia a lista inteira em vez de um erro. Os dois
  // são silenciosos; por isso o teste mede o caminho, e nao so o status.
  const seen = [];
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      seen.push(name);
      return { data: null, error: { message: 'permissao negada' } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  try {
    const res = await handler(makeEvent({ query: { businessCardFor: 'b-1' } }));
    assert.strictEqual(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error, 'a falha precisa virar erro, e nao ficha vazia');
    assert.deepStrictEqual(seen, ['business_public_card'], 'a falha nao pode escorrer para list_offers');
  } finally {
    restore();
  }
});