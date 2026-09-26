// Consulta de estabelecimentos de terceiros (OpenStreetMap via Overpass) para o
// mapa de /cliente.
//
// POR QUE ISTO EXISTE: a pagina pedia o Overpass direto do navegador. O Overpass
// nao devolve Access-Control-Allow-Origin, entao o browser bloqueava a resposta
// por CORS. O catch do cliente engolia o erro, a camada de "outros comercios da
// regiao" nunca aparecia e cada abertura de mapa deixava dois erros de CORS no
// console. Buscando no servidor nao existe CORS.
//
// SEGURANCA: lat e lng sao interpolados na query do Overpass e chegam da URL.
// Sao validados como numero finito dentro da faixa e arredondados antes de
// entrar na query, senao um valor malicioso viraria injecao de QL.

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Medido: ~5s para 6 km em Cabo Frio; o Overpass costuma levar de 2s a 20s.
// 12s da folga e continua abaixo dos 15s que o cliente espera.
const OVERPASS_TIMEOUT_MS = 12000;

// Overpass e gratuito e compartilhado: repetir a mesma consulta a cada abertura
// de mapa consome cota de todo mundo.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;

const RAIO_PADRAO_M = 6000;
const RAIO_MAX_M = 20000;
const LIMITE_PADRAO = 80;
const LIMITE_MAX = 120;

const cache = new Map();

export function coord(bruto, min, max) {
  // A guarda de null/''/tipo vem antes do Number(): Number(null) e Number('')
  // valem 0, entao sem ela um "lat=&lng=" seria aceito como lat=0,lng=0 — uma
  // consulta no Golfo da Guiné em vez do 400 que o cliente merece.
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

export function montarQueryOverpass({ lat, lng, raioM, limite }) {
  return (
    '[out:json][timeout:15];(' +
    `node["tourism"](around:${raioM},${lat},${lng});` +
    `way["tourism"](around:${raioM},${lat},${lng});` +
    `node["amenity"~"restaurant|cafe|bar"](around:${raioM},${lat},${lng});` +
    `);out center ${limite};`
  );
}

// O Overpass devolve o formato bruto do OSM, com tags de livre. Isso vai para o
// navegador, entao so o que o mapa desenha atravessa.
export function normalizarLugares(data, limite) {
  const elementos = data && Array.isArray(data.elements) ? data.elements : [];
  const lugares = [];
  for (const el of elementos) {
    const la = typeof el.lat === 'number' ? el.lat : (el.center && el.center.lat);
    const ln = typeof el.lon === 'number' ? el.lon : (el.center && el.center.lon);
    if (typeof la !== 'number' || typeof ln !== 'number') continue;
    const tags = el.tags || {};
    const nome = tags.name || tags.tourism || tags.amenity;
    if (!nome) continue;
    lugares.push({
      lat: la,
      lng: ln,
      nome: String(nome).slice(0, 120),
      categoria: String(tags.tourism || tags.amenity || '').slice(0, 40),
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

// Lanca em falha do Overpass ou timeout; quem chama decide a degradacao.
export async function buscarLugares(params) {
  const chave = `${params.lat},${params.lng},${params.raioM},${params.limite}`;
  const guardado = lerCache(chave);
  if (guardado) return guardado;

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'playas-y-ventajas-web/1.0 (mapa de ofertas)',
    },
    body: 'data=' + encodeURIComponent(montarQueryOverpass(params)),
    signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`overpass respondeu HTTP ${res.status}`);

  const lugares = normalizarLugares(await res.json(), params.limite);
  gravarCache(chave, lugares);
  return lugares;
}
