// Identifica/cadastra o cliente. O email e guardado como dado opcional, sem
// verificacao: o envio de email e o OTP foram removidos (ver
// SECURITY-DECISIONS.md). A identidade valida do cliente e o telefone.
const { getSupabaseAdminClient, buildCustomerToken } = require('./_supabaseAdmin');

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { phone, name, email, instagram, ref } = JSON.parse(event.body || '{}');
    if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'telefone obrigat\u00f3rio' }) };
    const supabase = getSupabaseAdminClient();
    const { data, error } = await supabase.rpc('identify_customer', {
      p_tenant_id: TENANT_ID, p_phone: phone, p_name: name || null, p_email: email || null, p_instagram: instagram || null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };

    // Vincula cliente <-> afiliado (migration affiliate-link-customer).
    // Se o telefone recem-identificado tambem e afiliado, guarda o
    // customer_id no cadastro do afiliado: e ele que permite
    // grant_coupon_internal creditar o premio da indicacao, que sem
    // esse campo sairia sempre NULL.
    //
    // Best-effort e depois do cadastro, nunca antes: o cliente ja esta
    // criado quando isto roda, e qualquer erro aqui e engolido dentro
    // da propria RPC. O cadastro do cliente tem de funcionar com ou
    // sem este vinculo.
    try {
      await supabase.rpc('link_affiliate_customer', {
        p_tenant_id: TENANT_ID, p_customer_id: data,
      });
    } catch (e) { /* vinculo e um extra, nao o motivo do cadastro */ }

    // Indicacao (Modelo A): se veio com ?ref=CODIGO, registra no modulo 3.
    // Best-effort e fail-open: um codigo invalido nunca bloqueia o cadastro.
    let referral = null;
    if (data && ref) {
      const { error: refErr } = await supabase.rpc('referral_track', {
        p_tenant_id: TENANT_ID, p_referral_code: ref, p_referred_user_id: data,
      });
      referral = refErr ? null : { code: ref };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ customerId: data, customerToken: buildCustomerToken(data), referral }),
    };
  } catch (err) {
    console.error('identify: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};
