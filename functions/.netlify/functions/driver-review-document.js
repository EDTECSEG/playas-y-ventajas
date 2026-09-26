import { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/driver-review-document.js
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

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const { documentId, action, reason } = body || {};
  const sessionToken = extractSessionToken(request, body);

  if (!sessionToken) return json({ error: 'AUTH_REQUIRED' }, 401);
  if (!documentId) return json({ error: 'DOCUMENT_ID_REQUIRED' }, 400);
  if (!ACTIONS.includes(String(action || '').toLowerCase())) {
    return json({ error: 'ACTION_INVALID' }, 400);
  }

  try {
    const supabase = getSupabaseAdminClient(env);

    let session;
    try {
      session = await resolveSession(supabase, sessionToken);
    } catch (e) {
      return json({ error: e.message === 'SESSION_REQUIRED' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED' }, 401);
    }

    const { data, error } = await supabase.rpc('driver_review_document', {
      p_tenant_id: session.tenantId,
      p_actor_user_id: session.userId, // <- da sessao, nunca do corpo
      p_document_id: documentId,
      p_action: String(action).toLowerCase(),
      p_reason: reason && String(reason).trim() ? String(reason).trim() : null,
    });

    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    return json({
      documentId: data.documentId,
      documentStatus: data.documentStatus,
      driverStatus: data.driverStatus,
    }, 200);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
