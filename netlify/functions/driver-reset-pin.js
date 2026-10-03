const { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus, safeRpcError } = require('./_supabaseAdmin');

// Canonico CJS, fonte unica: e o netlify.toml que publica esta pasta e o que o scripts/bundle-worker.mjs inlina. O espelho ESM que existia em functions/.netlify/functions foi removido em 2026-09-30 (divergia em silencio, sem teste que percebesse).
//
// A empresa redefine o PIN de um motorista seu. E o unico caminho de recuperacao
// que existe: o motorista define o PIN uma vez, no cadastro (driver-set-pin), e
// aquele endpoint exige o pinToken do cadastro — que morre depois do primeiro
// uso. Sem esta rota, um motorista que esquece o PIN fica sem volta, porque o
// e-mail foi descartado como canal de recuperacao.
//
// POR QUE ISTO NAO VOLA A SER O QUE driver-set-pin FOI
// -----------------------------------------------------
// A versao antiga de driver_set_pin aceitava (tenant, telefone, pin) e nao
// exigia prova nenhuma: quem soubesse o tenant e o telefone de um motorista JA
// APROVADO sobrescrevia o PIN e entrava na conta. A assinatura antiga foi
// droppada no banco justamente para fechar essa porta.
//
// Aqui a diferenca e o ator: p_actor_user_id vem da SESSAO da empresa, nunca do
// corpo, e p_tenant_id tambem. A RPC (admin_driver_reset_pin) e quem decide o
// escopo — SUPER_ADMIN em qualquer motorista do tenant; empresa nos proprios e
// nos independentes (business_id NULL). Este arquivo e a garantia do lado HTTP:
// sem sessao valida, o request morre em 401 ANTES de tocar o banco.
//
// O PIN novo e validado aqui (4 a 8 digitos) para o erro chegar como 400 antes
// da escrita, e nunca e devolvido na resposta nem logado. A RPC tambem derruba
// as sessoes abertas do motorista: se o PIN vazou, o acesso antigo tem que cair
// junto, e nao na proxima tentativa de login.

const PIN_MIN = 4;
const PIN_MAX = 8;
const PIN_RE = new RegExp(`^[0-9]{${PIN_MIN},${PIN_MAX}}$`);

// Unicos codigos de regra que admin_driver_reset_pin pode levantar. A RPC os
// escreve como `raise exception 'CODIGO: detalhe'`, e so a parte antes do ':' e
// segura de repassar.
//
// A whitelist e obrigatoria, e nao Xingues: rpcErrorCode sozinho devolve a
// mensagem INTEIRA quando ela nao tem ':' — que e o caso das falhas de
// infraestrutura, tipo `relation "public.drivers" does not exist`. Sem o filtro
// o painel receberia o schema do banco, e um 400 na frente de "POR QUE" que o
// usuario nao pode arrumar.
const RPC_CODES = new Set(['FORBIDDEN', 'DRIVER_NOT_FOUND', 'PIN_INVALID']);

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

  const { driverId, newPin } = body || {};
  const sessionToken = extractSessionToken(event, body);

  if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'AUTH_REQUIRED' }) };
  if (!driverId) return { statusCode: 400, body: JSON.stringify({ error: 'DRIVER_ID_REQUIRED' }) };

  // Sem digito nao ha PIN: nem "1234 " nem "abcd" entram. Chega como 400 para o
  // painel dizer "de 4 a 8 digitos" em vez de repassar o erro do Postgres.
  const pin = typeof newPin === 'string' ? newPin.trim() : '';
  if (!pin) return { statusCode: 400, body: JSON.stringify({ error: 'PIN_REQUIRED' }) };
  if (!PIN_RE.test(pin)) return { statusCode: 400, body: JSON.stringify({ error: 'PIN_INVALID' }) };

  try {
    const supabase = getSupabaseAdminClient();

    let session;
    try {
      session = await resolveSession(supabase, sessionToken);
    } catch (e) {
      return { statusCode: 401, body: JSON.stringify({ error: e.message === 'SESSION_REQUIRED' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED' }) };
    }

    const { data, error } = await supabase.rpc('admin_driver_reset_pin', {
      p_tenant_id: session.tenantId,
      p_actor_user_id: session.userId, // <- da sessao, nunca do corpo
      p_driver_id: String(driverId),
      p_new_pin: pin,
    });

    if (error) {
      const code = rpcErrorCode(error);
      if (RPC_CODES.has(code)) {
        return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: code }) };
      }
      // Fora da whitelist e falha de infraestrutura. A mensagem fica no log
      // (abaixo, no catch) e na resposta so vai o SQLSTATE.
      console.error('driver-reset-pin: ' + code);
      return { statusCode: 500, body: JSON.stringify({ error: safeRpcError(error, 'erro interno') }) };
    }

    // Sem o PIN no corpo: quem redefined ja conhece o valor digitado, e a
    // resposta nao pode virar um lugar onde o PIN do motorista fica guardado.
    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: data && data.ok === true,
        driverId: data && data.driverId ? data.driverId : String(driverId),
        sessionsRevoked: Boolean(data && data.sessionsRevoked),
      }),
    };
  } catch (err) {
    // A mensagem do Postgres pode carregar detalhe interno; no log (que e
    // privado) ela ajuda, na resposta nao.
    console.error('driver-reset-pin: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};