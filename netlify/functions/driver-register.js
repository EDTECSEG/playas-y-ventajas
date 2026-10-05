const { getSupabaseAdminClient, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canonico CJS, fonte unica: e o netlify.toml que publica esta pasta e o que o scripts/bundle-worker.mjs inlina. O espelho ESM que existia em functions/.netlify/functions foi removido em 2026-09-30 (divergia em silencio, sem teste que percebesse).
//
// Cadastro PUBLICO de motorista. Nao exige sessao: e o unico ponto de entrada
// de quem ainda nao tem conta. A RPC devolve os tokens de posse UMA vez, e o
// banco guarda so o sha256 deles.
//
// SEGREDOS: pinToken e uploadToken sao a unica prova de posse do cadastro.
// Eles NUNCA podem entrar em log, em metricas, nem em mensagem de erro. Este
// arquivo nao loga nada de proposito — se um dia precisar logar, logar so o
// driverId e o codigo de erro.
//
// RATE LIMIT: 20 cadastros/hora/tenant mora na RPC (nao por IP, porque a borda
// nao e lugar confiavel). Aqui o que fazemos e entregar o 429 certo.

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

  const { tenantId, name, phone, email, businessId, inviteCode, cpf, cnpj, legalName } = body || {};

  // Validacao de presenca. A RPC revalida tudo com mais rigor; aqui e so para
  // nao gastar ida ao banco com request obviously invalido.
  if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'TENANT_REQUIRED' }) };
  if (!name || !String(name).trim()) return { statusCode: 400, body: JSON.stringify({ error: 'NAME_REQUIRED' }) };
  if (!phone) return { statusCode: 400, body: JSON.stringify({ error: 'PHONE_INVALID' }) };
  if (!email) return { statusCode: 400, body: JSON.stringify({ error: 'EMAIL_INVALID' }) };

  // O CPF e obrigatorio no cadastro, mas a exigencia que vale e a da RPC (p7).
  // Aqui o que existe e o aviso antecipado, para o erro sair em codigo em vez de
  // cair no 500 generico. O DV NAO e conferido neste arquivo: a RPC ja faz isso
  // com public.is_valid_cpf, e duas implementacoes do mesmo DV aqui e no banco
  // so criariam uma terceira para divergir.
  if (!cpf || !String(cpf).replace(/\D+/g, '')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'CPF_REQUIRED' }) };
  }

  try {
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase.rpc('driver_register', {
      p_tenant_id: tenantId,
      p_name: String(name).trim(),
      p_phone: String(phone),
      p_email: String(email).trim().toLowerCase(),
      p_business_id: businessId || null,
      p_invite_code: inviteCode ? String(inviteCode).trim().toUpperCase() : null,
      p_cpf: String(cpf).replace(/\D+/g, ''),
      // Os tres vao como null quando nao vem nada, e nao como ''. Vazio e null
      // chegam no mesmo lugar na RPC (nullif), mas mandar '' deixa o campo
      // parecendo preenchido em qualquer log de chamada feito no futuro.
      p_cnpj: cnpj ? String(cnpj).replace(/\D+/g, '') || null : null,
      p_legal_name: legalName ? String(legalName).trim() || null : null,
    });

    if (error) {
      return {
        statusCode: rpcErrorStatus(error),
        body: JSON.stringify({ error: rpcErrorCode(error) }),
      };
    }

    // A RPC devolve { driverId, status, pinToken, uploadToken, message }.
    // Repassamos como veio: o cliente precisa guardar os dois tokens agora,
    // porque depois so o sha256 existe no banco.
    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        driverId: data.driverId,
        status: data.status,
        pinToken: data.pinToken,
        uploadToken: data.uploadToken,
        message: data.message,
      }),
    };
  } catch (err) {
    console.error('driver-register: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};
