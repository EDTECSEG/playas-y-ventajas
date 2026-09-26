import { createClient } from '@supabase/supabase-js';

export function getSupabaseAdminClient(env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Env vars ausentes: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  }
  return createClient(url, serviceKey);
}

export async function resolveSession(supabase, sessionToken) {
  if (!sessionToken) throw new Error('SESSION_REQUIRED');
  const { data, error } = await supabase.rpc('auth_verify_session', { p_session_token: sessionToken });
  if (error) throw new Error('SESSION_EXPIRED');
  return data;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Extrai o sessionToken priorizando o header Authorization: Bearer <token>,
// com fallback para query string / corpo (legado).
export function extractSessionToken(request, body) {
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const url = new URL(request.url);
  const q = url.searchParams.get('sessionToken');
  if (q) return q;
  if (body && body.sessionToken) return body.sessionToken;
  return null;
}

// Erros vindos de `raise exception 'CODIGO: detalhe'` no Postgres chegam como
// message. O codigo e a parte antes do primeiro ':' e e o unico texto seguro
// de repassar ao cliente — o resto pode carregar detalhe interno.
export function rpcErrorCode(error) {
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

export function rpcErrorStatus(error) {
  return RPC_ERROR_STATUS[rpcErrorCode(error)] || 400;
}

// Token de cliente: HMAC-SHA256(customerId) assinado com a service-role key.
// Impede IDOR em "my-coupons" sem depender de tabela de sessao.
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(value)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildCustomerToken(env, customerId) {
  return hmacHex(env.SUPABASE_SERVICE_ROLE_KEY, customerId);
}

export async function verifyCustomerToken(env, customerId, token) {
  if (!token || !customerId) return false;
  const expected = await hmacHex(env.SUPABASE_SERVICE_ROLE_KEY, customerId);
  const a = String(token);
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}