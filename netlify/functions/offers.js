const { getSupabaseAdminClient } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  try {
    const { tenantId, customerId, mode } = event.queryStringParameters || {};
    if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId obrigatório' }) };
    const supabase = getSupabaseAdminClient();

    if (mode === 'my-coupons') {
      if (!customerId) return { statusCode: 400, body: JSON.stringify({ error: 'customerId obrigatório' }) };
      const { data, error } = await supabase.rpc('list_customer_coupons', { p_tenant_id: tenantId, p_customer_id: customerId });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    const { data, error } = await supabase.rpc('list_offers', { p_tenant_id: tenantId });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
