const { getSupabaseAdminClient, buildCustomerToken } = require('./_supabaseAdmin');
const { buildCouponMessage, buildWaLink } = require('./_wa');

// Canon CJS. Espelho ESM: functions/.netlify/functions/claim-coupon.js
//
// DECISAO DO DONO (setembro/2026): a comunicacao com o cliente e por WHATSAPP,
// nao por email. Motivo: o Resend esta em modo de teste — o remetente
// onboarding@resend.dev so entrega para o proprio titular da conta, entao
// nenhum cliente real receberia nada. O wa.me nao depende de dominio, de
// plano pago nem de aprovacao da Meta.
//
// ORDEM DELIBERADA: a claim_coupon (dinheiro: estoque, limite, hash) roda
// PRIMEIRO e e intocada. WhatsApp e indicacao sao extras best-effort: se
// falharem, o cliente ja tem o cupom e a resposta e 200.
//
// NOTA HISTORICA: a versao anterior montava um email com data.title /
// data.businessName, mas a RPC claim_coupon so devolve (couponId, publicId,
// rawToken, shortCode, customerId) — esses campos eram SEMPRE undefined, ou
// seja, o email sairia em branco. O contexto agora vem do banco.
async function loadOfferContext(supabase, templateId) {
  const { data, error } = await supabase
    .from('coupon_templates')
    .select('id, title, business_id, businesses(name, phone)')
    .eq('id', templateId)
    .maybeSingle();
  if (error || !data) return null;
  const biz = Array.isArray(data.businesses) ? data.businesses[0] : data.businesses;
  return {
    title: data.title || 'Seu cupom',
    businessName: (biz && biz.name) || '',
    businessPhone: (biz && biz.phone) || null,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { tenantId, templateId, phone, name, instagram, email } = JSON.parse(event.body || '{}');
    if (!tenantId || !templateId || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, templateId, phone obrigatórios' }) };
    const supabase = getSupabaseAdminClient();

    // ---------- CAMINHO CRITICO (dinheiro). Nao tocar. ----------
    const { data, error } = await supabase.rpc('claim_coupon', {
      p_tenant_id: tenantId, p_template_id: templateId, p_customer_phone: phone, p_customer_name: name || '',
      p_customer_instagram: instagram || null, p_customer_email: email || null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
    // ---------- FIM DO CAMINHO CRITICO ----------

    const publicId = data.publicId;
    const customerId = data.customerId;
    const extras = { whatsappUrl: null, referral: null, notes: [] };

    // Contexto vem do banco, nao do navegador: senao o cliente poderia
    // escrever qualquer coisa na mensagem em nome do estabelecimento.
    let ctx = null;
    try { ctx = await loadOfferContext(supabase, templateId); }
    catch (e) { extras.notes.push('contexto indisponivel'); }

    try {
      const { data: ref, error: refErr } = await supabase.rpc('try_referral_convert', {
        p_tenant_id: tenantId, p_customer_id: customerId,
      });
      if (!refErr) extras.referral = { converted: ref === true, welcomeCouponId: null };
    } catch (e) { /* segue: resgate ja aconteceu */ }

    if (ctx) {
      try {
        const message = buildCouponMessage({
          publicId, businessName: ctx.businessName, title: ctx.title, shortCode: data.shortCode,
        });
        extras.whatsappUrl = buildWaLink({ phone: ctx.businessPhone, message, fallbackMessage: message });
      } catch (e) { /* opcional */ }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ...data, customerToken: buildCustomerToken(customerId), ...extras }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
