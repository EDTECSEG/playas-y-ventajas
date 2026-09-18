const { getSupabaseAdminClient } = require('./_supabaseAdmin');

// Rate limit em memoria (por instancia de function).
// O controle DEFINITIVO deve ser no banco (ver supabase/security-hardening.sql):
// usar uma tabela de tentativas + backoff no RPC auth_login, que sobrevive a
// cold starts e vale para TODAS as instancias.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const BLOCK_MS = 15 * 60 * 1000;
const attempts = new Map(); // key -> { fails, blockedUntil }

function clientIp(event) {
  const headers = event.headers || {};
  const fwd = headers['x-forwarded-for'] || '';
  return (fwd.split(',')[0] || headers['cf-connecting-ip'] || headers['client-ip'] || 'unknown').trim();
}

function checkRateLimit(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec) return { allowed: true };
  if (rec.blockedUntil && rec.blockedUntil > now) {
    return { allowed: false, retryInMs: rec.blockedUntil - now };
  }
  if (rec.blockedUntil && rec.blockedUntil <= now) attempts.delete(key);
  return { allowed: true };
}

function recordFailure(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { fails: 0, blockedUntil: 0 };
  if (rec.blockedUntil > now) return;
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.fails = 0;
    rec.blockedUntil = now + BLOCK_MS;
  } else {
    rec.blockedUntil = 0;
  }
  attempts.set(key, rec);
}

function recordSuccess(key) {
  attempts.delete(key);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  const ip = clientIp(event);
  try {
    const { tenantSlug, internalCode, pin } = JSON.parse(event.body || '{}');
    if (!tenantSlug || !internalCode || !pin) {
      return { statusCode: 400, body: JSON.stringify({ error: 'tenantSlug, internalCode, pin obrigatórios' }) };
    }
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(internalCode) || typeof pin !== 'string' || pin.length > 128) {
      return { statusCode: 400, body: JSON.stringify({ error: 'entrada inválida' }) };
    }

    const key = `${tenantSlug}\u0000${internalCode}`;
    const limit = checkRateLimit(key);
    if (!limit.allowed) {
      return {
        statusCode: 429,
        headers: { 'Retry-After': String(Math.ceil(limit.retryInMs / 1000)) },
        body: JSON.stringify({ error: 'TOO_MANY_ATTEMPTS' }),
      };
    }
    const ipLimit = checkRateLimit(`ip:${ip}`);
    if (!ipLimit.allowed) {
      return {
        statusCode: 429,
        headers: { 'Retry-After': String(Math.ceil(ipLimit.retryInMs / 1000)) },
        body: JSON.stringify({ error: 'TOO_MANY_ATTEMPTS' }),
      };
    }

    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('auth_login', { p_tenant_slug: tenantSlug, p_internal_code: internalCode, p_pin: pin });
    if (error) {
      recordFailure(key);
      return { statusCode: 401, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
    }
    if (data && data.error) {
      recordFailure(key);
      return { statusCode: 401, body: JSON.stringify({ error: data.error }) };
    }
    recordSuccess(key);
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};