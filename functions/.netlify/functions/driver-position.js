import { getSupabaseAdminClient, extractSessionToken, json, rpcErrorCode, rpcErrorStatus } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/driver-position.js
//
// Motorista aprovado reporta a posicao atual do veiculo. A autorizacao vive
// na RPC driver_report_position, que exige sessao de motorista valida E
// status 'approved': o p_driver_id nunca vem do cliente, entao ninguem grava
// posicao em nome de outro motorista.

const toNumber = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export async function onRequestPost(context) {
  const { request, env } = context;

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }

  const sessionToken = extractSessionToken(request, body);
  if (!sessionToken) return json({ error: 'AUTH_REQUIRED' }, 401);

  const lat = toNumber(body.lat);
  const lng = toNumber(body.lng);
  const heading = toNumber(body.heading);
  const speedKmh = toNumber(body.speedKmh);

  try {
    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('driver_report_position', {
      p_session_token: sessionToken,
      p_lat: lat,
      p_lng: lng,
      p_heading: heading,
      p_speed_kmh: speedKmh,
      p_shuttle_id: body.shuttleId || null,
    });
    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('driver-position: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}