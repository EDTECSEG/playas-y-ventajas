const { normalizePhone } = require('./_wa');

// Base de notificacoes (fila + auditoria) do cliente. Canon CJS.
// Espelho ESM: functions/.netlify/functions/_notify.js
//
// O QUE ESTE MODULO E': o gancho best-effort que registra/encaminha o aviso
// ao cliente quando ele resgata um cupom (e, no futuro, quando uma reserva de
// translado for confirmada). NADA mais.
//
// POR QUE O DEFAULT E' NO-OP: o envio real depende de credencial do dono
// (WhatsApp Cloud API exige conta verificada + template aprovado; SMTP exigiria
// uma lib nova, Ask first). Sem env, o comportamento observavel e' UMA linha em
// outbound_messages com provider='none'/status='noop' e UM console.info sem PII.
// O resgate ja aconteceu quando isto roda, entao aviso nenhum pode derrubar
// o 200 nem alterar o corpo da resposta.
//
// REGRAS QUE ESTE ARQUIVO NAO QUEBRA:
//   - NUNCA lanca: qualquer erro (RPC, provedor, rede) e' engolido e devolvido
//     como { status }. O chamador nao precisa nem de try/catch (mas o handler
//     tem, por defense in depth).
//   - Conteudo da mensagem vem do BANCO (vars montadas por loadOfferContext).
//     Nunca do corpo do request: o cliente nao escreve em nome do establecimento.
//   - Segredo (WHATSAPP_TOKEN / SMTP_PASSWORD) vive so no servidor, entra na
//     chamada HTTP do provedor e nunca sai em log, resposta ou auditoria.
//   - Erro de terceiro vira CODIGO curto (error_code), nunca mensagem crua.

const CHANNEL_WHATSAPP = 'WHATSAPP';
const CHANNEL_EMAIL = 'EMAIL';

// Limites obrigatorios do adaptador (ver SPEC-notificacoes.md).
const MAX_BODY_CHARS = 1000;
const ATTEMPT_TIMEOUT_MS = 2000;
const MAX_ATTEMPTS = 2;
const WA_GRAPH_VERSION = 'v20.0';

// Provider que realmente tem transporte nesta leva. 'smtp' fica de fora de
// proposito: enviar email exigiria nodemailer (Ask first) e nao ha transporte
// HTTP para SMTP. Com EMAIL_PROVIDER=smtp configurado, a linha entra na
// auditoria como noop — rastreavel, sem inventar um envio que nao saiu.
const CAN_DELIVER = { whatsapp_cloud_api: true, smtp: false };

function pickEnv(explicit) {
  if (explicit && typeof explicit === 'object') return explicit;
  if (typeof process !== 'undefined' && process && process.env) return process.env;
  return {};
}

function normalizeChannel(raw) {
  const c = String(raw || '').trim().toUpperCase();
  return c === CHANNEL_WHATSAPP || c === CHANNEL_EMAIL ? c : '';
}

