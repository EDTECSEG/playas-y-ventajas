import { getSupabaseAdminClient, json } from './_shared.js';
import { isValidOtp } from './_otp.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'INVALID_JSON' }, 400); }
  const { tenantSlug, email, emailOtp } = body || {};
  const slug = (tenantSlug || '').trim();
  const norm = (email || '').trim().toLowerCase();
  if (!slug) return json({ error: 'TENANT_SLUG_REQUIRED' }, 400);
  if (!norm) return json({ error: 'EMAIL_REQUIRED' }, 400);
  if (!emailOtp) return json({ error: 'EMAIL_OTP_REQUIRED' }, 400);
  if (!(await isValidOtp(env, norm, emailOtp))) {
    return json({ error: 'EMAIL_OTP_INVALID' }, 401);
  }
  const lat = body.lat === null || body.lat === undefined || body.lat === '' ? null : Number(body.lat);
  const lng = body.lng === null || body.lng === undefined || body.lng === '' ? null : Number(body.lng);
  const supabase = getSupabaseAdminClient(env);
  const { data, error } = await supabase.rpc('register_business_by_email', {
    p_tenant_slug: slug, p_email: norm, p_name: body.name || null, p_category: body.category || null,
    p_city: body.city || null, p_phone: body.phone || null, p_cnpj: body.cnpj || null,
    p_website: body.website || null, p_logo_url: body.logoUrl || null, p_lat: lat, p_lng: lng,
    p_internal_code: body.internalCode || null, p_pin: body.pin || null,
  });
  if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
  if (data && data.error) return json({ error: data.error }, 400);
  return json(data);
}