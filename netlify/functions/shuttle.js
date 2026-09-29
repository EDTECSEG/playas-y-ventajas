// Endpoint de translado/proximidade: lista servicos de translado e posicoes
// de veiculos ao vivo do tenant. A leitura usa as RPCs STABLE do modulo 1
// (list_shuttle_services / list_live_vehicles) com o client de administracao.
// Somente leitura: nao existe gravacao neste endpoint (a posicao do veiculo
// e reportada pelo fluxo do motorista, fora deste escopo).

const { getSupabaseAdminClient } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  try {
    const { tenantId, lat, lng, radiusKm, maxAgeS } = event.queryStringParameters || {};
    if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId obrigatório' }) };

    // lat e lng vêm juntos; sem eles o serviço lista tudo (sem distância).
    const hasLat = lat !== undefined && lat !== null && lat !== '';
    const hasLng = lng !== undefined && lng !== null && lng !== '';
    if (hasLat !== hasLng) return { statusCode: 400, body: JSON.stringify({ error: 'lat e lng devem ser enviados juntos' }) };

    const p_lat = hasLat ? parseFloat(lat) : null;
    const p_lng = hasLng ? parseFloat(lng) : null;
    if (hasLat && (Number.isNaN(p_lat) || Number.isNaN(p_lng))) {
      return { statusCode: 400, body: JSON.stringify({ error: 'lat e lng devem ser numéricos' }) };
    }

    const p_radius_km = radiusKm !== undefined && radiusKm !== '' ? parseFloat(radiusKm) : null;
    if ((p_radius_km !== null && (Number.isNaN(p_radius_km) || p_radius_km <= 0)) ||
        (p_radius_km !== null && !hasLat)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'radiusKm só faz sentido junto de lat/lng' }) };
    }
    const p_radius_m = p_radius_km !== null ? p_radius_km * 1000 : null;

    let p_max_age_s = 300;
    if (maxAgeS !== undefined && maxAgeS !== '') {
      p_max_age_s = parseInt(maxAgeS, 10);
      if (Number.isNaN(p_max_age_s) || p_max_age_s <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'maxAgeS deve ser um inteiro positivo' }) };
      }
    }

    const supabase = getSupabaseAdminClient();
    const [servicesRes, vehiclesRes] = await Promise.all([
      supabase.rpc('list_shuttle_services', { p_tenant_id: tenantId, p_lat, p_lng, p_radius_km }),
      supabase.rpc('list_live_vehicles', { p_tenant_id: tenantId, p_lat, p_lng, p_radius_m, p_max_age_s }),
    ]);
    if (servicesRes.error) return { statusCode: 400, body: JSON.stringify({ error: servicesRes.error.message }) };
    if (vehiclesRes.error) return { statusCode: 400, body: JSON.stringify({ error: vehiclesRes.error.message }) };

    return {
      statusCode: 200,
      body: JSON.stringify({
        services: servicesRes.data || [],
        vehicles: vehiclesRes.data || [],
      }),
    };
  } catch (err) {
    console.error('shuttle: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};