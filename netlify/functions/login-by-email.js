const { getSupabaseAdminClient } = require('./_supabaseAdmin');
const { isValidOtp } = require('./_otp');

// Canon CJS. Espelho ESM: functions/.netlify/functions/login-by-email.js
//
// Login por email + OTP, para quem cadastrou a empresa com email.
//
// DIFERENCA REAL ENTRE OS DOIS ESPELHOS (nao e traducao mecanica):
//   - CJS  isValidOtp(email, code)         -> SINCRONO, le o segredo de process.env
//   - ESM  isValidOtp(env, email, code)    -> ASSINCRONO (crypto.subtle), le de env
// Por isso aqui NAO se faz await e NAO se passa env. Copiar o `await isValidOtp(env, ...)`
// do espelho ESM para ca deixaria isValidOtp retornando sempre false, porque
// `env` cairia na posicao de `email` e o code em `code` nunca casaria.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'INVALID_JSON' }) };
  }

  const { tenantSlug, email, emailOtp } = body || {};
  const slug = String(tenantSlug || '').trim();
  const norm = String(email || '').trim().toLowerCase();

  if (!slug) return { statusCode: 400, body: JSON.stringify({ error: 'TENANT_SLUG_REQUIRED' }) };
  if (!norm) return { statusCode: 400, body: JSON.stringify({ error: 'EMAIL_REQUIRED' }) };
  if (!emailOtp) return { statusCode: 400, body: JSON.stringify({ error: 'EMAIL_OTP_REQUIRED' }) };

  if (!isValidOtp(norm, emailOtp)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'EMAIL_OTP_INVALID' }) };
  }

  try {
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase.rpc('auth_login_by_email', {
      p_tenant_slug: slug,
      p_email: norm,
    });

    if (error) {
      return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
    }
    if (data && data.error) {
      return { statusCode: 401, body: JSON.stringify({ error: data.error }) };
    }
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
