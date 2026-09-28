import { getSupabaseAdminClient, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/driver-login.js
//
// Login do motorista por telefone + PIN, igual ao das demais categorias: o
// motorista entra assim que define o PIN e ve dentro do app o aviso de
// aprovacao e o upload de documento. Entrar no app nao e dirigir — dirigir
// continua exigindo status 'approved', checado em list_live_vehicles (modulo 1),
// e nao aqui.
//
// So a suspensao fecha o acesso: vem como ACCOUNT_SUSPENDED (403) em vez de
// 401, para o app dizer "conta suspensa" e nao "senha errada".
//
// A sessao devolvida e o campo `sessionToken` do json da RPC driver_login (nao
// `driverSessionToken`, que nao existe) e vale como credencial nos demais
// endpoints de motorista. Tratar como segredo: nao logar, nao persistir em
// storage compartilhado, nao mandar por query string em link.

// A RPC `driver_login` NAO levanta erro: devolve jsonb_build_object('error', ...)
// como dado de sucesso. Entao `error` chega null e o handler respondia HTTP 200
// com {error:'INVALID_CREDENTIALS'} — login errado com status de sucesso. O
// cliente contornava (interpretLogin), mas qualquer outro consumidor trataria
// falha como sucesso e o monitoramento nao veria a tentativa falha.
//
// PENDING_APPROVAL, REGISTRATION_REJECTED e NOT_APPROVED nao sao mais devolvidos
// pela RPC: 'pending' e 'rejected' entram e recebem a sessao com o status. Ficam
// no mapa como rede de seguranca, para uma versao antiga da RPC em producao nao
// virar 400 ambiguo.
const LOGIN_ERROR_STATUS = {
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 429,
  PENDING_APPROVAL: 403,
  REGISTRATION_REJECTED: 403,
  ACCOUNT_SUSPENDED: 403,
  NOT_APPROVED: 403,
};

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const { tenantId, phone, pin } = body || {};

  if (!tenantId) return json({ error: 'TENANT_REQUIRED' }, 400);
  if (!phone) return json({ error: 'PHONE_INVALID' }, 400);
  if (!pin) return json({ error: 'PIN_INVALID' }, 400);

  try {
    const supabase = getSupabaseAdminClient(env);

    const { data, error } = await supabase.rpc('driver_login', {
      p_tenant_id: tenantId,
      p_phone: String(phone),
      p_pin: String(pin),
    });

    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    // Recusa vem no corpo dos dados, nao como erro. 200 aqui seria login
    // errado com status de sucesso.
    if (data && data.error) {
      return new Response(JSON.stringify(data), {
        status: LOGIN_ERROR_STATUS[data.error] || 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
