import { getSupabaseAdminClient, buildCustomerToken, json } from './_shared.js';
import { buildCouponMessage, buildWaLink } from './_wa.js';

// Link de WhatsApp + crédito da indicação no resgate do cupom.
//
// DECISAO DO DONO (setembro/2026): a comunicação com o cliente é por WHATSAPP,
// nao por email. Motivo: o Resend ainda esta em modo de teste — o remetente
// onboarding@resend.dev so entrega para o proprio titular da conta, entao
// nenhum cliente real receberia nada. O WhatsApp via wa.me nao depende de
// dominio, de plano pago nem de aprovacao da Meta.
//
// ORDEM DELIBERADA: a claim_coupon (que mexe em estoque, limite e hash do
// token) roda PRIMEIRO e é intocada. O link de WhatsApp e o crédito da
// indicação são extras best-effort: se falharem, o cliente JÁ tem o cupom e a
// resposta continua 200. Nenhum extra pode derrubar um resgate.

// Busca título/empresa/telefone no servidor. A RPC claim_coupon NÃO devolve
// esses campos, e confiar no que o navegador manda para dentro da mensagem de
// WhatsApp seria permitir que o cliente escrevesse em nome do estabelecimento.
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

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { tenantId, templateId, phone, name, instagram, email } = await request.json();
    if (!tenantId || !templateId || !phone) return json({ error: 'tenantId, templateId, phone obrigatórios' }, 400);
    const supabase = getSupabaseAdminClient(env);

    // ---------- CAMINHO CRITICO (dinheiro). Nao tocar. ----------
    const { data, error } = await supabase.rpc('claim_coupon', {
      p_tenant_id: tenantId, p_template_id: templateId, p_customer_phone: phone, p_customer_name: name || '',
      p_customer_instagram: instagram || null, p_customer_email: email || null,
    });
    if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
    // ---------- FIM DO CAMINHO CRITICO ----------

    const publicId = data.publicId;
    const customerId = data.customerId;
    const extras = { whatsappUrl: null, referral: null, notes: [] };

    // Contexto da oferta (titulo/empresa/telefone) vem do banco, nao do
    // navegador: assim o cliente nao consegue escolher o conteudo da mensagem.
    let ctx = null;
    try {
      ctx = await loadOfferContext(supabase, templateId);
    } catch (e) {
      extras.notes.push('contexto indisponivel');
    }

    // (1) Credito da indicacao: best-effort, nunca lanca.
    try {
      const { data: ref, error: refErr } = await supabase.rpc('try_referral_convert', {
        p_tenant_id: tenantId, p_customer_id: customerId,
      });
      if (!refErr) extras.referral = { converted: ref === true, welcomeCouponId: null };
    } catch (e) { /* segue: resgate ja aconteceu */ }

    // (2) Link de WhatsApp (gratuito): conversa com a EMPRESA, com o codigo do
    // cupom ja escrito. Sem telefone da empresa, cai no atendimento do PYV.
    if (ctx) {
      try {
        extras.whatsappUrl = buildWaLink({
          phone: ctx.businessPhone,
          message: buildCouponMessage({
            publicId, businessName: ctx.businessName, title: ctx.title, shortCode: data.shortCode,
          }),
          fallbackPhone: null,
          fallbackMessage: buildCouponMessage({
            publicId, businessName: ctx.businessName, title: ctx.title, shortCode: data.shortCode,
          }),
        });
      } catch (e) { /* opcional */ }
    }

    return json({
      ...data,
      customerToken: await buildCustomerToken(env, customerId),
      ...extras,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
