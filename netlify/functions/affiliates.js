// Afiliados (Modelo A - recompensa em cupom).
// Publico, sem sessao: o vinculo e por telefone.
//   POST /  { name, phone, email?, kind? }   -> affiliate_register
//   GET  /?affiliateId=..&phone=..           -> affiliate_dashboard
const { getSupabaseAdminClient } = require('./_supabaseAdmin');

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdminClient();

    if (event.httpMethod === 'POST') {
      const { name, phone, email, kind } = JSON.parse(event.body || '{}');
      if (!name || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'nome e telefone obrigatórios' }) };
      // Idempotente por telefone: o mesmo cliente nunca cria afiliado duplicado.
      // O card de /cliente chama este endpoint a cada 'indicar amigo'.
      const { data: existing, error: lookErr } = await supabase
        .from('affiliates')
        .select('id, referral_code')
        .eq('tenant_id', TENANT_ID)
        .eq('phone', phone)
        .maybeSingle();
      if (!lookErr && existing) {
        return { statusCode: 200, body: JSON.stringify({ affiliateId: existing.id, referralCode: existing.referral_code, shareUrl: '/?ref=' + existing.referral_code }) };
      }
      const { data, error } = await supabase.rpc('affiliate_register', {
        p_tenant_id: TENANT_ID, p_name: name, p_phone: phone,
        p_email: email || null, p_kind: kind || 'customer',
      });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'GET') {
      const { affiliateId, phone } = event.queryStringParameters || {};
      if (!affiliateId || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'affiliateId e phone obrigatórios' }) };
      const { data, error } = await supabase.rpc('affiliate_dashboard', {
        p_tenant_id: TENANT_ID, p_affiliate_id: affiliateId, p_phone: phone,
      });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
      // Sem match de telefone/afiliado o dashboard vem null: devolve vazio.
      return { statusCode: 200, body: JSON.stringify(data || {}) };
    }

    return { statusCode: 405, body: '{}' };
  } catch (err) {
    console.error('affiliates: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};