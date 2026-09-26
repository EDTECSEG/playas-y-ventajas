// Estabelecimentos de terceiros ao redor de uma coordenada, para o mapa de
// /cliente. A logica de consulta vive em ./_mapPlaces.js.
//
// Publico por desenho: dados abertos do OpenStreetMap, sem dado de cliente e
// sem segredo. O cache-control e publico porque a resposta depende so da URL
// (lat/lng/raio), que ja faz parte da chave de cache.
import { resolverParametros, buscarLugares } from './_mapPlaces.js';

function responder(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const params = resolverParametros({
    lat: url.searchParams.get('lat'),
    lng: url.searchParams.get('lng'),
    radiusM: url.searchParams.get('radiusM'),
    limit: url.searchParams.get('limit'),
  });
  if (!params) {
    return responder({ error: 'lat e lng numericos dentro de faixa sao obrigatorios' }, 400, 'no-store');
  }

  let lugares;
  try {
    lugares = await buscarLugares(params);
  } catch (err) {
    // O mapa ja mostra os estabelecimentos da plataforma; a camada de terceiros
    // e complemento. O Overpass fora do ar devolve lista vazia, nao 500, e o
    // motivo fica no log do servidor.
    console.error('map-places: overpass indisponivel: ' + ((err && err.message) || err));
    return responder({ lugares: [], aviso: 'estabelecimentos de terceiros indisponiveis' }, 200, 'no-store');
  }

  return responder({ lugares }, 200, 'public, max-age=600');
}
