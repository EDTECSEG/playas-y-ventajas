const { createHmac, timingSafeEqual } = require('crypto');
const { getSupabaseAdminClient } = require('./_supabaseAdmin');

// Webhook de Assinatura do Mercado Pago. Rota PÚBLICA (o MP não usa sessão):
// a autenticação é o header x-signature (HMAC-SHA256 do manifesto com o
// Webhook Secret). Nenhum detalhe interno é devolvido ao caller.
//
// Manifesto (doc oficial, validação "sem SDK"):
//   x-signature = "ts=<timestamp>,v1=<64 hex sha256>"
//   manifesto   = "id:[data.id da query];request-id:[header x-request-id];ts:[header ts];"
//   campos ausentes ficam de fora do manifesto; comparação timing-safe com v1.
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

function hmacHex(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Tolerância de relógio: MP assina com timestamp em segundos; retries chegam
// dentro de minutos, então 10 min cobre skew + retry sem abrir replay grande.
const TS_TOLERANCE_SEC = 600;

function verifySignature(query, headers, secret) {
  const xSignature = String(headers['x-signature'] || headers['X-Signature'] || '').trim();
  const ts = String(headers['ts'] || '').trim();
  const xRequestId = String(headers['x-request-id'] || '').trim();
  const dataId = String(query['data.id'] === undefined ? (query.data_id || '') : query['data.id']).trim();
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
  const expected = hmacHex(secret, fields.join(';') + ';');
  return safeEqual(v1, expected);
}

exports.handler = async (event) => {
  const supabase = getSupabaseAdminClient();
  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'METODO_NAO_PERMITIDO' }) };

    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) {
      console.error('billing-webhook: MP_WEBHOOK_SECRET ausente');
      return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
    }

    const query = event.queryStringParameters || {};
    const headers = event.headers || {};
    if (!verifySignature(query, headers, secret)) {
      console.error('billing-webhook: assinatura invalida');
      return { statusCode: 403, body: JSON.stringify({ error: 'assinatura invalida' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const type = body.type || query.type || '';
    const dataId = (body.data && body.data.id) ? String(body.data.id) : (String(query['data.id'] || '') || '');
    const accessToken = process.env.MP_ACCESS_TOKEN;
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
        return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    if (type === 'subscription_preapproval') {
      const pa = await mpJson('/preapproval/' + dataId, accessToken);
      const { error } = await supabase.rpc('billing_mp_webhook_preapproval', {
        p_subscription_id: String(pa.id),
        p_status: String(pa.status || ''),
      });
      if (error) {
        console.error('billing-webhook preapproval: ' + error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // Eventos não relacionados a assinatura: ignora e responde 200 para o MP
    // não reenviar os que já foram consumidos pelo fluxo de pagamento/pedido.
    console.log('billing-webhook: tipo ignorado ' + type);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('billing-webhook: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};