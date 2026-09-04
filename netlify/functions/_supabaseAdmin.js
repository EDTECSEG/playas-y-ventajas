const { createClient } = require('@supabase/supabase-js');

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Env vars ausentes: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceKey);
}

// Resolve o ator REAL a partir do token de sessao - nunca confiar em userId/tenantId
// enviados pelo cliente. Lanca erro se o token for invalido/expirado.
async function resolveSession(supabase, sessionToken) {
  if (!sessionToken) throw new Error('SESSION_REQUIRED');
  const { data, error } = await supabase.rpc('auth_verify_session', { p_session_token: sessionToken });
  if (error) throw new Error('SESSION_EXPIRED');
  return data; // { userId, tenantId, role, businessId, internalCode }
}

module.exports = { getSupabaseAdminClient, resolveSession };
