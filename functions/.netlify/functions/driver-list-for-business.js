import { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/driver-list-for-business.js
//
// A empresa ve os motoristas que cadastraram contra ela. Era a peça que faltava
// para o caminho da aprovacao ter interface: sem esta rota, o painel da empresa
// nao tinha como descobrir que existia uma CNH aguardando revisao, e a
// aprovacao so funcionava chamando driver-review-document na mao.
//
// Sem `doc_url` de proposito. A lista diz QUE documento existe, o tipo e o
// status; o conteudo vem sob demanda em driver-document-url, que assina uma URL
// curta depois de checar o ator. Embutir a URL aqui voltaria a espalhar um
// caminho para o arquivo em toda resposta de listagem.
//
// REGRA 3 (IDOR): tenant e ator vem da sessao, nunca da query. A RPC ainda
// checa papel e escopo pelo business_id, entao um id de outra empresa nao
// ajuda quem tentar forjar a query.

export async function onRequestGet(context) {
  const { request, env } = context;

  // `status` e o unico filtro, e e opcional. Vem da query porque e uma escolha
  // de tela ("mostrar so pendentes"), nao de autoridade.
  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  try {
    const supabase = getSupabaseAdminClient(env);

    const sessionToken = extractSessionToken(request, {});
    if (!sessionToken) return json({ error: 'AUTH_REQUIRED' }, 401);

    let session;
    try {
      session = await resolveSession(supabase, sessionToken);
    } catch (e) {
      return json({ error: e.message === 'SESSION_REQUIRED' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED' }, 401);
    }

    const { data, error } = await supabase.rpc('driver_list_for_business', {
      p_tenant_id: session.tenantId,   // <- da sessao
      p_actor_user_id: session.userId, // <- da sessao
      p_status: status ? String(status).trim() : null,
    });

    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    // A RPC devolve [] quando nao ha linha, mas um driver sem documento
    // agendado nao entra no resultado de jsonb_agg. Normalizar aqui evita que a
    // tela precise lidar com `documents` ausente.
    const drivers = (Array.isArray(data) ? data : []).map((d) => ({
      driverId: d.driverId,
      name: d.name,
      phone: d.phone,
      email: d.email,
      status: d.status,
      businessId: d.businessId,
      createdAt: d.createdAt,
      approvedAt: d.approvedAt,
      documents: Array.isArray(d.documents) ? d.documents : [],
    }));

    return json({ drivers, count: drivers.length }, 200, { 'Cache-Control': 'no-store' }); // dado pessoal: nao em cache
  } catch (err) {
    return json({ error: 'erro interno' }, 500);
  }
}
