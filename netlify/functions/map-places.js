// Estabelecimentos de terceiros ao redor de uma coordenada, para o mapa de
// /cliente. Le a logica de consulta em ./_mapPlaces.js.
//
// Publico por desenho: sao pontos de interesse abertos, sem dado de cliente e
// sem segredo — a chave da Geoapify nunca sai daqui. O cache-control e publico
// porque a resposta depende so da URL (lat/lng/raio), que ja faz parte da chave
// de cache, e a Geoapify nao impoe limite de cache.
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
    // e complemento: se a Geoapify estiver fora, ou a chave ainda nao estiver
    // cadastrada, o cliente recebe lista vazia em vez de um 500, e a tela segue
    // util. O motivo vai para o log do servidor, que e privado.
    console.error('map-places: consulta de terceiros falhou: ' + ((err && err.message) || err));
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