// Seletor de provedor, avaliado NA CHAMADA (env pode aparecer a qualquer
// momento). Ausente qualquer pre-requisito => 'none'.
function resolveProvider(channel, env) {
  if (channel === CHANNEL_WHATSAPP) {
    const wanted = String(env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
    if (wanted && wanted !== 'none' && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
      return 'whatsapp_cloud_api';
    }
    return 'none';
  }
  if (channel === CHANNEL_EMAIL) {
    const wanted = String(env.EMAIL_PROVIDER || '').trim().toLowerCase();
    if (wanted && wanted !== 'none' && env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD) return 'smtp';
    return 'none';
  }
  return 'none';
}

function renderSubject(event) {
  if (event === 'coupon_claimed') return 'Seu cupom esta pronto';
  if (event === 'shuttle_booking_confirmed') return 'Sua reserva foi confirmada';
  return 'Playas y Ventajas';
}

// Corpo montado so com dado do banco. Sem token, sem codigo interno de negocio.
function renderBody(event, vars) {
  const linhas = [];
  if (event === 'coupon_claimed') {
    linhas.push('Ola! Seu cupom do Playas y Ventajas foi liberado.');
    if (vars.title) linhas.push('Cupom: ' + vars.title);
    if (vars.businessName) linhas.push('Estabelecimento: ' + vars.businessName);
    if (vars.publicId) linhas.push('Codigo: ' + vars.publicId);
    // O codigo curto saiu daqui pelo mesmo motivo da mensagem de WhatsApp:
    // ninguem no balcao consegue digitar (nao ha campo, e o codigo longo ja
    // autoriza sozinho). Ver _wa.js.
    linhas.push('Mostre o codigo no balcao para usar.');
  } else if (event === 'shuttle_booking_confirmed') {
    linhas.push('Sua reserva de translado foi confirmada.');
    if (vars.bookingRef) linhas.push('Reserva: ' + vars.bookingRef);
    if (vars.businessName) linhas.push('Estabelecimento: ' + vars.businessName);
  } else {
    linhas.push('Novidade no Playas y Ventajas.');
  }
  return linhas.join('\n').slice(0, MAX_BODY_CHARS);
}

// Contato do cliente SEMPRE resolvido no servidor. Preferimos o que o contexto
// ja trouxe (do banco) e, se faltar, lemos em users pelo customerId devolvido
// pela RPC. O telefone do request nunca entra aqui.
async function readCustomerContact(supabase, customerId) {
  if (!supabase || !customerId) return null;
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, phone, email')
      .eq('id', customerId)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) {
    return null;
  }
}

async function resolveDestination(supabase, channel, customerId, vars) {
  if (channel === CHANNEL_WHATSAPP) {
    let raw = vars.phone || vars.customerPhone || null;
    if (!raw && customerId) {
      const row = await readCustomerContact(supabase, customerId);
      raw = row && row.phone;
    }
    return normalizePhone(raw); // '' quando nao ha telefone: sem excecao, so sem envio
  }
  let raw = vars.email || vars.customerEmail || null;
  if (!raw && customerId) {
    const row = await readCustomerContact(supabase, customerId);
    raw = row && row.email;
  }
  const value = String(raw || '').trim().toLowerCase();
  return value.indexOf('@') > 0 ? value : '';
}

// Única escrita do módulo. Devolve { ok, inserted, id } sem nunca lancar.
async function enqueue(supabase, payload) {
  const { data, error } = await supabase.rpc('outbound_enqueue', {
    p_tenant_id: payload.tenantId,
    p_event: payload.event,
    p_channel: payload.channel,
    p_destination: payload.destination,
    p_subject: payload.subject,
    p_body: payload.body,
    p_customer_id: payload.customerId,
    p_coupon_id: payload.couponId,
    p_booking_ref: payload.bookingRef,
    p_provider: payload.provider,
    p_status: payload.status,
  });
  if (error) return { ok: false, inserted: false, id: null };
  // A RPC pode devolver boolean (contrato antigo) ou { inserted, id }.
  const inserted = data === true || !!(data && data.inserted === true);
  const id = data && typeof data === 'object' && data.id ? data.id : null;
  return { ok: true, inserted, id };
}

// Best-effort de verdade: falhar aqui só significa que a auditoria ficou para
// tras. Nunca propaga.
async function mark(supabase, rpcName, args) {
  try {
    await supabase.rpc(rpcName, args);
  } catch (e) { /* sem efeito colateral */ }
}

function sendWhatsAppOnce(env, destination, body, fetchImpl) {
  const url = 'https://graph.facebook.com/' + WA_GRAPH_VERSION + '/'
    + encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID) + '/messages';
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + env.WHATSAPP_TOKEN,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destination,
      type: 'text',
      text: { body: body },
    }),
  });
}

