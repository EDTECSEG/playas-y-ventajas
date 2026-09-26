const { getSupabaseAdminClient, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canon CJS. Espelho ESM: functions/.netlify/functions/driver-logout.js
//
// Encerra a sessao do motorista. Revogacao e do lado do banco (a RPC apaga a
// linha em driver_sessions), e nao daqui: se o logout so limpasse cookie, a
// sessao continuaria valida no banco.
//
// Idempotente por natureza: chamar duas vezes com o mesmo token e seguro, a
// segunda ja nao acha a sessao.

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
  if (!sessionToken) {
    return { statusCode: 401, body: JSON.stringify({ error: 'AUTH_REQUIRED' }) };
  }

  try {
    const supabase = getSupabaseAdminClient();

    // Confere que o token e de motorista antes de revogar. Reutilizar
    // resolveSession (que espera sessao de usuario) aqui confundiria as duas
    // tabelas; por isso a checagem direta.
    const { data: driverSession, error: verifyError } = await supabase.rpc('driver_verify_session', {
      p_session_token: sessionToken,
    });
    if (verifyError || !driverSession) {
      return { statusCode: 401, body: JSON.stringify({ error: 'SESSION_EXPIRED' }) };
    }

    const { error } = await supabase.rpc('driver_logout', { p_session_token: sessionToken });
    if (error) {
      return {
        statusCode: rpcErrorStatus(error),
        body: JSON.stringify({ error: rpcErrorCode(error) }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
