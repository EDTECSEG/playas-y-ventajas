import { getSupabaseAdminClient, resolveSession, extractSessionToken, json } from './_shared.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    const { publicId, rawToken, shortCode } = body;
    const idempotencyKey = body.idempotencyKey || crypto.randomUUID();
    if (!publicId) return json({ error: 'publicId é obrigatório' }, 400);

    const supabase = getSupabaseAdminClient(env);
    const actor = await resolveSession(supabase, extractSessionToken(request, body));
    if (!actor.businessId) return json({ error: 'ator não vinculado a um estabelecimento' }, 400);

    const { data, error } = await supabase.rpc('validate_and_redeem_coupon', {
      p_tenant_id: actor.tenantId, p_business_id: actor.businessId, p_public_id: publicId,
      p_raw_token: rawToken || null, p_actor_user_id: actor.userId, p_idempotency_key: idempotencyKey, p_short_code: shortCode || null,
    });
    if (error) {
      const code = (error.message || '').split(':')[0].trim();
      console.error('validate-coupon: rpc recusou: ' + (error && error.message));
      return json({ error: code || 'COUPON_REJECTED' }, 409);
    }
    return json(data);
  } catch (err) {
    const status = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    const body = status === 401 ? err.message : 'erro interno';
    if (status === 500) console.error('validate-coupon: ' + (err && err.message));
    return json({ error: body }, status);
  }
}
