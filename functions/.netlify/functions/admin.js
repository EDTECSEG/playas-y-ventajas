import { getSupabaseAdminClient, resolveSession, extractSessionToken, json } from './_shared.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const supabase = getSupabaseAdminClient(env);
  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get('mode');
    const actor = await resolveSession(supabase, extractSessionToken(request));
    if (actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') return json({ error: 'FORBIDDEN' }, 403);

    if (mode === 'billing') {
      const { data, error } = await supabase.rpc('admin_billing_panel', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }
    if (mode === 'featured') {
      const { data, error } = await supabase.rpc('admin_featured_ranks', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }
    if (mode === 'customers') {
      const search = url.searchParams.get('search');
      const { data, error } = await supabase.rpc('admin_list_customers', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_search: search || null });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }
    const { data, error } = await supabase.rpc('admin_list_businesses', { p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId });
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
    if (actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') return json({ error: 'FORBIDDEN' }, 403);

    if (body.action === 'create_business') {
      const { data, error } = await supabase.rpc('admin_create_business', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_name: body.name, p_category: body.category,
        p_city: body.city, p_phone: body.phone, p_email: body.email, p_lat: body.lat ?? null, p_lng: body.lng ?? null,
        p_owner_internal_code: body.ownerInternalCode, p_owner_pin: body.ownerPin, p_billing_plan: body.billingPlan || 'FREE',
        p_cnpj: body.cnpj || null, p_website: body.website || null, p_logo_url: body.logoUrl || null,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json(data);
    }
    if (body.action === 'toggle_business') {
      const { error } = await supabase.rpc('admin_toggle_business', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_business_id: body.businessId, p_is_active: body.isActive,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true });
    }
    if (body.action === 'set_featured') {
      const { error } = await supabase.rpc('admin_set_featured', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_business_id: body.businessId,
        p_featured_rank: body.featuredRank,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true });
    }
    if (body.action === 'set_billing') {
      const { error } = await supabase.rpc('admin_set_billing', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_business_id: body.businessId,
        p_plan: body.plan, p_status: body.status, p_fee_cents: body.feeCents,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true });
    }
    if (body.action === 'update_customer') {
      const { error } = await supabase.rpc('admin_update_customer', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_customer_id: body.customerId,
        p_name: body.name || null, p_email: body.email || null, p_instagram: body.instagram || null, p_is_active: body.isActive ?? null,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true });
    }
    if (body.action === 'update_business') {
      const { error } = await supabase.rpc('admin_update_business', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_business_id: body.businessId,
        p_name: body.name || null, p_phone: body.phone || null, p_email: body.email || null, p_category: body.category || null,
        p_city: body.city || null, p_cnpj: body.cnpj || null, p_website: body.website || null, p_logo_url: body.logoUrl || null,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true });
    }
    if (body.action === 'request_password_reset') {
      const { data, error } = await supabase.rpc('admin_request_password_reset', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_business_id: body.businessId,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ tempPin: data });
    }
    if (body.action === 'delete_business') {
      const { data, error } = await supabase.rpc('admin_delete_business', {
        p_tenant_id: actor.tenantId, p_actor_user_id: actor.userId, p_business_id: body.businessId,
      });
      if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
      return json({ ok: true, deleted: !!data });
    }
    return json({ error: 'action inválida' }, 400);
  } catch (err) {
    const status = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return json({ error: err.message }, status);
  }
}
