import { getSupabaseAdminClient, json } from './_shared.js';

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const affiliateId = url.searchParams.get('affiliateId');
    const phone = url.searchParams.get('phone');
    if (!affiliateId || !phone) return json({ error: 'affiliateId e phone obrigatórios' }, 400);
    const supabase = getSupabaseAdminClient(env);
    const { data, error } = await supabase.rpc('affiliate_dashboard', {
      p_tenant_id: TENANT_ID, p_affiliate_id: affiliateId, p_phone: phone,
    });
    if (error) return json({ error: error.message }, 400);
    return json(data || {});
  } catch (err) {
    console.error('affiliates: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { name, phone, email, kind } = await request.json();
    if (!name || !phone) return json({ error: 'nome e telefone obrigatórios' }, 400);
    const supabase = getSupabaseAdminClient(env);
    // Idempotente por telefone: o mesmo cliente nunca cria afiliado duplicado.
    // O card de /cliente chama este endpoint a cada 'indicar amigo'.
    const { data: existing, error: lookErr } = await supabase
      .from('affiliates')
      .select('id, referral_code')
      .eq('tenant_id', TENANT_ID)
      .eq('phone', phone)
      .maybeSingle();
    if (!lookErr && existing) {
      return json({ affiliateId: existing.id, referralCode: existing.referral_code, shareUrl: '/?ref=' + existing.referral_code });
    }
    const { data, error } = await supabase.rpc('affiliate_register', {
      p_tenant_id: TENANT_ID, p_name: name, p_phone: phone,
      p_email: email || null, p_kind: kind || 'customer',
    });
    if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
    return json(data);
  } catch (err) {
    console.error('affiliates: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}