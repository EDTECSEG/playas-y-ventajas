const { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canon CJS. Espelho ESM: functions/.netlify/functions/driver-review-document.js
//
// A empresa aprova ou reprova um documento de motorista. E o portao de entrada
// do fluxo: enquanto o cadastro nao vira approved, o driver_login recusa.
//
// REGRA 3 (IDOR): p_actor_user_id vem da sessao, nunca do corpo. E o
// p_tenant_id tambem — se viesse do cliente, um usuario de um tenant poderia
// tentar revisar documento de outro tenant informando o id dele.
//
// A RPC ainda checa papel (MERCHANT/ADMIN/STAFF ou SUPER_ADMIN) e se a empresa
// do ator e a mesma do motorista. Isso e defesa em profundidade.
//
// p_reason e opcional no banco, mas e o que a empresa usa para explicar a
// reprovacao ao motorista: incentivamos a enviar, sem bloquear quem nao enviar.

const ACTIONS = ['approve', 'reject'];

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

  const { documentId, action, reason } = body || {};
  const sessionToken = extractSessionToken(event, body);

  if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'AUTH_REQUIRED' }) };
  if (!documentId) return { statusCode: 400, body: JSON.stringify({ error: 'DOCUMENT_ID_REQUIRED' }) };
  if (!ACTIONS.includes(String(action || '').toLowerCase())) {
    return { statusCode: 400, body: JSON.stringify({ error: 'ACTION_INVALID' }) };
  }

  try {
    const supabase = getSupabaseAdminClient();

    let session;
    try {
      session = await resolveSession(supabase, sessionToken);
    } catch (e) {
      return { statusCode: 401, body: JSON.stringify({ error: e.message === 'SESSION_REQUIRED' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED' }) };
    }

    const { data, error } = await supabase.rpc('driver_review_document', {
      p_tenant_id: session.tenantId,
      p_actor_user_id: session.userId, // <- da sessao, nunca do corpo
      p_document_id: documentId,
      p_action: String(action).toLowerCase(),
      p_reason: reason && String(reason).trim() ? String(reason).trim() : null,
    });

    if (error) {
      return {
        statusCode: rpcErrorStatus(error),
        body: JSON.stringify({ error: rpcErrorCode(error) }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        documentId: data.documentId,
        documentStatus: data.documentStatus,
        driverStatus: data.driverStatus,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
