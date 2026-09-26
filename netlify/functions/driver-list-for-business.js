const { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canon CJS. Espelho ESM: functions/.netlify/functions/driver-list-for-business.js
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }) };
  }

  // `status` e o unico filtro, e e opcional. Vem da query porque e uma escolha
  // de tela ("mostrar so pendentes"), nao de autoridade.
  const qs = event.queryStringParameters || {};
  const status = qs.status ? String(qs.status).trim() : null;

  try {
    const supabase = getSupabaseAdminClient();

    const sessionToken = extractSessionToken(event, {});
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'AUTH_REQUIRED' }) };

    let session;
    try {
      session = await resolveSession(supabase, sessionToken);
    } catch (e) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: e.message === 'SESSION_REQUIRED' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED' }),
      };
    }

    const { data, error } = await supabase.rpc('driver_list_for_business', {
      p_tenant_id: session.tenantId,      // <- da sessao
      p_actor_user_id: session.userId,    // <- da sessao
      p_status: status || null,
    });

    if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };

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

    return {
      statusCode: 200,
      // no-store: a lista carrega nome e telefone de motorista, e nao deve
      // ficar em cache compartilhado depois do logout.
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ drivers, count: drivers.length }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};
