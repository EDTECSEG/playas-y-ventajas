import { getSupabaseAdminClient, json } from './_shared.js';

// Espelho ESM de netlify/functions/billing-webhook.js. Valida x-signature do
// Mercado Pago com HMAC-SHA256 (WebCrypto, sem require) e repassa o evento às
// RPCs de webhook (dedupe + status). Rota pública: assinatura é a autenticação.
const MP_API_BASE = process.env.MP_API_BASE || 'https://api.mercadopago.com';
const TS_TOLERANCE_SEC = 600;

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

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Comparação de string em tempo constante (equivalente ESM do timingSafeEqual).
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(query, headers, secret) {
  const xSignature = String(headers.get('x-signature') || headers.get('X-Signature') || '').trim();
  const ts = String(headers.get('ts') || '').trim();
  const xRequestId = String(headers.get('x-request-id') || '').trim();
  const dataId = String(query.get('data.id') === null ? (query.get('data_id') || '') : query.get('data.id')).trim();
  if (!xSignature || !ts || !dataId || !secret) return false;

  const parts = {};
  for (const pair of xSignature.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) parts[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  const v1 = parts['v1'];
  if (!v1 || !/^[0-9a-f]{64}$/i.test(v1)) return false;

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > TS_TOLERANCE_SEC) return false;

  const fields = ['id:' + dataId];
  if (xRequestId) fields.push('request-id:' + xRequestId);
  fields.push('ts:' + ts);
  const expected = await hmacHex(secret, fields.join(';') + ';');
  return safeEqual(v1, expected);
}

export async function onRequestGet() {
  return json({ error: 'METODO_NAO_PERMITIDO' }, 405);
}

export async function onRequestPost(context) {
  const { request } = context;
  const supabase = getSupabaseAdminClient(context.env);
  try {
    const secret = envOf(context, 'MP_WEBHOOK_SECRET');
    if (!secret) {
      console.error('billing-webhook: MP_WEBHOOK_SECRET ausente');
      return json({ error: 'erro interno' }, 500);
    }

    const url = new URL(request.url);
    if (!(await verifySignature(url.searchParams, request.headers, secret))) {
      console.error('billing-webhook: assinatura invalida');
      return json({ error: 'assinatura invalida' }, 403);
    }

    const body = await request.json();
    const type = body.type || url.searchParams.get('type') || '';
    const dataId = (body.data && body.data.id) ? String(body.data.id) : (url.searchParams.get('data.id') || '');
    const accessToken = envOf(context, 'MP_ACCESS_TOKEN');
    if (!accessToken) throw new Error('MP_ACCESS_TOKEN ausente');

    if (type === 'subscription_authorized_payment') {
      const ap = await mpJson('/authorized_payments/' + dataId, accessToken);
      const preapprovalId = String(ap.preapproval_id || ap.preapprovalId || '');
      if (!preapprovalId) throw new Error('MP_API_ERROR: authorized_payment sem preapproval_id');
      const amountCents = Math.round(Number(ap.transaction_amount) * 100);
      if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('MP_API_ERROR: valor invalido');
      const { error } = await supabase.rpc('billing_mp_webhook_charge', {
        p_subscription_id: preapprovalId,
        p_payment_id: dataId,
        p_amount_cents: amountCents,
      });
      if (error) {
        console.error('billing-webhook charge: ' + error.message);
        return json({ error: 'erro interno' }, 500);
      }
      return json({ ok: true });
    }

    if (type === 'subscription_preapproval') {
      const pa = await mpJson('/preapproval/' + dataId, accessToken);
      const { error } = await supabase.rpc('billing_mp_webhook_preapproval', {
        p_subscription_id: String(pa.id),
        p_status: String(pa.status || ''),
      });
      if (error) {
        console.error('billing-webhook preapproval: ' + error.message);
        return json({ error: 'erro interno' }, 500);
      }
      return json({ ok: true });
    }

    console.log('billing-webhook: tipo ignorado ' + type);
    return json({ ok: true });
  } catch (err) {
    console.error('billing-webhook: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}