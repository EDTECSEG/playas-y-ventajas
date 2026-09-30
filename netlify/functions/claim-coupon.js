const { getSupabaseAdminClient, buildCustomerToken } = require('./_supabaseAdmin');
const { buildCouponMessage, buildWaLink, siteUrl } = require('./_wa');
const { notifyOutbound } = require('./_notify');

// Codigo de indicacao de quem resgatou, quando essa pessoa tambem e afiliada.
// A comparacao e por DIGITOS do telefone (coluna gerada phone_digits): o
// telefone vem do navegador como a pessoa digitou. Antes nao havia essa
// informacao na mensagem; o dono pediu o link de filiacao junto do site.
// Falha aqui e inofensiva: a linha simplesmente nao entra na mensagem.
async function findReferralCodeOfAffiliate(supabase, tenantId, phone) {
  try {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    const { data, error } = await supabase
      .from('affiliates')
      .select('referral_code')
      .eq('tenant_id', tenantId)
      .eq('phone_digits', digits)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data.referral_code || null;
  } catch (e) {
    return null;
  }
}

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
    const { tenantId, templateId, phone, name, instagram, email, ref } = JSON.parse(event.body || '{}');
    if (!tenantId || !templateId || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'tenantId, templateId, phone obrigatórios' }) };
    const supabase = getSupabaseAdminClient();

    // ---------- CAMINHO CRITICO (dinheiro). Nao tocar. ----------
    const { data, error } = await supabase.rpc('claim_coupon', {
      p_tenant_id: tenantId, p_template_id: templateId, p_customer_phone: phone, p_customer_name: name || '',
      p_customer_instagram: instagram || null, p_customer_email: email || null,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
    // ---------- FIM DO CAMINHO CRITICO ----------

    // ---------- TAXA POR CUPOM (fase 2). Best-effort. ----------
    // Plano PER_COUPON: cada resgate acumula uma taxa em billing_charges para
    // cobranca manual do admin. Se a RPC falhar, o resgate ja aconteceu e a
    // resposta segue 200 — mesmo contrato do WhatsApp/indicacao abaixo.
    try {
      await supabase.rpc('billing_record_coupon_tax', {
        p_tenant_id: tenantId, p_template_id: templateId, p_coupon_id: data.couponId,
      });
    } catch (e) { /* opcional: cobranca acumulada depois */ }

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
// Indicacao (Modelo A): se o cliente ainda nao foi vinculado a um
    // codigo (claim aconteceu antes do identify), registra agora e deixa
    // o try_referral_convert abaixo converter na mesma requisicao.
    // Best-effort e fail-open: codigo invalido nunca bloqueia o resgate.
    if (ref && customerId) {
      try {
        await supabase.rpc('referral_track', {
          p_tenant_id: tenantId, p_referral_code: ref, p_referred_user_id: customerId,
        });
      } catch (e) { /* segue normal */ }
    }

    try {
        const message = buildCouponMessage({
          publicId, businessName: ctx.businessName, title: ctx.title,
          site: siteUrl(),
          referralCode: await findReferralCodeOfAffiliate(supabase, tenantId, phone),
        });
        extras.whatsappUrl = buildWaLink({ phone: ctx.businessPhone, message, fallbackMessage: message });
      } catch (e) { /* opcional */ }
    }

    // ---------- AVISO AO CLIENTE (base de notificacoes). Best-effort. ----------
    // Dispara DEPOIS da taxa e do wa.me, ou seja, fora do caminho critico e
    // depois de tudo que a resposta precisa. Sem provedor configurado (default)
    // isto so grava provider='none'/status='noop' e loga; com provedor, envia e
    // marca sent/failed. Em qualquer falha — RPC, rede, timeout — o resgate ja
    // aconteceu: o status, o corpo e o whatsappUrl sao os mesmos de sempre.
    //
    // Contexto (titulo/empresa) vem do BANCO, via loadOfferContext acima. Nao
    // entra nada do corpo do request no conteudo da mensagem.
    try {
      await notifyOutbound(supabase, {
        event: 'coupon_claimed',
        channel: 'WHATSAPP',
        customerId: customerId,
        couponId: data.couponId,
        vars: {
          tenantId: tenantId,
          title: ctx ? ctx.title : '',
          businessName: ctx ? ctx.businessName : '',
          publicId: publicId,
          shortCode: data.shortCode,
        },
      });
    } catch (e) { /* opcional: o aviso nunca derruba o resgate */ }

    return {
      statusCode: 200,
      body: JSON.stringify({ ...data, customerToken: buildCustomerToken(customerId), ...extras }),
    };
  } catch (err) {
    console.error('claim-coupon: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};
