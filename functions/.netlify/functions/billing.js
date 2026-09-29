import { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';

// Espelho ESM de netlify/functions/billing.js (mesma lógica; dialeto Netlify
// functions v2). Assinatura mensal via Mercado Pago v1: pending + init_point.
const MP_API_BASE = process.env.MP_API_BASE || 'https://api.mercadopago.com';

function envOf(context, name) {
  return (context.env && context.env[name]) || process.env[name];
}

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

function webhookUrl(context) {
  const explicit = envOf(context, 'MP_NOTIFICATION_URL');
  if (explicit) return explicit;
  const site = envOf(context, 'NEXT_PUBLIC_SITE_URL');
  if (site) return String(site).replace(/\/+$/, '') + '/.netlify/functions/billing-webhook';
  return null;
}

export async function onRequestGet() {
  return json({ error: 'METODO_NAO_PERMITIDO' }, 405);
}

export async function onRequestPost(context) {
  const { request } = context;
  const supabase = getSupabaseAdminClient(context.env);
  try {
    const body = await request.json();
    const actor = await resolveSession(supabase, extractSessionToken(request, body));
    if (actor.role !== 'MERCHANT' && actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') {
      return json({ error: 'FORBIDDEN' }, 403);
    }

    const common = { p_tenant_id: actor.tenantId, p_business_id: body.businessId, p_actor_user_id: actor.userId };

    if (body.action === 'status') {
      const { data, error } = await supabase.rpc('billing_mp_prepare', common);
      if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));
      return json({ subscriptionId: data.subscriptionId || null, subscriptionUrl: data.subscriptionUrl || null });
    }

    if (body.action === 'create') {
      const { data, error } = await supabase.rpc('billing_mp_prepare', common);
      if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

      if (data.subscriptionUrl) {
        return json({ initPoint: data.subscriptionUrl, subscriptionId: data.subscriptionId, already: true });
      }

      const accessToken = envOf(context, 'MP_ACCESS_TOKEN');
      if (!accessToken) throw new Error('MP_ACCESS_TOKEN ausente');
      const notificationUrl = webhookUrl(context);
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
        return json({ error: rpcErrorCode(reg.error) }, rpcErrorStatus(reg.error));
      }

      return json({ initPoint, subscriptionId, already: false });
    }

    if (body.action === 'cancel') {
      const prep = await supabase.rpc('billing_mp_prepare', common);
      if (prep.error) return json({ error: rpcErrorCode(prep.error) }, rpcErrorStatus(prep.error));

      if (prep.data.subscriptionId) {
        const accessToken = envOf(context, 'MP_ACCESS_TOKEN');
        if (accessToken) {
          await mpJson('/preapproval/' + prep.data.subscriptionId, accessToken, 'PUT', { status: 'cancelled' }).catch(() => {});
        }
      }
      const { error } = await supabase.rpc('billing_mp_cancel', common);
      if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));
      return json({ ok: true });
    }

    return json({ error: 'action inválida' }, 400);
  } catch (err) {
    const status = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    const body = status === 401 ? err.message : 'erro interno';
    if (status === 500) console.error('billing: ' + (err && err.message));
    return json({ error: body }, status);
  }
}