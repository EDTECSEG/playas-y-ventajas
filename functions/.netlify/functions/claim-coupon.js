import { getSupabaseAdminClient, json } from './_shared.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { tenantId, templateId, phone, name, instagram, email } = await request.json();
    if (!tenantId || !templateId || !phone) return json({ error: 'tenantId, templateId, phone obrigatórios' }, 400);
    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('claim_coupon', {
      p_tenant_id: tenantId, p_template_id: templateId, p_customer_phone: phone, p_customer_name: name || '',
      p_customer_instagram: instagram || null, p_customer_email: email || null,
    });
    if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
    return json(data);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
