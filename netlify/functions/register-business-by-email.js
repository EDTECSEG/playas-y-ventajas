const { getSupabaseAdminClient } = require('./_supabaseAdmin');
const { isValidOtp } = require('./_otp');

// Canon CJS. Espelho ESM: functions/.netlify/functions/register-business-by-email.js
//
// Cadastro de empresa por email + OTP.
//
// DIFERENCA REAL ENTRE OS DOIS ESPELHOS (nao e traducao mecanica):
//   - CJS  isValidOtp(email, code)      -> SINCRONO, segredo em process.env
//   - ESM  isValidOtp(env, email, code) -> ASSINCRONO (crypto.subtle), segredo de env
// Aqui nao se faz await e nao se passa env. Ver login-by-email.js para o porquê.

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

  const lat = body.lat === null || body.lat === undefined || body.lat === '' ? null : Number(body.lat);
  const lng = body.lng === null || body.lng === undefined || body.lng === '' ? null : Number(body.lng);

  try {
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase.rpc('register_business_by_email', {
      p_tenant_slug: slug,
      p_email: norm,
      p_name: body.name || null,
      p_category: body.category || null,
      p_city: body.city || null,
      p_phone: body.phone || null,
      p_cnpj: body.cnpj || null,
      p_website: body.website || null,
      p_logo_url: body.logoUrl || null,
      p_lat: lat,
      p_lng: lng,
      p_internal_code: body.internalCode || null,
      p_pin: body.pin || null,
    });

    if (error) {
      return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
    }
    if (data && data.error) {
      return { statusCode: 400, body: JSON.stringify({ error: data.error }) };
    }
    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
