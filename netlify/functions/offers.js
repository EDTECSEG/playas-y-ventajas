const { getSupabaseAdminClient, verifyCustomerToken } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  try {
    const { tenantId, customerId, customerToken, mode, businessLogoFor } = event.queryStringParameters || {};
    if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId obrigatório' }) };
    const supabase = getSupabaseAdminClient();

    if (businessLogoFor) {
      const { data, error } = await supabase.rpc('business_logo_by_id', { p_business_id: businessLogoFor });
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

    const { data, error } = await supabase.rpc('list_offers', { p_tenant_id: tenantId });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};