const { getSupabaseAdminClient, verifyCustomerToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canonico CJS, fonte unica: e o netlify.toml que publica esta pasta e o que o scripts/bundle-worker.mjs inlina. O espelho ESM que existia em functions/.netlify/functions foi removido em 2026-09-30 (divergia em silencio, sem teste que percebesse).
//
// Reserva de translado do cliente identificado. GET lista as reservas do
// proprio cliente; POST cria (padrao) ou cancela.
//
// REGRA 3 (IDOR): o `customerId` do corpo/query so e usado DEPOIS que o
// customerToken — HMAC(customerId) assinado no servidor — bate com ele. E o
// mesmo par que `offers?mode=my-coupons` ja exige: token de um cliente A
// acompanhado do id de B devolve 401 e nenhuma RPC e chamada. O `tenantId` vai
// validado e as regras de negocio (dia ativo, janela de horario, sobreposicao,
// escopo da empresa) moram TODAS dentro das RPCs, executadas apenas pela
// chave admin do servidor.
//
// Por que nao reusar `shuttle.js`: aquele e o catalogo publico, so leitura e
// sem sessao. A reserva e fluxo separado, com credencial propria, e precisa de
// no-store em toda resposta porque devolve nome da empresa, telefone e horario
// de um terceiro.

const noStore = () => ({ 'Cache-Control': 'no-store' });
const json = (status, body) => ({ statusCode: status, headers: noStore(), body: JSON.stringify(body) });

const toInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

// A RPC devolve jsonb; o que chega no `data` pode ser objeto, array ou null
// conforme a funcao. Normalizar aqui evita que a tela tenha de lidar com
// `reservations` ausente — o mesmo cuidado de driver-list-for-business com
// `documents`.
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

exports.handler = async (event) => {
  const method = event.httpMethod;
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  const qs = event.queryStringParameters || {};
  let body = {};
  if (method === 'POST' && event.body && String(event.body).trim() !== '') {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return json(400, { error: 'INVALID_JSON' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  }

  const tenantId = String(body.tenantId || qs.tenantId || '').trim();
  if (!tenantId) return json(400, { error: 'TENANT_ID_REQUIRED' });

  const customerId = String(body.customerId || qs.customerId || '').trim();
  const customerToken = String(body.customerToken || qs.customerToken || '');
  // verifyCustomerToken ja devolve false quando falta qualquer um dos dois.
  if (!verifyCustomerToken(customerId, customerToken)) {
    return json(401, { error: 'CUSTOMER_TOKEN_INVALID' });
  }

  try {
    const supabase = getSupabaseAdminClient();

    if (method === 'GET') {
      // `status` e filtro de TELA, nao de autoridade: o escopo continua sendo o
      // customer_id conferido acima, dentro da RPC.
      const status = qs.status ? String(qs.status).trim() : null;
      const { data, error } = await supabase.rpc('shuttle_list_customer_reservations', {
        p_tenant_id: tenantId,
        p_customer_id: customerId,
        p_status: status || null,
      });
      if (error) return json(rpcErrorStatus(error), { error: rpcErrorCode(error) });

      const reservations = reservationRows(data).map(normalizeReservation);
      return json(200, { reservations, count: reservations.length });
    }

    const action = String(body.action || '').trim() || 'create';

    if (action === 'cancel') {
      const reservationId = String(body.reservationId || '').trim();
      if (!reservationId) return json(400, { error: 'RESERVATION_ID_REQUIRED' });
      const { error } = await supabase.rpc('shuttle_cancel_reservation', {
        p_tenant_id: tenantId,
        p_customer_id: customerId,
        p_reservation_id: reservationId,
        p_reason: body.reason ? String(body.reason) : null,
      });
      if (error) return json(rpcErrorStatus(error), { error: rpcErrorCode(error) });
      return json(200, { reservationId, status: 'cancelled' });
    }

    if (action !== 'create') return json(400, { error: 'ACTION_INVALID' });

    const shuttleId = String(body.shuttleId || '').trim();
    if (!shuttleId) return json(400, { error: 'SHUTTLE_ID_REQUIRED' });
    const scheduledFor = String(body.scheduledFor || '').trim();
    if (!scheduledFor) return json(400, { error: 'SCHEDULED_FOR_REQUIRED' });
    const passengers = toInt(body.passengers);
    if (passengers === null) return json(400, { error: 'INVALID_PASSENGERS' });

    const { data, error } = await supabase.rpc('shuttle_create_reservation', {
      p_tenant_id: tenantId,
      p_customer_id: customerId,
      p_service_id: shuttleId,
      p_scheduled_for: scheduledFor,
      p_passengers: passengers,
      p_notes: body.notes ? String(body.notes) : null,
      p_contact_phone: body.contactPhone ? String(body.contactPhone) : null,
    });
    if (error) return json(rpcErrorStatus(error), { error: rpcErrorCode(error) });

    const created = normalizeReservation(data);
    return json(200, { ...created, status: created.status || 'pending' });
  } catch (err) {
    // Log vai para o tail (privado); a resposta nunca carrega err.message.
    console.error('shuttle-reservation: ' + (err && err.message));
    return json(500, { error: 'erro interno' });
  }
};
