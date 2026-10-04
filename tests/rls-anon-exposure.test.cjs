'use strict';

// ============================================================
// VERIFICACAO AO VIVO: a chave anon nao le dado de negocio
// ------------------------------------------------------------
// Desabilitado por padrao, como os demais live tests. Para rodar:
//   PowerShell:  $env:RUN_RLS_CHECK=1; npm run test:rls
//
// Nao usa a service_role. A chave anon e PUBLICA por design (ela ja
// esteve embutida no bundle do cliente e qualquer pessoa pode extrai-la
// do site), entao este teste pode rodar em qualquer ambiente sem
// expor nenhum segredo, e sem `pg` no package.json.
//
// Nao importe tests/helpers.cjs: aquele arquivo sobrescreve as envs
// com valores falsos (linhas 8-10) e este teste precisa da chave real.
//
// ------------------------------------------------------------
// POR QUE HTTP E NAO SQL
// ------------------------------------------------------------
// supabase/verify-rls-anon.sql emula o papel `anon` dentro do banco e
// faz a checagem profunda. Este arquivo faz o oposto: chama o
// PostgREST como um atacante chamaria, com a chave que ele teria em
// maos. Se uma policy permissiva for criada, ou se um GRANT for
// aberto, este teste falha mesmo que o SQL interno continue verde.
//
// ------------------------------------------------------------
// O QUE ESTE TESTE NAO PROVA
// ------------------------------------------------------------
// Ele diz que a chave anon nao le as 24 tabelas de negocio. NAO diz
// que o backend valida quem pode chamar o que: o backend usa
// service_role, que tem bypassrls e ignora RLS. A fronteira real do
// app e a validacao dentro das Netlify functions. Ver
// SECURITY-DECISIONS.md.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert');

// As 24 tabelas de app (owner postgres). A 25a tabela do schema public
// e spatial_ref_sys, da extensao postgis, e esta fora de escopo de
// proposito: ver o teste de sanidade do detector no fim deste arquivo.
const TABELAS = [
  'affiliate_rewards',
  'affiliates',
  'audit_logs',
  'billing_charges',
  'business_invites',
  'businesses',
  'campaigns',
  'coupon_templates',
  'coupons',
  'driver_documents',
  'driver_registration_tokens',
  'driver_sessions',
  'drivers',
  'idempotency_keys',
  'idempotency_keys_secret',
  'login_attempts',
  'outbound_messages',
  'referrals',
  'sessions',
  'shuttle_reservations',
  'shuttle_services',
  'tenants',
  'users',
  'vehicle_positions',
];

const BASE = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

function enabled() {
  if (!BASE || !ANON) {
    return 'defina NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY para checar o banco real';
  }
  return process.env.RUN_RLS_CHECK === '1'
    ? false
    : 'habilite com RUN_RLS_CHECK=1 para checar o banco real';
}

// Faz o GET com a chave anon e classifica a resposta.
//
// NUNCA devolve o corpo da resposta para o log: se este teste falhar
// justamente porque houve vazamento, imprimir as linhas jogaria PII
// real no log de CI. So status e contagem.
async function tentarLer(tabela) {
  const url = `${BASE}/rest/v1/${tabela}?select=*&limit=1`;
  const res = await fetch(url, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  const tipo = res.headers.get('content-type') || '';
  let corpo = null;
  if (tipo.includes('application/json')) {
    corpo = await res.json().catch(() => null);
  } else {
    await res.text().catch(() => null);
  }

  const linhas = Array.isArray(corpo) ? corpo.length : 0;

  if (res.status === 200) {
    return linhas > 0
      ? { veredito: 'VAZOU', detalhe: `200 com ${linhas} linha(s)` }
      : { veredito: 'negado', detalhe: '200 com 0 linhas (RLS denies)' };
  }
  // 401/403 = barrado na autenticacao ou no GRANT.
  // 404 = o PostgREST esconde a tabela quando o papel nao tem privilegio.
  if ([401, 403, 404].includes(res.status)) {
    return { veredito: 'negado', detalhe: `HTTP ${res.status}` };
  }
  // Qualquer outra coisa (5xx, rede, 400 inesperado) significa que o
  // teste em si falhou, nao que a seguranca passou. Reprovar e melhor
  // que passar em branco.
  return { veredito: 'ERRO', detalhe: `HTTP ${res.status} inesperado` };
}

test('anon nao le nenhuma das 24 tabelas de negocio', { skip: enabled() }, async () => {
  const vazando = [];
  const comErro = [];

  for (const tabela of TABELAS) {
    const r = await tentarLer(tabela);
    if (r.veredito === 'VAZOU') vazando.push(`${tabela} (${r.detalhe})`);
    if (r.veredito === 'ERRO') comErro.push(`${tabela} (${r.detalhe})`);
  }

  assert.deepStrictEqual(comErro, [], `a checagem em si falhou nestas tabelas: ${comErro.join(', ')}`);
  assert.deepStrictEqual(vazando, [], `VAZAMENTO: a chave anon leu estas tabelas: ${vazando.join(', ')}`);

  // Guarda contra o teste ficar verde sem ter checado nada.
  assert.strictEqual(TABELAS.length, 24, 'a lista de tabelas mudou; atualize o comentario do topo');
});

test('sanidade do detector: anon LE spatial_ref_sys (por isso o teste acima nao e vazio)', { skip: enabled() }, async () => {
  // spatial_ref_sys e a unica tabela do schema public com RLS desligada
  // (risco ja registrado e aceito em 2026-09-29, e o ALTER e bloqueado
  // com 42501 porque o owner e supabase_admin). Ela contem ~8.500 linhas
  // de definicao de SRID, dados publicos e sem PII.
  //
  // Se este teste PASSAR, o detector acima esta cego e o resultado
  // "0 vazamentos" nao significa nada. Ele existe para provar que o
  // harness sabe enxergar uma linha quando ela aparece.
  const r = await tentarLer('spatial_ref_sys');
  assert.strictEqual(r.veredito, 'VAZOU',
    `o detector nao enxergou uma tabela que DEVE ser legivel (${r.detalhe}). ` +
    'Entao o teste principal nao tem valor. Investigue antes de confiar nele.');
});