import { getSupabaseAdminClient, json } from './_shared.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    const lat = url.searchParams.get('lat');
    const lng = url.searchParams.get('lng');
    const radiusKm = url.searchParams.get('radiusKm');
    if (!tenantId || !lat || !lng) return json({ error: 'tenantId, lat, lng obrigatórios' }, 400);
    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('find_nearby_businesses', {
      p_tenant_id: tenantId, p_lat: parseFloat(lat), p_lng: parseFloat(lng), p_radius_km: parseFloat(radiusKm) || 20,
    });
    if (error) return json({ error: error.message }, 400);
    return json(data);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
