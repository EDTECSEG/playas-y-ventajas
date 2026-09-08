const { getSupabaseAdminClient, resolveSession } = require('./_supabaseAdmin');
const { randomUUID } = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const supabase = getSupabaseAdminClient();
  try {
    const body = JSON.parse(event.body || '{}');
    const { publicId, rawToken, shortCode } = body;
    const idempotencyKey = body.idempotencyKey || randomUUID();
    if (!publicId || (!rawToken && !shortCode)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'publicId e (rawToken ou shortCode) são obrigatórios' }) };
    }

    const actor = await resolveSession(supabase, body.sessionToken);
    if (!actor.businessId) return { statusCode: 400, body: JSON.stringify({ error: 'ator não vinculado a um estabelecimento' }) };

    const { data, error } = await supabase.rpc('validate_and_redeem_coupon', {
      p_tenant_id: actor.tenantId,
      p_business_id: actor.businessId,
      p_public_id: publicId,
      p_raw_token: rawToken || null,
      p_actor_user_id: actor.userId,
      p_idempotency_key: idempotencyKey,
      p_short_code: shortCode || null,
    });

    if (error) {
      const code = (error.message || '').split(':')[0].trim();
      return { statusCode: 409, body: JSON.stringify({ error: code || error.message }) };
    }
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    const code = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return { statusCode: code, body: JSON.stringify({ error: err.message }) };
  }
};
