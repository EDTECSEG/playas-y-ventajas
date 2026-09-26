import { getSupabaseAdminClient, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';

// Espelho ESM. Canon CJS: netlify/functions/driver-set-pin.js
//
// Define/troca o PIN do cadastro. EXIGE o pinToken devolvido no cadastro.
//
// POR QUE NAO HAI FALLBACK AQUI
// -----------------------------
// A versao antiga da RPC aceitava (tenant, telefone, pin) e nao exigia prova
// nenhuma: quem soubesse o tenant e o telefone de um motorista JA APROVADO
// sobrescrevia o PIN e entrava na conta. A assinatura antiga foi droppada no
// banco, entao a porta nao existe mais do lado da SQL.
//
// Este arquivo e a unica garantia do lado HTTP: se o pinToken nao vier, o
// request morre em 401 ANTES de tocar o banco. Nunca "tentar de novo sem
// token" — isso reconstriria exatamente o ataque que a migration fechou.
//
// pinToken e segredo de posse: nunca logar, nunca ecoar na resposta de erro.

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const { tenantId, phone, pin, pinToken } = body || {};

  if (!tenantId) return json({ error: 'TENANT_REQUIRED' }, 400);
  if (!phone) return json({ error: 'PHONE_INVALID' }, 400);
  if (!pin) return json({ error: 'PIN_INVALID' }, 400);

  // Sem token nao ha como provar que este cadastro e seu. Corta aqui.
  if (!pinToken || !String(pinToken).trim()) {
    return json({ error: 'AUTH_REQUIRED' }, 401);
  }

  try {
    const supabase = getSupabaseAdminClient(env);

    const { data, error } = await supabase.rpc('driver_set_pin', {
      p_tenant_id: tenantId,
      p_phone: String(phone),
      p_pin: String(pin),
      p_pin_token: String(pinToken).trim(),
    });

    if (error) return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));

    // Depois do primeiro PIN, o caminho normal e driver-login. O token de setup
    // deixa de ser necessario e, com o status aprovado, ele morre na RPC.
    return new Response(
      JSON.stringify({ ok: data.ok === true, driverId: data.driverId }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
