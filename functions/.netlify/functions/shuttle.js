import { getSupabaseAdminClient, json } from './_shared.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const tenantId = url.searchParams.get('tenantId');
    if (!tenantId) return json({ error: 'tenantId obrigatório' }, 400);

    const latRaw = url.searchParams.get('lat');
    const lngRaw = url.searchParams.get('lng');
    const hasLat = latRaw !== null && latRaw !== '';
    const hasLng = lngRaw !== null && lngRaw !== '';
    if (hasLat !== hasLng) return json({ error: 'lat e lng devem ser enviados juntos' }, 400);

    const p_lat = hasLat ? parseFloat(latRaw) : null;
    const p_lng = hasLng ? parseFloat(lngRaw) : null;
    if (hasLat && (Number.isNaN(p_lat) || Number.isNaN(p_lng))) {
      return json({ error: 'lat e lng devem ser numéricos' }, 400);
    }

    const radiusRaw = url.searchParams.get('radiusKm');
    const p_radius_km = radiusRaw !== null && radiusRaw !== '' ? parseFloat(radiusRaw) : null;
    if ((p_radius_km !== null && (Number.isNaN(p_radius_km) || p_radius_km <= 0)) ||
        (p_radius_km !== null && !hasLat)) {
      return json({ error: 'radiusKm só faz sentido junto de lat/lng' }, 400);
    }
    const p_radius_m = p_radius_km !== null ? p_radius_km * 1000 : null;

    let p_max_age_s = 300;
    const maxAgeRaw = url.searchParams.get('maxAgeS');
    if (maxAgeRaw !== null && maxAgeRaw !== '') {
      p_max_age_s = parseInt(maxAgeRaw, 10);
      if (Number.isNaN(p_max_age_s) || p_max_age_s <= 0) {
        return json({ error: 'maxAgeS deve ser um inteiro positivo' }, 400);
      }
    }

    const supabase = getSupabaseAdminClient(env);
    const [servicesRes, vehiclesRes] = await Promise.all([
      supabase.rpc('list_shuttle_services', { p_tenant_id: tenantId, p_lat, p_lng, p_radius_km }),
      supabase.rpc('list_live_vehicles', { p_tenant_id: tenantId, p_lat, p_lng, p_radius_m, p_max_age_s }),
    ]);
    if (servicesRes.error) return json({ error: servicesRes.error.message }, 400);
    if (vehiclesRes.error) return json({ error: vehiclesRes.error.message }, 400);

    return json({
      services: servicesRes.data || [],
      vehicles: vehiclesRes.data || [],
    });
  } catch (err) {
    console.error('shuttle: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}