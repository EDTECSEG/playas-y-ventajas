import { getSupabaseAdminClient, json } from './_shared.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { tenantSlug, internalCode, pin } = await request.json();
    if (!tenantSlug || !internalCode || !pin) {
      return json({ error: 'tenantSlug, internalCode, pin obrigatórios' }, 400);
    }
    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('auth_login', { p_tenant_slug: tenantSlug, p_internal_code: internalCode, p_pin: pin });
    if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 401);
    if (data && data.error) return json({ error: data.error }, 401);
    return json(data);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
