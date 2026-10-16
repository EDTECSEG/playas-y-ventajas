const { getSupabaseAdminClient, extractSessionToken } = require('./_supabaseAdmin');

// Canonico CJS, fonte unica: e o netlify.toml que publica esta pasta e o que
// scripts/bundle-worker.mjs inlina.
//
// Situacao atual do motorista a partir da PROPRIA sessao. Existe porque a tela
// do motorista reidrata a sessao do localStorage no mount e nunca consulta o
// servidor: um cadastro que era 'pending' quando entrou e foi aprovado depois
// continuava aparecendo como "Aguardando aprovacao da empresa" no celular ate o
// motorista sair e entrar de novo (ou reinstalar o app). Este endpoint e o que
// fecha essa janela.
//
// O driver_id vem da sessao no banco, nunca do corpo: trocar o driverId pedido
// nao ajuda ninguem. So GET, e a personagem e derivada da credencial.
//
// Sem RPC nova: a leitura e dois selects com o cliente admin (privilegio de
// servidor), tabelas public.sessions e public.drivers. O que autoriza e o token
// da sessao existir, ser do tipo 'driver' e nao estar expirado — as mesmas
// condicoes que driver_report_position usa no banco.

const noStore = () => ({ 'Cache-Control': 'no-store' });
const json = (status, body) => ({ statusCode: status, headers: noStore(), body: JSON.stringify(body) });

// O token e uuid. Um valor fora do formato faria o PostgREST devolver erro de
// cast de uuid em vez de 401; barrar antes mantem a resposta como "sessao
// invalida", que e o que o cliente sabe tratar.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'METHOD_NOT_ALLOWED' });

  const sessionToken = extractSessionToken(event, {});
  if (!sessionToken) return json(401, { error: 'AUTH_REQUIRED' });
  if (!UUID_RE.test(String(sessionToken))) return json(401, { error: 'SESSION_EXPIRED' });

  try {
    const supabase = getSupabaseAdminClient();

    const { data: session, error: sErr } = await supabase
      .from('sessions')
      .select('driver_id, tenant_id, expires_at, kind')
      .eq('token', sessionToken)
      .eq('kind', 'driver')
      .maybeSingle();

    if (sErr) return json(500, { error: 'erro interno' });
    if (!session || !session.driver_id) return json(401, { error: 'SESSION_EXPIRED' });
    if (session.expires_at && new Date(session.expires_at).getTime() <= Date.now()) {
      return json(401, { error: 'SESSION_EXPIRED' });
    }

    const { data: driver, error: dErr } = await supabase
      .from('drivers')
      .select('id, status, name, phone, business_id')
      .eq('id', session.driver_id)
      .maybeSingle();

    if (dErr) return json(500, { error: 'erro interno' });
    if (!driver) return json(404, { error: 'DRIVER_NOT_FOUND' });

    return json(200, {
      driverId: driver.id,
      tenantId: session.tenant_id,
      status: driver.status,
      name: driver.name,
      phone: driver.phone,
      businessId: driver.business_id,
    });
  } catch (err) {
    console.error('driver-me: ' + (err && err.message));
    return json(500, { error: 'erro interno' });
  }
};
