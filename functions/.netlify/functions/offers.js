import { getSupabaseAdminClient, verifyCustomerToken, json } from './_shared.js';

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

    const { data, error } = await supabase.rpc('list_offers', { p_tenant_id: tenantId });
    if (error) return json({ error: error.message }, 400);
    return json(data);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}