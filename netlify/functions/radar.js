const { getSupabaseAdminClient , rpcErrorCode } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  try {
    const { tenantId, lat, lng, radiusKm } = event.queryStringParameters || {};
    if (!tenantId || !lat || !lng) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, lat, lng obrigatórios' }) };
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('find_nearby_businesses', {
      p_tenant_id: tenantId, p_lat: parseFloat(lat), p_lng: parseFloat(lng), p_radius_km: parseFloat(radiusKm) || 20,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    console.error('radar: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};
