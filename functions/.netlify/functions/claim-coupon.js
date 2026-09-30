import { getSupabaseAdminClient, buildCustomerToken, json } from './_shared.js';
import { buildCouponMessage, buildWaLink } from './_wa.js';
import { notifyOutbound } from './_notify.js';

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
    const { tenantId, templateId, phone, name, instagram, email, ref } = await request.json();
    if (!tenantId || !templateId || !phone) return json({ error: 'tenantId, templateId, phone obrigatórios' }, 400);
    const supabase = getSupabaseAdminClient(env);

    // ---------- CAMINHO CRITICO (dinheiro). Nao tocar. ----------
    const { data, error } = await supabase.rpc('claim_coupon', {
      p_tenant_id: tenantId, p_template_id: templateId, p_customer_phone: phone, p_customer_name: name || '',
      p_customer_instagram: instagram || null, p_customer_email: email || null,
    });
    if (error) return json({ error: (error.message || '').split(':')[0].trim() }, 400);
    // ---------- FIM DO CAMINHO CRITICO ----------

    // ---------- TAXA POR CUPOM (fase 2). Best-effort. ----------
    // Plano PER_COUPON: cada resgate acumula uma taxa em billing_charges para
    // cobrança manual do admin. Se a RPC falhar, o resgate JÁ aconteceu e a
    // resposta continua 200 — mesmo contrato do WhatsApp/indicação abaixo.
    try {
      await supabase.rpc('billing_record_coupon_tax', {
        p_tenant_id: tenantId, p_template_id: templateId, p_coupon_id: data.couponId,
      });
    } catch (e) { /* opcional: cobrança acumulada depois */ }

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

    // (1b) Indicacao (Modelo A): vincula o codigo se o claim aconteceu antes
    // do identify; o try_referral_convert abaixo converte na mesma requisicao.
    if (ref && customerId) {
      try {
        await supabase.rpc('referral_track', {
          p_tenant_id: tenantId, p_referral_code: ref, p_referred_user_id: customerId,
        });
      } catch (e) { /* segue normal */ }
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

    // ---------- AVISO AO CLIENTE (base de notificacoes). Best-effort. ----------
    // Dispara DEPOIS da taxa e do wa.me, ou seja, fora do caminho critico e
    // depois de tudo que a resposta precisa. Sem provedor configurado (default)
    // isto so grava provider='none'/status='noop' e loga; com provedor, envia e
    // marca sent/failed. Em qualquer falha — RPC, rede, timeout — o resgate ja
    // aconteceu: o status, o corpo e o whatsappUrl sao os mesmos de sempre.
    //
    // `env` e' o objeto de configuracao do Cloudflare Pages: sem ele o
    // adaptador cairia em process.env e em 'none', que e' o default seguro.
    // Contexto (titulo/empresa) vem do BANCO, via loadOfferContext acima.
    try {
      await notifyOutbound(supabase, {
        event: 'coupon_claimed',
        channel: 'WHATSAPP',
        customerId: customerId,
        couponId: data.couponId,
        env: env,
        vars: {
          tenantId: tenantId,
          title: ctx ? ctx.title : '',
          businessName: ctx ? ctx.businessName : '',
          publicId: publicId,
          shortCode: data.shortCode,
        },
      });
    } catch (e) { /* opcional: o aviso nunca derruba o resgate */ }

    return json({
      ...data,
      customerToken: await buildCustomerToken(env, customerId),
      ...extras,
    });
  } catch (err) {
    console.error('claim-coupon: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}
