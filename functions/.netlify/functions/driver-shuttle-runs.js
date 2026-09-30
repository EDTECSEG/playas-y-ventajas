import { getSupabaseAdminClient, extractSessionToken, rpcErrorCode, rpcErrorStatus } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/driver-shuttle-runs.js
//
// Corridas do dia do motorista aprovado. GET lista; POST conclui a corrida.
//
// Credencial: a MESMA sessao de `driver-position` (driver_sessions), nunca a
// sessao de empresa. O driver_id/business_id sao derivados no banco, entao nao
// ha resolveSession aqui.
//
// O `json` local existe em vez do de _shared.js porque TODA resposta precisa de
// no-store, inclusive as de erro: sao horario, rota e numero de Passageiros de
// reservas de terceiros.

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function normalizeRun(r) {
  const o = r && typeof r === 'object' ? r : {};
  return {
    reservationId: o.reservationId || null,
    shuttleId: o.shuttleId || null,
    serviceName: o.serviceName || null,
    scheduledFor: o.scheduledFor || null,
    durationMinutes: o.durationMinutes === null || o.durationMinutes === undefined ? null : Number(o.durationMinutes),
    passengers: o.passengers === null || o.passengers === undefined ? null : Number(o.passengers),
    origin: o.origin || null,
    destination: o.destination || null,
    status: o.status || null,
  };
}

function runRows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.runs)) return data.runs;
  return [];
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const sessionToken = extractSessionToken(request, {});
  if (!sessionToken) return json({ error: 'AUTH_REQUIRED' }, 401);

  try {
    const supabase = getSupabaseAdminClient(env);
    const date = url.searchParams.get('date');
    const { data, error } = await supabase.rpc('driver_list_shuttle_runs', {
      p_session_token: sessionToken,
      p_date: date ? String(date).trim() : null,
    });
    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    const runs = runRows(data).map(normalizeRun);
    return json({ date: date ? String(date).trim() : null, runs, count: runs.length }, 200);
  } catch (err) {
    console.error('driver-shuttle-runs: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body = {};
  const raw = await request.text();
  if (raw && raw.trim() !== '') {
    try {
      body = JSON.parse(raw);
    } catch (e) {
      return json({ error: 'INVALID_JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  }

  const sessionToken = extractSessionToken(request, body);
  if (!sessionToken) return json({ error: 'AUTH_REQUIRED' }, 401);

  const reservationId = String(body.reservationId || '').trim();
  if (!reservationId) return json({ error: 'RESERVATION_ID_REQUIRED' }, 400);

  try {
    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('driver_complete_shuttle_reservation', {
      p_session_token: sessionToken,
      p_reservation_id: reservationId,
    });
    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    const o = data && typeof data === 'object' ? data : {};
    return json({
      reservationId: o.reservationId || reservationId,
      status: o.status || 'completed',
      completedAt: o.completedAt || null,
    }, 200);
  } catch (err) {
    console.error('driver-shuttle-runs: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}
