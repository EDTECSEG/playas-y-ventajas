const { getSupabaseAdminClient } = require('./_supabaseAdmin');

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { phone, name, email, instagram } = JSON.parse(event.body || '{}');
    if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'telefone obrigatório' }) };
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('identify_customer', {
      p_tenant_id: TENANT_ID, p_phone: phone, p_name: name || null, p_email: email || null, p_instagram: instagram || null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify({ customerId: data }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
