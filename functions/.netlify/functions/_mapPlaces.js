// Consulta de estabelecimentos de terceiros para o mapa de /cliente.
//
// POR QUE ISTO EXISTE: a pagina pedia o Overpass direto do navegador. O Overpass
// nao devolve Access-Control-Allow-Origin, entao o browser bloqueava a resposta
// por CORS. O catch do cliente engolia o erro, a camada de "outros comercios da
// regiao" nunca aparecia e cada abertura de mapa deixava dois erros de CORS no
// console. Buscando no servidor nao existe CORS.
//
// POR QUE GEOAPIFY E NAO O OVERPASS: a instancia publica do Overpass tem 2 slots
// de consulta para o mundo inteiro (medido em /api/status) e responde 504/429
// sob carga — no Cloudflare, que sai por IP compartilhado, a camada aparecia em
// cerca de 1 em cada 3 aberturas. A Geoapify tem plano gratis de 3000
// requisicoes/dia, responde em ~1s e cacheia sem limite. Os dados continuam
// vindos do OpenStreetMap.
//
// A CHAVE FICA NO SERVIDOR: le de GEOAPIFY_API_KEY e nunca vai para o bundle do
// cliente.

const GEOAPIFY_URL = 'https://api.geoapify.com/v2/places';
const FETCH_TIMEOUT_MS = 8000;
const CATEGORIAS = 'accommodation,catering.restaurant,catering.cafe,catering.bar,tourism';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;

const RAIO_PADRAO_M = 6000;
const RAIO_MAX_M = 20000;
const LIMITE_PADRAO = 60;
const LIMITE_MAX = 120;

const cache = new Map();

export function coord(bruto, min, max) {
  // Number(null) e Number('') valem 0: sem esta guarda, "lat=&lng=" viraria
  // consulta no Golfo da Guine em vez de 400.
  if (bruto === null || bruto === undefined || bruto === '') return null;
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null;
  const n = Number(bruto);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 1e4) / 1e4;
}

function inteiro(bruto, padrao, max) {
  const n = Number.parseInt(bruto, 10);
  if (!Number.isFinite(n) || n <= 0) return padrao;
  return Math.min(n, max);
}

export function resolverParametros(query) {
  const lat = coord(query.lat, -90, 90);
  const lng = coord(query.lng, -180, 180);
  if (lat === null || lng === null) return null;
  return {
    lat,
    lng,
    raioM: inteiro(query.radiusM, RAIO_PADRAO_M, RAIO_MAX_M),
    limite: inteiro(query.limit, LIMITE_PADRAO, LIMITE_MAX),
  };
}

// ATENCAO: o filtro de circulo da Geoapify e "circle:lon,lat,raio" — longitude
// primeiro. A URL e montada com URLSearchParams, que escapa tudo o que vier
// depois, mas lat/lng seguem validados porque a API exige as faixas.
export function montarUrlGeoapify({ lat, lng, raioM, limite }, apiKey) {
  const q = new URLSearchParams({
    categories: CATEGORIAS,
    filter: `circle:${lng},${lat},${raioM}`,
    limit: String(limite),
    lang: 'pt',
    apiKey,
  });
  return `${GEOAPIFY_URL}?${q.toString()}`;
}

// Hierarquia do mais geral ao mais especifico; o rotulo vem do mais especifico
// sem o prefixo de topo: "restaurant", "hotel", "cafe".
export function rotularCategoria(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  const partes = String(categories[categories.length - 1]).split('.');
  const rotulo = partes.length > 1 ? partes[1] : partes[0];
  return rotulo.replace(/_/g, ' ').slice(0, 40);
}

// Ao navegador vai so o que o mapa desenha.
export function normalizarLugares(data, limite) {
  const features = data && Array.isArray(data.features) ? data.features : [];
  const lugares = [];
  for (const f of features) {
    const p = f && f.properties ? f.properties : {};
    const coords = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
    const lng = coords && typeof coords[0] === 'number' ? coords[0] : p.lon;
    const lat = coords && typeof coords[1] === 'number' ? coords[1] : p.lat;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const nome = p.name ? String(p.name).slice(0, 120) : '';
    if (!nome) continue;
    lugares.push({
      lat: Math.round(lat * 1e5) / 1e5,
      lng: Math.round(lng * 1e5) / 1e5,
      nome,
      categoria: rotularCategoria(p.categories),
    });
    if (lugares.length >= limite) break;
  }
  return lugares;
}

function lerCache(chave) {
  const item = cache.get(chave);
  if (!item) return null;
  if (Date.now() - item.t > CACHE_TTL_MS) {
    cache.delete(chave);
    return null;
  }
  return item.v;
}

function gravarCache(chave, valor) {
  if (cache.size >= CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(chave, { t: Date.now(), v: valor });
}

export async function buscarLugares(params) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) throw new Error('GEOAPIFY_API_KEY ausente');

  const chave = `${params.lat},${params.lng},${params.raioM},${params.limite}`;
  const guardado = lerCache(chave);
  if (guardado) return guardado;

  const res = await fetch(montarUrlGeoapify(params, apiKey), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`geoapify respondeu HTTP ${res.status}`);

  const lugares = normalizarLugares(await res.json(), params.limite);
  gravarCache(chave, lugares);
  return lugares;
}

export { CATEGORIAS, RAIO_PADRAO_M, RAIO_MAX_M, LIMITE_PADRAO, LIMITE_MAX };
