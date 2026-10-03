const { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode } = require('./_supabaseAdmin');
const { randomUUID } = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  // Sem rate limit por IP, de proposito. Diferente de claim/identify/affiliates,
  // este endpoint exige sessao (resolveSession abaixo) e so enxerga o proprio
  // tenant: quem chama nao consegue enumerar cupom de outro estabelecimento. O
  // limite por IP aqui atrapalharia em vez de ajudar -- varios funcionarios da
  // mesma empresa sao CGNAT no mesmo IP publico e um deles takingdown levaria
  // junto o balcao inteiro. Se um dia precisar de teto contra forca bruta de
  // short_code, o contador vai por ator (actor.userId), nunca por IP.
  const supabase = getSupabaseAdminClient();
  try {
    const body = JSON.parse(event.body || '{}');
    const { publicId, rawToken, shortCode } = body;
    const idempotencyKey = body.idempotencyKey || randomUUID();
    if (!publicId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'publicId é obrigatório' }) };
    }

    const actor = await resolveSession(supabase, extractSessionToken(event, body));
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
      const code = rpcErrorCode(error);
      console.error('validate-coupon: rpc recusou: ' + (error && error.message));
      return { statusCode: 409, body: JSON.stringify({ error: code || 'COUPON_REJECTED' }) };
    }
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    const code = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    const body = code === 401 ? err.message : 'erro interno';
    if (code === 500) console.error('validate-coupon: ' + (err && err.message));
    return { statusCode: code, body: JSON.stringify({ error: body }) };
  }
};