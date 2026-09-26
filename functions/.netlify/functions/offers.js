import { getSupabaseAdminClient, verifyCustomerToken, json } from './_shared.js';

async function withOfferImages(supabase, tenantId, offers) {
  if (!Array.isArray(offers) || offers.length === 0) return offers;
  const missing = offers.filter((o) => !o.imageUrl && o.offerId);
  if (missing.length === 0) return offers;
  const ids = [...new Set(missing.map((o) => o.offerId))];
  const { data, error } = await supabase
    .from('coupon_templates')
    .select('id,image_url')
    .eq('tenant_id', tenantId)
    .in('id', ids);
  if (error || !Array.isArray(data)) return offers;
  const byId = new Map(data.map((row) => [row.id, row.image_url]));
  return offers.map((o) => (o.imageUrl || byId.get(o.offerId) ? { ...o, imageUrl: o.imageUrl || byId.get(o.offerId) } : o));
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    const customerId = url.searchParams.get('customerId');
    const customerToken = url.searchParams.get('customerToken');
    const mode = url.searchParams.get('mode');
    const businessLogoFor = url.searchParams.get('businessLogoFor');
    if (!tenantId) return json({ error: 'tenantId obrigatório' }, 400);
    const supabase = getSupabaseAdminClient(env);

    if (businessLogoFor) {
      const { data, error } = await supabase.rpc('business_logo_by_id', { p_business_id: businessLogoFor });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (mode === 'cities') {
      const { data, error } = await supabase.rpc('list_cities', { p_tenant_id: tenantId });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    if (mode === 'my-coupons') {
      if (!customerId) return json({ error: 'customerId obrigatório' }, 400);
      // Anti-IDOR: sem o token assinado (HMAC) do proprio cliente, nao listamos.
      if (!(await verifyCustomerToken(env, customerId, customerToken))) {
        return json({ error: 'CUSTOMER_TOKEN_INVALID' }, 401);
      }
      const { data, error } = await supabase.rpc('list_customer_coupons', { p_tenant_id: tenantId, p_customer_id: customerId });
      if (error) return json({ error: error.message }, 400);
      return json(data);
    }

    const p_city = url.searchParams.get('city') || null;
    const p_category = url.searchParams.get('category') || null;
    const p_lat = url.searchParams.get('lat') ? parseFloat(url.searchParams.get('lat')) : null;
    const p_lng = url.searchParams.get('lng') ? parseFloat(url.searchParams.get('lng')) : null;
    const p_radius_km = url.searchParams.get('radiusKm') ? parseFloat(url.searchParams.get('radiusKm')) : null;

    const { data, error } = await supabase.rpc('list_offers', {
      p_tenant_id: tenantId, p_city, p_category, p_lat, p_lng, p_radius_km,
    });
    if (error) return json({ error: error.message }, 400);
    return json(await withOfferImages(supabase, tenantId, data));
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}