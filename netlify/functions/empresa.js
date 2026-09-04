const { getSupabaseAdminClient, resolveSession } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  const supabase = getSupabaseAdminClient();
  try {
    if (event.httpMethod === 'GET') {
      const { sessionToken, mode } = event.queryStringParameters || {};
      const actor = await resolveSession(supabase, sessionToken);
      if (!actor.businessId) return { statusCode: 400, body: JSON.stringify({ error: 'ator não vinculado a um estabelecimento' }) };
      if (mode === 'stats') {
        const { data, error } = await supabase.rpc('business_coupon_stats', { p_tenant_id: actor.tenantId, p_business_id: actor.businessId });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      const { data, error } = await supabase.rpc('empresa_dashboard', { p_tenant_id: actor.tenantId, p_business_id: actor.businessId });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const actor = await resolveSession(supabase, body.sessionToken);
      if (!actor.businessId) return { statusCode: 400, body: JSON.stringify({ error: 'ator não vinculado a um estabelecimento' }) };

      if (body.action === 'create_campaign') {
        const { data, error } = await supabase.rpc('create_campaign', {
          p_tenant_id: actor.tenantId, p_business_id: actor.businessId, p_actor_user_id: actor.userId, p_title: body.title,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      if (body.action === 'create_template') {
        const { data, error } = await supabase.rpc('create_coupon_template', {
          p_tenant_id: actor.tenantId, p_business_id: actor.businessId, p_campaign_id: body.campaignId,
          p_actor_user_id: actor.userId, p_title: body.title, p_benefit_type: body.benefitType,
          p_benefit_value: body.benefitValue, p_total_stock: body.totalStock ?? null, p_image_url: body.imageUrl || null,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      return { statusCode: 400, body: JSON.stringify({ error: 'action inválida' }) };
    }

    return { statusCode: 405, body: '{}' };
  } catch (err) {
    const code = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return { statusCode: code, body: JSON.stringify({ error: err.message }) };
  }
};
