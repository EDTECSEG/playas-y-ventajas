const { getSupabaseAdminClient, buildCustomerToken, rpcErrorCode } = require('./_supabaseAdmin');
const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

const { rateLimit, clientIp, tooManyAttempts } = require('./_rateLimit');

// 20 por minuto por IP. Generoso de proposito: no 4G/5G brasileiro o CGNAT
// coloca dezenas de pessoas atras do mesmo IP, e bloquear uma delas e pior do
// que deixar um robo passar um pouco mais devagar. O script continua barrado
// em ~99% das requisicoes.
const CLAIM_MAX = 20;
const CLAIM_WINDOW_MS = 60 * 1000;
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

// Canonico CJS, fonte unica: functions/.netlify/functions/ foi removido em 2026-09-30.
//
// DECISAO DO DONO (setembro/2026, reforcada em 2026-10-01): a comunicacao com
// o cliente e por WHATSAPP, e nao por email. O motivo original era o Resend
// estar em modo de teste -- onboarding@resend.dev so entrega para o proprio
// titular da conta, entao nenhum cliente real receberia nada. Em 2026-10-01 o
// envio por e-mail foi CORTAADO por completo (canal EMAIL removido de
// _notify.js, RESEND_API_KEY apagada do Pages): o motivo deixou de ser
// "ainda nao presta" e passou a ser "nao existe mais opcao". O wa.me nao
// depende de dominio, de plano pago nem de aprovacao da Meta.
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
    const { templateId, phone, name, instagram, email, ref, idempotencyKey } = JSON.parse(event.body || '{}');
    if (!templateId || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'templateId, phone obrigatórios' }) };
    const ip = clientIp(event);
    const limit = rateLimit(`claim:${ip}`, CLAIM_MAX, CLAIM_WINDOW_MS);
    if (!limit.allowed) return tooManyAttempts(limit.retryInMs);
    const supabase = getSupabaseAdminClient();

    // ---------- CAMINHO CRITICO (dinheiro). Nao tocar. ----------
    // Chave de idempotencia: o parametro e OPCIONAL na RPC (p_idempotency_key
    // DEFAULT NULL). Sem chave, o comportamento e o de antes, bit a bit.
    //
    // DIVERGENCIA PROPOSITAL de validate_and_redeem_coupon, que usa
    // `body.idempotencyKey || randomUUID()`. Aqui isso NAO pode ser copiado:
    // uma chave gerada no servidor e unica por requisicao, logo nunca sera
    // lida de volta por um replay. O efeito seria escrever uma linha em
    // idempotency_keys a CADA resgate -- guardando o rawToken do cupom em
    // texto claro, sem TTL e sem cleanup -- sem nunca converter um retry em
    // replay. Custo e retencao de segredo crescentes, beneficio zero.
    //
    // O cache so vale se a chave vier do CLIENTE e for estavel entre retries.
    // Por isso passamos a chave como veio, ou null.
    //
    // Tamanho limitado porque o valor e gravado em
    // idempotency_keys.idempotency_key (coluna text). Chave fora do formato
    // e degradada para null, o que devolve o resgate ao comportamento antigo.
    // Num caminho de dinheiro, degradar e melhor que devolver 400 e travar o
    // resgate do cliente por causa de um campo opcional.
    const rawKey = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    const idemKey = rawKey.length > 0 && rawKey.length <= 200 ? rawKey : null;
    const { data, error } = await supabase.rpc('claim_coupon', {
      p_tenant_id: TENANT_ID, p_template_id: templateId, p_customer_phone: phone, p_customer_name: name || '',
      p_customer_instagram: instagram || null, p_customer_email: email || null, p_idempotency_key: idemKey,
    });
    if (error) return { statusCode: 400, body: JSON.stringify({ error: rpcErrorCode(error) }) };
    // ---------- FIM DO CAMINHO CRITICO ----------

    // ---------- TAXA POR CUPOM (fase 2). Best-effort. ----------
    // Plano PER_COUPON: cada resgate acumula uma taxa em billing_charges para
    // cobranca manual do admin. Se a RPC falhar, o resgate ja aconteceu e a
    // resposta segue 200 — mesmo contrato do WhatsApp/indicacao abaixo.
    try {
      await supabase.rpc('billing_record_coupon_tax', {
        p_tenant_id: TENANT_ID, p_template_id: templateId, p_coupon_id: data.couponId,
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

    // ---------- INDICACAO (Modelo A). Best-effort e fail-open ----------
    // Codigo invalido nunca bloqueia o resgate: o resgate ja aconteceu.
    //
    // A ordem das duas RPCs importa e ja esteve errada de dois jeitos:
    //
    // 1. try_referral_convert era chamada ANTES de referral_track. Ela
    //    procurava uma indicacao PENDING que o track ainda nao tinha
    //    criado, devolvia false, e a indicacao ficava pending para
    //    sempre. O comentario aqui prometia o contrario ("deixa o
    //    try_referral_convert abaixo converter na mesma requisicao"), mas
    //    ele nao estava abaixo. Quem resgata sem ter passado antes pelo
    //    identify nao tem nenhuma outra chance de converter; o fluxo
    //    normal (identify -> claim) funcionava apenas porque o identify
    //    ja tinha registrado a indicacao antes.
    //
    // 2. Este bloco ficava DENTRO de `if (ctx)`. Se loadOfferContext
    //    falhasse, a indicacao nao era registrada nunca, sem erro e sem
    //    aviso -- e o contexto do cupom nao tem relacao com o codigo de
    //    indicacao. O resgate seguia 200 e o afiliado nunca soube.
    if (ref && customerId) {
      try {
        await supabase.rpc('referral_track', {
          p_tenant_id: TENANT_ID, p_referral_code: ref, p_referred_user_id: customerId,
        });
      } catch (e) { /* segue normal */ }
    }

    // Depois do track, nunca antes: e o track que cria a linha pending que
    // isto converte.
    //
    // O booleano da conversao nao se chama mais `ref`. O `ref` do request e
    // o codigo; o `ref` deste try era o booleano da conversao, e sombreava
    // o codigo no mesmo escopo. Dois nomes para a mesma coisa em linhas
    // separadas -- o jeito mais facil de alguem editar a variavel errada.
    try {
      const { data: converted, error: refErr } = await supabase.rpc('try_referral_convert', {
        p_tenant_id: TENANT_ID, p_customer_id: customerId,
      });
      if (!refErr) extras.referral = { converted: converted === true, welcomeCouponId: null };
    } catch (e) { /* segue: resgate ja aconteceu */ }

    if (ctx) {
      try {
        const message = buildCouponMessage({
          publicId, businessName: ctx.businessName, title: ctx.title,
          site: siteUrl(),
          referralCode: await findReferralCodeOfAffiliate(supabase, TENANT_ID, phone),
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
          tenantId: TENANT_ID,
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
