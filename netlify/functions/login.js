const { getSupabaseAdminClient } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { tenantSlug, internalCode, pin } = JSON.parse(event.body || '{}');
    if (!tenantSlug || !internalCode || !pin) {
      return { statusCode: 400, body: JSON.stringify({ error: 'tenantSlug, internalCode, pin obrigatórios' }) };
    }
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('auth_login', { p_tenant_slug: tenantSlug, p_internal_code: internalCode, p_pin: pin });
    if (error) return { statusCode: 401, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
    if (data && data.error) return { statusCode: 401, body: JSON.stringify({ error: data.error }) };
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
