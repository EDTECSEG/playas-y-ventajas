import { getSupabaseAdminClient, json } from './_shared.js';

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { phone, name, email, instagram } = await request.json();
    if (!phone) return json({ error: 'telefone obrigatório' }, 400);
    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('identify_customer', {
      p_tenant_id: TENANT_ID, p_phone: phone, p_name: name || null, p_email: email || null, p_instagram: instagram || null,
    });
    if (error) return json({ error: error.message }, 400);
    return json({ customerId: data });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
