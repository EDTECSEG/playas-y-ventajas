const { getSupabaseAdminClient, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canon CJS. Espelho ESM: functions/.netlify/functions/driver-login.js
//
// Login do motorista por telefone + PIN. A RPC so emite sessao para status
// aprovado — quem ainda esta pending/rejected nao entra por aqui, e o motivo
// volta como NOT_APPROVED (403) em vez de 401, para o app poder mostrar
// "aguardando aprovacao" em vez de "senha errada".
//
// A sessao devolvida e o driverSessionToken e vale como credencial nos demais
// endpoints de motorista. Tratar como segredo: nao logar, nao persistir em
// storage compartilhado, nao mandar por query string em link.

// A RPC `driver_login` NAO levanta erro: ela devolve
// jsonb_build_object('error', ...) como dado de sucesso. Entao `error` chega
// null e o handler respondia HTTP 200 com {error:'INVALID_CREDENTIALS'} —
// login errado com status de sucesso. O cliente do motorista contornava isso
// (interpretLogin), mas qualquer outro consumidor trataria falha como
// sucesso, e monitoramento nao veria tentativa de login falhada.
const LOGIN_ERROR_STATUS = {
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 429,
  PENDING_APPROVAL: 403,
  REGISTRATION_REJECTED: 403,
  ACCOUNT_SUSPENDED: 403,
  NOT_APPROVED: 403,
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'INVALID_JSON' }) };
  }

  const { tenantId, phone, pin } = body || {};

  if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'TENANT_REQUIRED' }) };
  if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'PHONE_INVALID' }) };
  if (!pin) return { statusCode: 400, body: JSON.stringify({ error: 'PIN_INVALID' }) };

  try {
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase.rpc('driver_login', {
      p_tenant_id: tenantId,
      p_phone: String(phone),
      p_pin: String(pin),
    });

    if (error) {
      return {
        statusCode: rpcErrorStatus(error),
        body: JSON.stringify({ error: rpcErrorCode(error) }),
      };
    }

    // A RPC sinaliza recusa no corpo dos dados, nao como erro: e o caso comum
    // de telefone/PIN errado. Devolver 200 aqui seria login recusado com
    // status de sucesso.
    if (data && data.error) {
      return {
        statusCode: LOGIN_ERROR_STATUS[data.error] || 400,
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(data),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
