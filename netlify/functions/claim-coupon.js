const { getSupabaseAdminClient } = require('./_supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { tenantId, templateId, phone, name, instagram, email } = JSON.parse(event.body || '{}');
    if (!tenantId || !templateId || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, templateId, phone obrigatórios' }) };
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('claim_coupon', {
      p_tenant_id: tenantId, p_template_id: templateId, p_customer_phone: phone, p_customer_name: name || '',
      p_customer_instagram: instagram || null, p_customer_email: email || null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
