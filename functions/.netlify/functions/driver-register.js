import { getSupabaseAdminClient, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/driver-register.js
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

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const { tenantId, name, phone, email, businessId, inviteCode } = body || {};

  // Validacao de presenca. A RPC revalida tudo com mais rigor; aqui e so para
  // nao gastar ida ao banco com request obviously invalido.
  if (!tenantId) return json({ error: 'TENANT_REQUIRED' }, 400);
  if (!name || !String(name).trim()) return json({ error: 'NAME_REQUIRED' }, 400);
  if (!phone) return json({ error: 'PHONE_INVALID' }, 400);
  if (!email) return json({ error: 'EMAIL_INVALID' }, 400);

  try {
    const supabase = getSupabaseAdminClient(env);

    const { data, error } = await supabase.rpc('driver_register', {
      p_tenant_id: tenantId,
      p_name: String(name).trim(),
      p_phone: String(phone),
      p_email: String(email).trim().toLowerCase(),
      p_business_id: businessId || null,
      p_invite_code: inviteCode ? String(inviteCode).trim().toUpperCase() : null,
    });

    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    // A RPC devolve { driverId, status, pinToken, uploadToken, message }.
    // Repassamos como veio: o cliente precisa guardar os dois tokens agora,
    // porque depois so o sha256 existe no banco.
    return new Response(
      JSON.stringify({
        driverId: data.driverId,
        status: data.status,
        pinToken: data.pinToken,
        uploadToken: data.uploadToken,
        message: data.message,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
