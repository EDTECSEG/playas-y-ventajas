import { getSupabaseAdminClient, buildCustomerToken, json } from './_shared.js';

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { phone, name, email, instagram, ref } = await request.json();
    if (!phone) return json({ error: 'telefone obrigatório' }, 400);
    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('identify_customer', {
      p_tenant_id: TENANT_ID, p_phone: phone, p_name: name || null, p_email: email || null, p_instagram: instagram || null,
    });
    if (error) return json({ error: error.message }, 400);

    let referral = null;
    if (data && ref) {
      const { error: refErr } = await supabase.rpc('referral_track', {
        p_tenant_id: TENANT_ID, p_referral_code: ref, p_referred_user_id: data,
      });
      referral = refErr ? null : { code: ref };
    }

    return json({ customerId: data, customerToken: await buildCustomerToken(env, data), referral });
  } catch (err) {
    console.error('identify: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}
