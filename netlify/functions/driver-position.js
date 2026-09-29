const { getSupabaseAdminClient, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canon CJS. Espelho ESM: functions/.netlify/functions/driver-position.js
//
// Motorista aprovado reporta a posicao atual do veiculo. A autorizacao vive
// na RPC driver_report_position, que exige sessao de motorista valida E
// status 'approved': o p_driver_id nunca vem do cliente, entao ninguem grava
// posicao em nome de outro motorista.
//
// Esta e a fonte de dados de list_live_vehicles (mapa em /cliente). E um
// upsert por driver_id: cada envio sobrepoe a linha do veiculo.

const toNumber = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }) };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    body = {};
  }

  const sessionToken = extractSessionToken(event, body);
  if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'AUTH_REQUIRED' }) };

  const lat = toNumber(body.lat);
  const lng = toNumber(body.lng);
  const heading = toNumber(body.heading);
  const speedKmh = toNumber(body.speedKmh);

  try {
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('driver_report_position', {
      p_session_token: sessionToken,
      p_lat: lat,
      p_lng: lng,
      p_heading: heading,
      p_speed_kmh: speedKmh,
      p_shuttle_id: body.shuttleId || null,
    });
    if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };
    return { statusCode: 200, body: JSON.stringify(data), headers: { 'Cache-Control': 'no-store' } };
  } catch (err) {
    console.error('driver-position: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};