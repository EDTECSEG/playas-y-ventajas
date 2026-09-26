// Identifica/cadastra o cliente. Quando email for fornecido, EXIGE o OTP de
// 6 digitos que foi enviado a ESTE email (via send-otp) ï¿½?" impede cadastrar
// telefone/email/instagram aleatorio que nao pertence ao cliente.
const { getSupabaseAdminClient, buildCustomerToken } = require('./_supabaseAdmin');
const { isValidOtp } = require('./_otp');

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { phone, name, email, instagram, emailOtp, emailCode } = JSON.parse(event.body || '{}');
    if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'telefone obrigat\u00f3rio' }) };
    if (email && !isValidOtp(email, emailOtp)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'c\u00f3digo de email inv\u00e1lido ou expirado. Solicite um novo c\u00f3digo.' }) };
    }
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('identify_customer', {
      p_tenant_id: TENANT_ID, p_phone: phone, p_name: name || null, p_email: email || null, p_instagram: instagram || null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, body: JSON.stringify({ customerId: data, customerToken: buildCustomerToken(data) }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
