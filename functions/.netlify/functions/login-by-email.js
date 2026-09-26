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
  const supabase = getSupabaseAdminClient(env);
  const { data, error } = await supabase.rpc('auth_login_by_email', { p_tenant_slug: slug, p_email: norm });
  if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
  if (data && data.error) return json({ error: data.error }, 401);
  return json(data);
}