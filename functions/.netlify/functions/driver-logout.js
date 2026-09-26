import { getSupabaseAdminClient, extractSessionToken, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/driver-logout.js
//
// Encerra a sessao do motorista. Revogacao e do lado do banco (a RPC apaga a
// linha em driver_sessions), e nao daqui: se o logout so limpasse cookie, a
// sessao continuaria valida no banco.
//
// Idempotente por natureza: chamar duas vezes com o mesmo token e seguro, a
// segunda ja nao acha a sessao.

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

  try {
    const supabase = getSupabaseAdminClient(env);

    // Confere que o token e de motorista antes de revogar. Reutilizar
    // resolveSession (que espera sessao de usuario) aqui confundiria as duas
    // tabelas; por isso a checagem direta.
    const { data: driverSession, error: verifyError } = await supabase.rpc('driver_verify_session', {
      p_session_token: sessionToken,
    });
    if (verifyError || !driverSession) return json({ error: 'SESSION_EXPIRED' }, 401);

    const { error } = await supabase.rpc('driver_logout', { p_session_token: sessionToken });
    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
