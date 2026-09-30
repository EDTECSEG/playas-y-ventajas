import { getSupabaseAdminClient, verifyCustomerToken, rpcErrorCode, rpcErrorStatus } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/shuttle-reservation.js
//
// Reserva de translado do cliente identificado. GET lista as reservas do
// proprio cliente; POST cria (padrao) ou cancela.
//
// REGRA 3 (IDOR): o `customerId` do corpo/query so e usado DEPOIS que o
// customerToken — HMAC(customerId) assinado no servidor — bate com ele.
// `verifyCustomerToken` no ESM e async porque usa crypto.subtle.
//
// O `json` local existe em vez do de _shared.js porque TODA resposta aqui
// precisa de no-store, inclusive as de erro: o payload devolve nome da empresa,
// telefone e horario de um terceiro.

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const toInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

function normalizeReservation(r) {
  const o = r && typeof r === 'object' ? r : {};
  return {
    reservationId: o.reservationId || null,
    shuttleId: o.shuttleId || null,
    serviceName: o.serviceName || null,
    businessName: o.businessName || null,
    businessPhone: o.businessPhone || null,
    scheduledFor: o.scheduledFor || null,
    durationMinutes: o.durationMinutes === null || o.durationMinutes === undefined ? null : Number(o.durationMinutes),
    passengers: o.passengers === null || o.passengers === undefined ? null : Number(o.passengers),
    priceCents: o.priceCents === null || o.priceCents === undefined ? null : Number(o.priceCents),
    status: o.status || null,
    reason: o.reason || null,
    createdAt: o.createdAt || null,
  };
}

function reservationRows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.reservations)) return data.reservations;
  return [];
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const qs = Object.fromEntries(url.searchParams);

  const tenantId = String(qs.tenantId || '').trim();
  if (!tenantId) return json({ error: 'TENANT_ID_REQUIRED' }, 400);

  const customerId = String(qs.customerId || '').trim();
  const customerToken = String(qs.customerToken || '');
  if (!(await verifyCustomerToken(env, customerId, customerToken))) {
    return json({ error: 'CUSTOMER_TOKEN_INVALID' }, 401);
  }

  try {
    const supabase = getSupabaseAdminClient(env);
    const status = qs.status ? String(qs.status).trim() : null;
    const { data, error } = await supabase.rpc('shuttle_list_customer_reservations', {
      p_tenant_id: tenantId,
      p_customer_id: customerId,
      p_status: status || null,
    });
    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    const reservations = reservationRows(data).map(normalizeReservation);
    return json({ reservations, count: reservations.length }, 200);
  } catch (err) {
    console.error('shuttle-reservation: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body = {};
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
    const raw = await request.text();
    if (raw && raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
      } catch (e) {
        return json({ error: 'INVALID_JSON' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    }
  }

  const tenantId = String(body.tenantId || '').trim();
  if (!tenantId) return json({ error: 'TENANT_ID_REQUIRED' }, 400);

  const customerId = String(body.customerId || '').trim();
  const customerToken = String(body.customerToken || '');
  if (!(await verifyCustomerToken(env, customerId, customerToken))) {
    return json({ error: 'CUSTOMER_TOKEN_INVALID' }, 401);
  }

  try {
    const supabase = getSupabaseAdminClient(env);

    const action = String(body.action || '').trim() || 'create';

    if (action === 'cancel') {
      const reservationId = String(body.reservationId || '').trim();
      if (!reservationId) return json({ error: 'RESERVATION_ID_REQUIRED' }, 400);
      const { error } = await supabase.rpc('shuttle_cancel_reservation', {
        p_tenant_id: tenantId,
        p_customer_id: customerId,
        p_reservation_id: reservationId,
        p_reason: body.reason ? String(body.reason) : null,
      });
      if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));
      return json({ reservationId, status: 'cancelled' }, 200);
    }

    if (action !== 'create') return json({ error: 'ACTION_INVALID' }, 400);

    const shuttleId = String(body.shuttleId || '').trim();
    if (!shuttleId) return json({ error: 'SHUTTLE_ID_REQUIRED' }, 400);
    const scheduledFor = String(body.scheduledFor || '').trim();
    if (!scheduledFor) return json({ error: 'SCHEDULED_FOR_REQUIRED' }, 400);
    const passengers = toInt(body.passengers);
    if (passengers === null) return json({ error: 'INVALID_PASSENGERS' }, 400);

    const { data, error } = await supabase.rpc('shuttle_create_reservation', {
      p_tenant_id: tenantId,
      p_customer_id: customerId,
      p_service_id: shuttleId,
      p_scheduled_for: scheduledFor,
      p_passengers: passengers,
      p_notes: body.notes ? String(body.notes) : null,
      p_contact_phone: body.contactPhone ? String(body.contactPhone) : null,
    });
    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    const created = normalizeReservation(data);
    return json({ ...created, status: created.status || 'pending' }, 200);
  } catch (err) {
    console.error('shuttle-reservation: ' + (err && err.message));
    return json({ error: 'erro interno' }, 500);
  }
}
