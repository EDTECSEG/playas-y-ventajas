const { getSupabaseAdminClient, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canonico CJS, fonte unica: e o netlify.toml que publica esta pasta e o que o scripts/bundle-worker.mjs inlina. O espelho ESM que existia em functions/.netlify/functions foi removido em 2026-09-30 (divergia em silencio, sem teste que percebesse).
//
// Corridas do dia do motorista aprovado. GET lista; POST conclui a corrida.
//
// Credencial: a MESMA sessao de `driver-position` (driver_sessions), e nao a
// sessao de empresa (users.sessions) — sao tabelas distintas e misturar as duas
// seria abrir o endpoint para o painel. O `p_session_token` vai para a RPC e o
// driver_id, o tenant_id e o business_id sao derivados no banco: nenhum vem do
// corpo. Por isso NAO ha resolveSession aqui, igual a driver-position.
//
// Autorizacao tambem e da RPC (gate de driver_sessions + status 'approved',
// como driver_report_position): NOT_APPROVED / SESSION_EXPIRED chegam como
// codigo e sao traduzidos por rpcErrorStatus.
//
// A lista NAO devolve nome nem telefone do cliente: e a agenda da rota, nao uma
// folha de contato de terceiros.

const noStore = () => ({ 'Cache-Control': 'no-store' });
const json = (status, body) => ({ statusCode: status, headers: noStore(), body: JSON.stringify(body) });

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

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  let body = {};
  if (method === 'POST' && event.body && String(event.body).trim() !== '') {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return json(400, { error: 'INVALID_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  }

  const sessionToken = extractSessionToken(event, body);
  if (!sessionToken) return json(401, { error: 'AUTH_REQUIRED' });

  try {
    const supabase = getSupabaseAdminClient();

    if (method === 'GET') {
      // `date` e escolha de tela (YYYY-MM-DD). Sem ele, a RPC agrupa pelo dia
      // corrente no fuso de referencia — a tela manda o dia local do cliente.
      const qs = event.queryStringParameters || {};
      const date = qs.date ? String(qs.date).trim() : null;
      const { data, error } = await supabase.rpc('driver_list_shuttle_runs', {
        p_session_token: sessionToken,
        p_date: date || null,
      });
      if (error) return json(rpcErrorStatus(error), { error: rpcErrorCode(error) });

      const runs = runRows(data).map(normalizeRun);
      return json(200, { date: date || null, runs, count: runs.length });
    }

    const reservationId = String(body.reservationId || '').trim();
    if (!reservationId) return json(400, { error: 'RESERVATION_ID_REQUIRED' });

    const { data, error } = await supabase.rpc('driver_complete_shuttle_reservation', {
      p_session_token: sessionToken,
      p_reservation_id: reservationId,
    });
    if (error) return json(rpcErrorStatus(error), { error: rpcErrorCode(error) });

    const o = data && typeof data === 'object' ? data : {};
    return json(200, {
      reservationId: o.reservationId || reservationId,
      status: o.status || 'completed',
      completedAt: o.completedAt || null,
    });
  } catch (err) {
    console.error('driver-shuttle-runs: ' + (err && err.message));
    return json(500, { error: 'erro interno' });
  }
};
