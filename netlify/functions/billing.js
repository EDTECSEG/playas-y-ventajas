const { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Assinatura mensal via Mercado Pago (v1): fluxo pending + init_point.
// O segredo (MP_ACCESS_TOKEN) nunca sai do servidor; o handler só devolve o
// init_point (checkout hospedado do MP) para o browser redirecionar.
const MP_API_BASE = process.env.MP_API_BASE || 'https://api.mercadopago.com';

async function mpJson(path, accessToken, method = 'GET', payload) {
  const res = await fetch(MP_API_BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data && (data.message || data.error)) || 'status ' + res.status;
    throw new Error('MP_API_ERROR: ' + detail);
  }
  return data;
}

// URL do webhook gravada na criação da assinatura. Como Assinaturas não tem
// configuração de notificação no painel ("Suas integrações"), o notification_url
// precisa ir no body do preapproval.
function webhookUrl() {
  const explicit = process.env.MP_NOTIFICATION_URL;
  if (explicit) return explicit;
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (site) return String(site).replace(/\/+$/, '') + '/.netlify/functions/billing-webhook';
  return null;
}

function errBody(error) {
  return JSON.stringify({ error: rpcErrorCode(error) });
}

exports.handler = async (event) => {
  const supabase = getSupabaseAdminClient();
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'METODO_NAO_PERMITIDO' }) };

    const body = JSON.parse(event.body || '{}');
    const actor = await resolveSession(supabase, extractSessionToken(event, body));
    if (actor.role !== 'MERCHANT' && actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') {
      return { statusCode: 403, body: JSON.stringify({ error: 'FORBIDDEN' }) };
    }

    const common = { p_tenant_id: actor.tenantId, p_business_id: body.businessId, p_actor_user_id: actor.userId };

    if (body.action === 'status') {
      const { data, error } = await supabase.rpc('billing_mp_prepare', common);
      if (error) return { statusCode: rpcErrorStatus(error), body: errBody(error) };
      return {
        statusCode: 200,
        body: JSON.stringify({
          subscriptionId: data.subscriptionId || null,
          subscriptionUrl: data.subscriptionUrl || null,
        }),
      };
    }

    if (body.action === 'create') {
      const { data, error } = await supabase.rpc('billing_mp_prepare', common);
      if (error) return { statusCode: rpcErrorStatus(error), body: errBody(error) };

      // Já existe assinatura: reabre o mesmo checkout/url em vez de duplicar.
      if (data.subscriptionUrl) {
        return {
          statusCode: 200,
          body: JSON.stringify({ initPoint: data.subscriptionUrl, subscriptionId: data.subscriptionId, already: true }),
        };
      }

      const accessToken = process.env.MP_ACCESS_TOKEN;
      if (!accessToken) throw new Error('MP_ACCESS_TOKEN ausente');
      const notificationUrl = webhookUrl();
      if (!notificationUrl) throw new Error('MP_NOTIFICATION_URL ausente');

      const preapproval = await mpJson('/preapproval', accessToken, 'POST', {
        reason: data.reason,
        external_reference: String(data.businessId),
        payer_email: data.ownerEmail,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: data.transactionAmount,
          currency_id: 'BRL',
        },
        status: 'pending',
        notification_url: notificationUrl,
      });

      const subscriptionId = preapproval.id;
      const initPoint = preapproval.init_point || preapproval.initPoint || null;
      if (!subscriptionId || !initPoint) {
        // Rollback: se não veio o que esperamos, não deixa preapproval órfã.
        await mpJson('/preapproval/' + subscriptionId, accessToken, 'PUT', { status: 'cancelled' }).catch(() => {});
        throw new Error('MP_API_ERROR: preapproval sem id/init_point');
      }

      const reg = await supabase.rpc('billing_mp_register', {
        ...common,
        p_subscription_id: String(subscriptionId),
        p_subscription_url: initPoint,
      });
      if (reg.error) {
        await mpJson('/preapproval/' + subscriptionId, accessToken, 'PUT', { status: 'cancelled' }).catch(() => {});
        return { statusCode: rpcErrorStatus(reg.error), body: errBody(reg.error) };
      }

      return { statusCode: 200, body: JSON.stringify({ initPoint, subscriptionId, already: false }) };
    }

    if (body.action === 'cancel') {
      const prep = await supabase.rpc('billing_mp_prepare', common);
      if (prep.error) return { statusCode: rpcErrorStatus(prep.error), body: errBody(prep.error) };

      if (prep.data.subscriptionId) {
        // Cancelamento no MP é best-effort (pode já ter sido cancelado lá); o
        // estado local é a fonte de verdade a partir daqui.
        const accessToken = process.env.MP_ACCESS_TOKEN;
        if (accessToken) {
          await mpJson('/preapproval/' + prep.data.subscriptionId, accessToken, 'PUT', { status: 'cancelled' }).catch(() => {});
        }
      }
      const { error } = await supabase.rpc('billing_mp_cancel', common);
      if (error) return { statusCode: rpcErrorStatus(error), body: errBody(error) };
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'action inválida' }) };
  } catch (err) {
    const code = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    const body = code === 401 ? err.message : 'erro interno';
    if (code === 500) console.error('billing: ' + (err && err.message));
    return { statusCode: code, body: JSON.stringify({ error: body }) };
  }
};