// Timeout por tentativa (2s), no maximo 2 tentativas. Erro vira CODIGO:
// a mensagem crua do provedor nunca sai daqui.
async function deliverWhatsApp(env, destination, body) {
  const fetchImpl = typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function'
    ? globalThis.fetch.bind(globalThis)
    : null;
  if (!fetchImpl) return { ok: false, errorCode: 'NO_TRANSPORT' };

  let errorCode = 'DELIVERY_FAILED';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await sendWhatsAppOnce(env, destination, body, (url, init) => (
        fetchImpl(url, Object.assign({}, init, { signal: controller.signal }))
      ));
      if (res && res.ok) {
        let parsed = null;
        try { parsed = await res.json(); } catch (e) { parsed = null; }
        const providerMessageId = parsed && parsed.messages && parsed.messages[0]
          ? parsed.messages[0].id || null
          : null;
        return { ok: true, providerMessageId };
      }
      errorCode = 'HTTP_' + (res && res.status ? res.status : 0);
    } catch (e) {
      errorCode = (e && e.name === 'AbortError') ? 'TIMEOUT' : 'NETWORK_ERROR';
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, errorCode };
}

/**
 * Registra (e, se houver provedor, envia) o aviso do cliente.
 * NUNCA lanca. Devolve { status, id, provider }.
 */
async function notifyOutbound(supabase, opts = {}) {
  const vars = opts.vars || {};
  const env = pickEnv(opts.env);
  const channel = normalizeChannel(opts.channel);
  const event = String(opts.event || '').trim();
  const tenantId = vars.tenantId || opts.tenantId || null;
  let provider = 'none';

  try {
    if (!event || !channel || !tenantId || !supabase) {
      return { status: 'skipped', id: null, provider };
    }

    const customerId = opts.customerId || null;
    const couponId = opts.couponId || null;
    const bookingRef = opts.bookingRef || null;

    const destination = await resolveDestination(supabase, channel, customerId, vars);
    provider = resolveProvider(channel, env);
    const deliverable = !!(CAN_DELIVER[provider] && destination);
    const body = renderBody(event, vars);
    const subject = renderSubject(event);

    const queued = await enqueue(supabase, {
      tenantId: tenantId,
      event: event,
      channel: channel,
      destination: destination || null,
      subject: subject,
      body: body,
      customerId: customerId,
      couponId: couponId,
      bookingRef: bookingRef,
      // Sem contato valido nao ha quem receba: registra como 'none' para nao
      // sugerir que um provedor foi acionado.
      provider: destination ? provider : 'none',
      status: deliverable ? 'queued' : 'noop',
    });

    if (!queued.ok) {
      // Sem rastro em outbound_messages nao ha o que loggar como noop.
      console.warn('notificacoes: auditoria indisponivel');
      return { status: 'error', id: null, provider };
    }

    // Log sem PII: canal, evento e um identificador que ja existe no banco.
    const logId = queued.id || couponId || bookingRef || customerId || 'desconhecido';

    if (!queued.inserted) {
      return { status: 'duplicate', id: queued.id, provider };
    }

    if (!deliverable) {
      console.info('notificacoes: noop ' + channel + ' ' + event + ' ' + logId);
      return { status: 'noop', id: queued.id, provider };
    }

    const result = await deliverWhatsApp(env, destination, body);
    if (result.ok) {
      if (queued.id) {
        await mark(supabase, 'outbound_mark_sent', {
          p_message_id: queued.id,
          p_provider_message_id: result.providerMessageId,
        });
      }
      console.info('notificacoes: sent ' + channel + ' ' + event + ' ' + logId);
      return { status: 'sent', id: queued.id, provider };
    }

    if (queued.id) {
      await mark(supabase, 'outbound_mark_failed', {
        p_message_id: queued.id,
        p_error_code: result.errorCode,
      });
    }
    console.info('notificacoes: failed ' + channel + ' ' + event + ' ' + logId);
    return { status: 'failed', id: queued.id, provider };
  } catch (e) {
    // Última rede de proteção: o resgate já aconteceu, o aviso não pode virar erro.
    console.warn('notificacoes: falha interna');
    return { status: 'error', id: null, provider };
  }
}

module.exports = { notifyOutbound, normalizeChannel, resolveProvider, renderBody, MAX_BODY_CHARS };
