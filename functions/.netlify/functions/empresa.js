import { getSupabaseAdminClient, resolveSession, extractSessionToken, json } from './_shared.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const supabase = getSupabaseAdminClient(env);
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode');
    const actor = await resolveSession(supabase, extractSessionToken(request));
    if (!actor.businessId) return json({ error: 'ator não vinculado a um estabelecimento' }, 400);
    if (mode === 'stats') {
      const { data, error } = await supabase.rpc('business_coupon_stats', { p_tenant_id: actor.tenantId, p_business_id: actor.businessId });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }
    if (mode === 'my-data') {
      const { data, error } = await supabase.rpc('business_get_own', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }
    const { data, error } = await supabase.rpc('empresa_dashboard', { p_tenant_id: actor.tenantId, p_business_id: actor.businessId });
    if (error) return json({ error: error.message }, 400);
    return json(data);
  } catch (err) {
    const status = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return json({ error: err.message }, status);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const supabase = getSupabaseAdminClient(env);
  try {
    const body = await request.json();
    const actor = await resolveSession(supabase, extractSessionToken(request, body));
    if (!actor.businessId) return json({ error: 'ator não vinculado a um estabelecimento' }, 400);

    if (body.action === 'create_campaign') {
      const { data, error } = await supabase.rpc('create_campaign', {
        p_tenant_id: actor.tenantId, p_business_id: actor.businessId, p_actor_user_id: actor.userId, p_title: body.title,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json(data);
    }
    if (body.action === 'create_template') {
      const { data, error } = await supabase.rpc('create_coupon_template', {
        p_tenant_id: actor.tenantId, p_business_id: actor.businessId, p_campaign_id: body.campaignId,
        p_actor_user_id: actor.userId, p_title: body.title, p_benefit_type: body.benefitType,
        p_benefit_value: body.benefitValue, p_total_stock: body.totalStock ?? null, p_image_url: body.imageUrl || null,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json(data);
    }
    if (body.action === 'toggle_template') {
      const { data, error } = await supabase.rpc('business_toggle_template', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_template_id: body.templateId, p_is_active: !!body.isActive,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true, changed: !!data });
    }
    if (body.action === 'update_template') {
      const { data, error } = await supabase.rpc('business_update_template', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_template_id: body.templateId,
        p_title: body.title, p_benefit_type: body.benefitType, p_benefit_value: body.benefitValue,
        p_total_stock: body.totalStock ?? null, p_image_url: body.imageUrl || null,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true, changed: !!data });
    }
    if (body.action === 'delete_template') {
      const { data, error } = await supabase.rpc('business_delete_template', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_template_id: body.templateId,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true, deleted: !!data });
    }
    if (body.action === 'update_my_data') {
      const { error } = await supabase.rpc('business_update_own', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_name: body.name || null,
        p_phone: body.phone || null, p_email: body.email || null, p_city: body.city || null, p_logo_url: body.logoUrl || null,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true });
    }
    if (body.action === 'set_pin') {
      const { data, error } = await supabase.rpc('business_set_pin', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_new_pin: body.newPin,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true, changed: !!data });
    }
    return json({ error: 'action inválida' }, 400);
  } catch (err) {
    const status = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return json({ error: err.message }, status);
  }
}
