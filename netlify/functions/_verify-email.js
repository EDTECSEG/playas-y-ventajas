const fs = require('fs');
const path = require('path');
const { getSupabaseAdminClient, buildCustomerToken } = require('./_supabaseAdmin');

function tenantHeader(supabase, tenantId) {
  return supabase.from('tenants').select('slug').eq('id', tenantId).single();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'email obrigat��rio' }) };
    const norm = String(email || '').trim().toLowerCase();
    if (norm.length > 254) return { statusCode: 400, body: JSON.stringify({ error: 'email inv�lido' }) };
    const stored = JSON.parse(fs.readFileSync(path.join(__dirname, 'otp.json'), 'utf8'));
    const token = stored[norm];
    if (!token) return { statusCode: 400, body: JSON.stringify({ error: 'token n�o encontrado para este email. Inicie o cadastro novamente.' }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
