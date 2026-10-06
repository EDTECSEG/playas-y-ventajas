const { getSupabaseAdminClient, verifyCustomerToken, rpcErrorCode } = require('./_supabaseAdmin');

// O tenant nao vem da query string. Antes vinha, e ia direto para as cinco
// RPCs por este client de administracao: bastava trocar o UUID na URL para
// listar ofertas, categorias e cidades de outro tenant. Em `my-coupons` era
// pior, porque verifyCustomerToken assina apenas o customerId -- um token
// valido combinado com o UUID de outro tenant lia os cupons desse tenant.
// Os sete callers do frontend (app/cliente/page.jsx) ja mandavam este mesmo
// UUID fixo, entao nada no cliente depende de mandar o parametro.
const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

async function withOfferImages(supabase, tenantId, offers) {
  if (!Array.isArray(offers) || offers.length === 0) return offers;
  const missing = offers.filter((o) => !o.imageUrl && o.templateId);
  if (missing.length === 0) return offers;
  const ids = [...new Set(missing.map((o) => o.templateId))];
  const { data, error } = await supabase
    .from('coupon_templates')
    .select('id,image_url')
    .eq('tenant_id', tenantId)
    .in('id', ids);
  if (error || !Array.isArray(data)) return offers;
  const byId = new Map(data.map((row) => [row.id, row.image_url]));
  return offers.map((o) => (o.imageUrl || byId.get(o.templateId) ? { ...o, imageUrl: o.imageUrl || byId.get(o.templateId) } : o));
}

exports.handler = async (event) => {
  try {
    // `tenantId` segue na query por compatibilidade, e de proposito ignorado.
    const { customerId, customerToken, mode, businessLogoFor, businessCardFor, city, category, lat, lng, radiusKm } = event.queryStringParameters || {};
    // Validacao barata ANTES de getSupabaseAdminClient(): nao ha por que
    // construir cliente de banco -- e lancar por falta de configuracao -- para
    // recusar um request malformado. O 400 do tenantId ficava aqui antes, e
    // defendia esse ponto; sem ele, qualquer request chega a abrir cliente.
    if (mode === 'my-coupons' && !customerId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'customerId obrigatório' }) };
    }
    const supabase = getSupabaseAdminClient();

    if (businessLogoFor) {
      const { data, error } = await supabase.rpc('business_logo_by_id', { p_business_id: businessLogoFor });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    // Ficha publica do estabelecimento: nome, logo, telefone, site e Instagram.
    // Fica num parametro NOVO (`businessCardFor`) em vez de reaproveitar
    // `businessLogoFor` de proposito. O parametro antigo esta em uso pelo
    // cliente ja publicado em producao, e sobrescrever o que a RPC dele devolve
    // trocaria o formato da resposta de um endpoint vivo sem ninguem pedir. Com
    // dois nomes, o cliente novo so passa a usar a ficha depois do deploy --
    // enquanto isso, o antigo segue funcionando igual.
    if (businessCardFor) {
      const { data, error } = await supabase.rpc('business_public_card', { p_business_id: businessCardFor });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (mode === 'cities') {
      const { data, error } = await supabase.rpc('list_cities', { p_tenant_id: TENANT_ID });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (mode === 'categories') {
      const { data, error } = await supabase.rpc('list_categories', { p_tenant_id: TENANT_ID });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (mode === 'my-coupons') {
      // Anti-IDOR: sem o token assinado (HMAC) do proprio cliente, nao listamos.
      if (!verifyCustomerToken(customerId, customerToken)) {
        return { statusCode: 401, body: JSON.stringify({ error: 'CUSTOMER_TOKEN_INVALID' }) };
      }
      const { data, error } = await supabase.rpc('list_customer_coupons', { p_tenant_id: TENANT_ID, p_customer_id: customerId });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    const { data, error } = await supabase.rpc('list_offers', {
      p_tenant_id: TENANT_ID,
      p_city: city || null,
      p_category: category || null,
      p_lat: lat ? parseFloat(lat) : null,
      p_lng: lng ? parseFloat(lng) : null,
      p_radius_km: radiusKm ? parseFloat(radiusKm) : null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
    return { statusCode: 200, body: JSON.stringify(await withOfferImages(supabase, TENANT_ID, data)) };
  } catch (err) {
    console.error('offers: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};