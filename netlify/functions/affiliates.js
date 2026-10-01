// Afiliados (Modelo A - recompensa em cupom).
// Publico, sem sessao: o vinculo e por telefone.
//   POST /  { name, phone, email?, kind? }   -> affiliate_register
//   GET  /?affiliateId=..&phone=..           -> affiliate_dashboard
const { getSupabaseAdminClient } = require('./_supabaseAdmin');

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

// Deduplicacao SEMPRE em digitos. A busca anterior era igualdade exata no
// texto do telefone, entao "22 99833-6286" e "22 99833-6286 " (espaco no
// fim) passavam uma pela outra e a mesma pessoa recebia DOIS codigos de
// indicacao. A coluna phone_digits e gerada pelo Postgres a partir do phone,
// entao nao ha como a comparacao divergir de novo.
function phoneDigits(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// Os mesmos valores do CHECK affiliates_kind_check. Kind fora da lista cai em
// 'customer' em vez de devolver o erro cru do Postgres ("violates check
// constraint"), que nao diz nada para quem cadastrou.
const KINDS = ['customer', 'driver', 'business'];

exports.handler = async (event) => {
  try {
    const supabase = getSupabaseAdminClient();

    if (event.httpMethod === 'POST') {
      const { name, phone, email, kind } = JSON.parse(event.body || '{}');
      if (!name || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'nome e telefone obrigatórios' }) };
      const digits = phoneDigits(phone);
      if (!digits) return { statusCode: 400, body: JSON.stringify({ error: 'telefone inválido' }) };
      // Idempotente por telefone: o mesmo cliente nunca cria afiliado duplicado.
      // O card de /cliente chama este endpoint a cada 'indicar amigo'.
      // created_at asc + limit(1): se ainda houver duplicado antigo, o mais
      // antigo manda e o codigo existente do afiliado nao muda de tempos em
      // tempos. maybeSingle() segura o resultado em no maximo uma linha.
      const { data: existing, error: lookErr } = await supabase
        .from('affiliates')
        .select('id, referral_code')
        .eq('tenant_id', TENANT_ID)
        .eq('phone_digits', digits)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!lookErr && existing) {
        return { statusCode: 200, body: JSON.stringify({ affiliateId: existing.id, referralCode: existing.referral_code, shareUrl: '/?ref=' + existing.referral_code }) };
      }
      const { data, error } = await supabase.rpc('affiliate_register', {
        p_tenant_id: TENANT_ID, p_name: name, p_phone: phone,
        p_email: email || null, p_kind: KINDS.includes(kind) ? kind : 'customer',
      });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: (error.message || '').split(':')[0].trim() }) };
      return { statusCode: 200, body: JSON.stringify(data) };
    }

    if (event.httpMethod === 'GET') {
      const { affiliateId, phone } = event.queryStringParameters || {};
      if (!affiliateId || !phone) return { statusCode: 400, body: JSON.stringify({ error: 'affiliateId e phone obrigatórios' }) };
      const { data, error } = await supabase.rpc('affiliate_dashboard', {
        p_tenant_id: TENANT_ID, p_affiliate_id: affiliateId, p_phone: phone,
      });
      if (error) return { statusCode: 400, body: JSON.stringify({ error: error.message }) };
      // Sem match de telefone/afiliado o dashboard vem null: devolve vazio.
      const dash = data || {};

      // `rewardStatus` NAO vem de affiliate_dashboard. A tela /afiliado le esse
      // campo em dois lugares (o "Recompensa: ..." do painel e o texto da folha
      // de divulgacao) e, sem esta chamada, recebia sempre undefined: o painel
      // mostrava "—" e a folha caia sempre no "peca confirmacao", porque a
      // condicao `=== 'active'` nunca era verdadeira. Codigo morto apontando
      // para um campo que ninguem devolvia.
      //
      // affiliate_reward_status responde POR QUE a recompensa nao caiu, em vez
      // de so dizer que nao caiu:
      //   'ok'                 - tem tudo, pode creditar
      //   'semCadastroCliente' - o premio nao tem onde cair
      //   'semTemplate'        - falta configuracao do estabelecimento
      //
      // Degrada em silencio: se a RPC nao existir no banco, ou falhar, o painel
      // volta ao comportamento anterior em vez de virar 500 -- o diagnostico e
      // um extra, nao a funcao principal do endpoint. O `customerId` que a RPC
      // devolve e descartado de proposito: a tela nao precisa dele e nao ha
      // razao para mandar um UUID de cliente ao navegador.
      let rewardStatus;
      try {
        const { data: rs, error: rsErr } = await supabase.rpc('affiliate_reward_status', {
          p_tenant_id: TENANT_ID, p_affiliate_id: affiliateId,
        });
        if (rsErr) throw new Error(rsErr.message || 'erro desconhecido');
        if (rs && rs.pendingReason) {
          rewardStatus = rs.pendingReason === 'ok' ? 'active' : rs.pendingReason;
        }
      } catch (rsEx) {
        console.warn('affiliates: affiliate_reward_status indisponivel (' + (rsEx && rsEx.message) + ')');
      }

      return {
        statusCode: 200,
        body: JSON.stringify(rewardStatus ? { ...dash, rewardStatus } : dash),
      };
    }

    return { statusCode: 405, body: '{}' };
  } catch (err) {
    console.error('affiliates: ' + (err && err.message));
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};