const { getSupabaseAdminClient, verifyCustomerToken } = require('./_supabaseAdmin');

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

exports.handler = async (event) => {
  try {
    const { tenantId, customerId, customerToken, mode, businessLogoFor, city, category, lat, lng, radiusKm } = event.queryStringParameters || {};
    if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId obrigatório' }) };
    const supabase = getSupabaseAdminClient();

    if (businessLogoFor) {
      const { data, error } = await supabase.rpc('business_logo_by_id', { p_business_id: businessLogoFor });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (mode === 'cities') {
      const { data, error } = await supabase.rpc('list_cities', { p_tenant_id: tenantId });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (mode === 'my-coupons') {
      if (!customerId) return { statusCode: 400, body: JSON.stringify({ error: 'customerId obrigatório' }) };
      // Anti-IDOR: sem o token assinado (HMAC) do proprio cliente, nao listamos.
      if (!verifyCustomerToken(customerId, customerToken)) {
        return { statusCode: 401, body: JSON.stringify({ error: 'CUSTOMER_TOKEN_INVALID' }) };
      }
      const { data, error } = await supabase.rpc('list_customer_coupons', { p_tenant_id: tenantId, p_customer_id: customerId });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    const { data, error } = await supabase.rpc('list_offers', {
      p_tenant_id: tenantId,
      p_city: city || null,
      p_category: category || null,
      p_lat: lat ? parseFloat(lat) : null,
      p_lng: lng ? parseFloat(lng) : null,
      p_radius_km: radiusKm ? parseFloat(radiusKm) : null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify(await withOfferImages(supabase, tenantId, data)) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};