const { createClient } = require('@supabase/supabase-js');
const { createHmac, timingSafeEqual } = require('crypto');

// O runtime mantem o isolate vivo entre requisicoes. Recriar o cliente a cada
// chamada refazia resolucao de DNS/TLS e desperdicava o calor do modulo; sob
// concorrencia isso foi um dos fatores das travas. O bundle e um unico arquivo
// (scripts/bundle-worker.mjs), entao o escopo de modulo e compartilhado por
// todos os handlers: guardar aqui reaproveita a instancia sem vazar estado
// entre requisicoes.
let cachedClient = null;

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Env vars ausentes: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  if (cachedClient) return cachedClient;
  cachedClient = createClient(url, serviceKey);
  return cachedClient;
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

// Erros vindos de `raise exception 'CODIGO: detalhe'` no Postgres chegam como
// message. O codigo e a parte antes do primeiro ':' e e o unico texto seguro
// de repassar ao cliente — o resto pode carregar detalhe interno.
function rpcErrorCode(error) {
  return String((error && error.message) || '').split(':')[0].trim();
}

// HTTP status por codigo de regra de negocio. Sem isto, tudo vira 400 e o
// cliente nao distingue "digitei errado" de "espera 1 hora" de "sem permissao".
const RPC_ERROR_STATUS = {
  REGISTRATION_RATE_LIMITED: 429,
  PHONE_ALREADY_REGISTERED: 409,
  EMAIL_ALREADY_REGISTERED: 409,
  INVITE_BUSINESS_MISMATCH: 409,
  INVITE_EXHAUSTED: 409,
  PIN_ALREADY_SET: 409,
  TOKEN_ALREADY_USED: 409,
  NOT_APPROVED: 403,
  FORBIDDEN: 403,
  AUTH_REQUIRED: 401,
  TOKEN_INVALID: 401,
  SESSION_EXPIRED: 401,
  DRIVER_NOT_FOUND: 404,
  BUSINESS_NOT_FOUND: 404,
  INVITE_INVALID: 404,
  DOCUMENT_NOT_FOUND: 404,
};

function rpcErrorStatus(error) {
  return RPC_ERROR_STATUS[rpcErrorCode(error)] || 400;
}

module.exports = { getSupabaseAdminClient, resolveSession, extractSessionToken, buildCustomerToken, verifyCustomerToken, rpcErrorCode, rpcErrorStatus };
