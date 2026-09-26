import { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/business-driver-invite.js
//
// A empresa gera um codigo de convite para o motorista se cadastrar vinculado
// a ela.
//
// REGRA 3 (IDOR) — o ponto central deste arquivo: p_actor_user_id NUNCA vem do
// corpo da requisicao. Vem da sessao autenticada, resolvida no servidor. Se
// aceitasse actorUserId do cliente, qualquer um poderia gerar convite em nome
// de qualquer empresa do tenant.
//
// A RPC ainda valida de novo (papel, is_active, business_id do mesmo tenant),
// mas isso e defesa em profundidade, nao a unica linha: o endpoint ja entrega
// o ator certo por construcao.

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const sessionToken = extractSessionToken(request, body);
  if (!sessionToken) return json({ error: 'AUTH_REQUIRED' }, 401);

  // maxUses e expiresHours tem teto na RPC (1..100 e 1..720). Aqui so evita
  // erro de digitacao obvia antes de gastar a chamada.
  const maxUses = body.maxUses === undefined || body.maxUses === null ? null : Number(body.maxUses);
  const expiresHours = body.expiresHours === undefined || body.expiresHours === null ? null : Number(body.expiresHours);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100)) {
    return json({ error: 'INVITE_MAX_USES_INVALID' }, 400);
  }
  if (expiresHours !== null && (!Number.isInteger(expiresHours) || expiresHours < 1 || expiresHours > 720)) {
    return json({ error: 'INVITE_EXPIRES_INVALID' }, 400);
  }

  try {
    const supabase = getSupabaseAdminClient(env);

    let session;
    try {
      session = await resolveSession(supabase, sessionToken);
    } catch (e) {
      return json({ error: e.message === 'SESSION_REQUIRED' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED' }, 401);
    }

    // maxUses/expiresHours so entram no objeto quando vieram preenchidos.
    // A RPC usa DEFAULT 1 e DEFAULT 72; mandar null explicito NAO aciona o
    // default, faria a funcao levantar INVITE_MAX_USES_INVALID. No Supabase JS
    // toda chave presente no objeto e enviada, entao a chave tem de ser omitida.
    const params = {
      p_tenant_id: session.tenantId,
      p_actor_user_id: session.userId, // <- da sessao, nunca do corpo
    };
    if (maxUses !== null) params.p_max_uses = maxUses;
    if (expiresHours !== null) params.p_expires_hours = expiresHours;

    const { data, error } = await supabase.rpc('business_generate_invite', params);

    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    return json({
      code: data.code,
      businessId: data.businessId,
      maxUses: data.maxUses,
      expiresAt: data.expiresAt,
    }, 200);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
