import { getSupabaseAdminClient, json } from './_shared.js';

// Rate limit em memoria (por isolado de function).
// O controle DEFINITIVO deve ir para o banco (supabase/security-hardening.sql):
// tabela de tentativas + backoff dentro do RPC auth_login, valido para todas
// as instancias e sobrevivendo a cold starts.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const BLOCK_MS = 15 * 60 * 1000;
const attempts = new Map();

function clientIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  return (fwd.split(',')[0] || request.headers.get('cf-connecting-ip') || 'unknown').trim();
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
  rec.blockedUntil = rec.fails >= MAX_FAILS ? now + BLOCK_MS : 0;
  if (rec.blockedUntil) rec.fails = 0;
  attempts.set(key, rec);
}

function recordSuccess(key) {
  attempts.delete(key);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const ip = clientIp(request);
  try {
    const { tenantSlug, internalCode, pin } = await request.json();
    if (!tenantSlug || !internalCode || !pin) {
      return json({ error: 'tenantSlug, internalCode, pin obrigatórios' }, 400);
    }
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(internalCode) || typeof pin !== 'string' || pin.length > 128) {
      return json({ error: 'entrada inválida' }, 400);
    }

    const key = `${tenantSlug}\u0000${internalCode}`;
    const limit = checkRateLimit(key);
    if (!limit.allowed) {
      return json({ error: 'TOO_MANY_ATTEMPTS' }, 429, { 'Retry-After': String(Math.ceil(limit.retryInMs / 1000)) });
    }
    const ipLimit = checkRateLimit(`ip:${ip}`);
    if (!ipLimit.allowed) {
      return json({ error: 'TOO_MANY_ATTEMPTS' }, 429, { 'Retry-After': String(Math.ceil(ipLimit.retryInMs / 1000)) });
    }

    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('auth_login', { p_tenant_slug: tenantSlug, p_internal_code: internalCode, p_pin: pin });
    if (error) {
      recordFailure(key);
      return json({ error: (error.message || '').split(':')[0].trim() }, 401);
    }
    if (data && data.error) {
      recordFailure(key);
      return json({ error: data.error }, 401);
    }
    recordSuccess(key);
    let mustChangePin = false;
    try {
      const { data: flag, error: flagErr } = await supabase.rpc('auth_pin_reset_required', { p_user_id: data.userId });
      if (!flagErr && flag === true) mustChangePin = true;
    } catch { /* flag ausente: segue sem exigir troca */ }
    return json({ ...data, mustChangePin });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}