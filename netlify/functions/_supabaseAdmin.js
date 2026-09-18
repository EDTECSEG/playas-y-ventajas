const { createClient } = require('@supabase/supabase-js');
const { createHmac, timingSafeEqual } = require('crypto');

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

// Extrai o sessionToken priorizando o header Authorization: Bearer <token>,
// com fallback para query string / corpo (legado). Nunca confiar em mais de um.
function extractSessionToken(event, body) {
  const headers = event.headers || {};
  const auth = headers.authorization || headers.Authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const q = (event.queryStringParameters || {}).sessionToken;
  if (q) return q;
  if (body && body.sessionToken) return body.sessionToken;
  return null;
}

// Token de cliente: HMAC(customerId) assinado com a service-role key.
// Permite autenticar o cliente em endpoints como "my-coupons" sem depender
// de tabela de sessao. O segredo nunca sai do servidor.
function buildCustomerToken(customerId) {
  return createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY).update(String(customerId)).digest('hex');
}

function verifyCustomerToken(customerId, token) {
  if (!token || !customerId) return false;
  const expected = buildCustomerToken(customerId);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

module.exports = { getSupabaseAdminClient, resolveSession, extractSessionToken, buildCustomerToken, verifyCustomerToken };