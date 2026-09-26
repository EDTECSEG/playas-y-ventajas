const { getSupabaseAdminClient, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canon CJS. Espelho ESM: functions/.netlify/functions/driver-set-pin.js
//
// Define/troca o PIN do cadastro. EXIGE o pinToken devolvido no cadastro.
//
// POR QUE NAO HAI FALLBACK AQUI
// -----------------------------
// A versao antiga da RPC aceitava (tenant, telefone, pin) e nao exigia prova
// nenhuma: quem soubesse o tenant e o telefone de um motorista JA APROVADO
// sobrescrevia o PIN e entrava na conta. A assinatura antiga foi droppada no
// banco, entao a porta nao existe mais do lado da SQL.
//
// Este arquivo e a unica garantia do lado HTTP: se o pinToken nao vier, o
// request morre em 401 ANTES de tocar o banco. Nunca "tentar de novo sem
// token" — isso reconstriria exatamente o ataque que a migration fechou.
//
// pinToken e segredo de posse: nunca logar, nunca ecoar na resposta de erro.

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

  const { tenantId, phone, pin, pinToken } = body || {};

  if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'TENANT_REQUIRED' }) };
  if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'PHONE_INVALID' }) };
  if (!pin) return { statusCode: 400, body: JSON.stringify({ error: 'PIN_INVALID' }) };

  // Sem token nao ha como provar que este cadastro e seu. Corta aqui.
  if (!pinToken || !String(pinToken).trim()) {
    return { statusCode: 401, body: JSON.stringify({ error: 'AUTH_REQUIRED' }) };
  }

  try {
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase.rpc('driver_set_pin', {
      p_tenant_id: tenantId,
      p_phone: String(phone),
      p_pin: String(pin),
      p_pin_token: String(pinToken).trim(),
    });

    if (error) {
      return {
        statusCode: rpcErrorStatus(error),
        body: JSON.stringify({ error: rpcErrorCode(error) }),
      };
    }

    // Depois do primeiro PIN, o caminho normal e driver-login. O token de setup
    // deixa de ser necessario e, com o status aprovado, ele morre na RPC.
    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: data.ok === true, driverId: data.driverId }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
