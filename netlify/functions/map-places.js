// Estabelecimentos de terceiros ao redor de uma coordenada, para o mapa de
// /cliente. Le a logica de consulta em ./_mapPlaces.js.
//
// Publico por desenho: sao dados abertos do OpenStreetMap, sem dado de cliente
// e sem segredo. O cache-control e publico porque a resposta depende so da
// URL (lat/lng/raio), que ja faz parte da chave de cache.
const { resolverParametros, buscarLugares } = require('./_mapPlaces');

exports.handler = async (event) => {
  const query = event.queryStringParameters || {};
  const params = resolverParametros(query);
  if (!params) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'lat e lng numericos dentro de faixa sao obrigatorios' }),
      headers: { 'cache-control': 'no-store' },
    };
  }

  let lugares;
  try {
    lugares = await buscarLugares(params);
  } catch (err) {
    // O mapa ja mostra os estabelecimentos da plataforma. A camada de terceiros
    // e complemento: se o Overpass estiver fora, o cliente recebe lista vazia em
    // vez de um 500, e a tela segue util. O motivo vai para o log do servidor,
    // que e privado, e nao para a resposta.
    console.error('map-places: overpass indisponivel: ' + ((err && err.message) || err));
    return {
      statusCode: 200,
      body: JSON.stringify({ lugares: [], aviso: 'estabelecimentos de terceiros indisponiveis' }),
      headers: { 'cache-control': 'no-store' },
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ lugares }),
    headers: { 'cache-control': 'public, max-age=600' },
  };
};
