// Consulta de estabelecimentos de terceiros (OpenStreetMap via Overpass) para o
// mapa da tela do cliente.
// Canon CJS. Espelho ESM: functions/.netlify/functions/_mapPlaces.js
//
// POR QUE ISTO EXISTE: a pagina pedia o Overpass direto do navegador. O Overpass
// nao devolve Access-Control-Allow-Origin, entao o browser bloqueava a resposta
// por CORS. O catch do cliente engolia o erro, a camada de "outros comercios da
// regiao" nunca aparecia e cada abertura de mapa deixava dois erros de CORS no
// console. Buscando no servidor nao existe CORS: a resposta nao e recusada.
//
// O que o cliente ja tem nao muda: os estabelecimentos da propria plataforma
// continuam vindo de 'offers'. Aqui so entra o que o usuario nao encontra
// dentro do sistema, como complemento.
//
// SEGURANCA: lat e lng sao interpolados na query do Overpass e chegam da URL.
// Eles sao validados como numero finito dentro da faixa e arredondados antes de
// entrar na query. Sem isso, um valor assim ("-22.9,lat)") entraria como QL e
// viraria injeccao de consulta contra um servico de terceiro.

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Medido: uma consulta de 6 km em Cabo Frio leva ~5s, e o Overpass costuma
// demorar de 2s a 20s conforme a carga. Com 8s a camada de terceiros
// degradava para vazio com frequencia. 12s da folga e continua abaixo dos 15s
// que o cliente espera, entao o servidor responde antes de o browser desistir.
const OVERPASS_TIMEOUT_MS = 12000;

// Overpass e um servico gratuito e compartilhado: repetir a mesma consulta a
// cada abertura de mapa consome cota de todo mundo. Cache curto por coordenada
// arredondada, com tamanho limitado para o isolate nao crescer sem fim.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;

const RAIO_PADRAO_M = 6000;
const RAIO_MAX_M = 20000;
const LIMITE_PADRAO = 80;
const LIMITE_MAX = 120;

const cache = new Map();

// Numero dentro de [min,max], arredondado para 4 casas. Devolve null para
// qualquer coisa que nao seja numero finito na faixa, e o chamador trata como
// entrada invalida. Arredondar tambem faz o cachenir melhor, porque o LatLng do
// navegador costuma vir com muitos decimais.
//
// A guarda de null/''/tipo vem antes do Number(): Number(null) e Number('')
// valem 0, entao sem ela um "lat=&lng=" seria aceito como lat=0,lng=0 — uma
// consulta no Golfo da Guiné em vez do 400 que o cliente merece.
function coord(bruto, min, max) {
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

// Entrada crua da URL -> parametros validados, ou null se invalidos.
function resolverParametros(query) {
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

function montarQueryOverpass({ lat, lng, raioM, limite }) {
  return (
    '[out:json][timeout:15];(' +
    `node["tourism"](around:${raioM},${lat},${lng});` +
    `way["tourism"](around:${raioM},${lat},${lng});` +
    `node["amenity"~"restaurant|cafe|bar"](around:${raioM},${lat},${lng});` +
    `);out center ${limite};`
  );
}

// O Overpass devolve o formato bruto do OSM, com tags de livre. Isso vai para o
// navegador, entao so o que o mapa desenha atravessa: posicao, nome e o tipo.
// Sem isto, qualquer tag Craftsman=... ou ele=... ia para o cliente.
function normalizarLugares(data, limite) {
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

// Lanca em falha do Overpass ou timeout. Quem chama decide o que fazer: no mapa
// a resposta e complemento, entao o chamador degrada para lista vazia.
async function buscarLugares(params) {
  const chave = `${params.lat},${params.lng},${params.raioM},${params.limite}`;
  const guardado = lerCache(chave);
  if (guardado) return guardado;

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass e um servico de terceiro: identificar o cliente faz parte da
      // etiqueta de uso do projeto deles, e o browser nao permitiria setar.
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

module.exports = {
  RAIO_PADRAO_M,
  RAIO_MAX_M,
  LIMITE_PADRAO,
  LIMITE_MAX,
  coord,
  resolverParametros,
  montarQueryOverpass,
  normalizarLugares,
  buscarLugares,
};
