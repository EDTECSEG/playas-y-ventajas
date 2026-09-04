const { getSupabaseAdminClient, resolveSession } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  const supabase = getSupabaseAdminClient();
  try {
    if (event.httpMethod === 'GET') {
      const { sessionToken, mode } = event.queryStringParameters || {};
      const actor = await resolveSession(supabase, sessionToken);
      if (actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') return { statusCode: 403, body: JSON.stringify({ error: 'FORBIDDEN' }) };
      if (mode === 'billing') {
        const { data, error } = await supabase.rpc('admin_billing_panel', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      const { data, error } = await supabase.rpc('admin_list_businesses', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const actor = await resolveSession(supabase, body.sessionToken);
      if (actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') return { statusCode: 403, body: JSON.stringify({ error: 'FORBIDDEN' }) };

      if (body.action === 'create_business') {
        const { data, error } = await supabase.rpc('admin_create_business', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_name: body.name, p_category: body.category,
          p_city: body.city, p_phone: body.phone, p_email: body.email, p_lat: body.lat ?? null, p_lng: body.lng ?? null,
          p_owner_internal_code: body.ownerInternalCode, p_owner_pin: body.ownerPin, p_billing_plan: body.billingPlan || 'FREE',
          p_cnpj: body.cnpj || null, p_website: body.website || null, p_logo_url: body.logoUrl || null,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify(data) };
      }
      if (body.action === 'toggle_business') {
        const { error } = await supabase.rpc('admin_toggle_business', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_business_id: body.businessId, p_is_active: body.isActive,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      if (body.action === 'set_billing') {
        const { error } = await supabase.rpc('admin_set_billing', {
          p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_business_id: body.businessId,
          p_plan: body.plan, p_status: body.status, p_fee_cents: body.feeCents,
        });
        if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      return { statusCode: 400, body: JSON.stringify({ error: 'action inválida' }) };
    }

    return { statusCode: 405, body: '{}' };
  } catch (err) {
    const code = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return { statusCode: code, body: JSON.stringify({ error: err.message }) };
  }
};
