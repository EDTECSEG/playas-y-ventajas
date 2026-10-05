'use strict';

// Guarda de migration para a cota de cupons do plano FREE (p8).
//
// Nao testa o banco: testa o ARQUIVO. Estas migracoes sao aplicadas a mao, e o
// modo como elas quebram e silencioso. O caso mais caro desta p8 e a ordem: se
// a cota entrar antes do replay idempotente, um retry de rede que o cliente
// nao confirmou passa a devolver FREE_COUPON_QUOTA_EXCEEDED para um cupom que
// ele JA TEM, e o dono da empresa perde um cupom sem o cliente ter recebido
// nada. Nada disso aparece em teste de interface -- so em producao, no primeiro
// resgate com chave depois do limite.
//
// O comportamento contra o Postgres foi conferido a mao (12 tentativas em FREE,
// 12 em PRO, replay, NULL de plan, falha do INSERT); aqui o que importa e o
// INVARIANTE: o que o codigo depende e o que o arquivo precisa continuar
// garantindo.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const P8 = path.join(ROOT, 'supabase', 'p8-cota-free-cupons.sql');
const RB = path.join(ROOT, 'supabase', 'p8-cota-free-cupons.rollback.sql');
const EMPRESA = path.join(ROOT, 'netlify', 'functions', 'empresa.js');
const CLIENTE = path.join(ROOT, 'app', 'cliente', 'page.jsx');

const src = fs.readFileSync(P8, 'utf8');
const rb = fs.readFileSync(RB, 'utf8');
const empresa = fs.readFileSync(EMPRESA, 'utf8');
const cliente = fs.readFileSync(CLIENTE, 'utf8');

// Sem os comentarios '--'. Necessario porque este arquivo explica bastante
// sobre a cota, e uma busca por /cota/i sobre o texto inteiro acusaria a prosa
// que descreve o que a migration NAO faz. Nenhum literal do p8 contem '--', entao
// o corte e seguro aqui.
const sqlOnly = src.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
const rbOnly = rb.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

test('a p8 e o rollback existem e nao tem BEGIN/COMMIT', () => {
  assert.ok(fs.existsSync(P8), 'p8-cota-free-cupons.sql nao existe');
  assert.ok(fs.existsSync(RB), 'p8-cota-free-cupons.rollback.sql nao existe');
  for (const [nome, txt] of [['p8', src], ['rollback', rb]]) {
    assert.ok(!/^\s*begin\s*;/im.test(txt), `BEGIN solto na ${nome}`);
    assert.ok(!/^\s*commit\s*;/im.test(txt), `COMMIT solto na ${nome}`);
  }
});

test('as duas colunas da cota sao not null com o default certo', () => {
  assert.match(sqlOnly, /add column if not exists\s+free_coupon_allowance\s+integer\s+not null\s+default 10/i);
  assert.match(sqlOnly, /add column if not exists\s+free_coupons_used\s+integer\s+not null\s+default 0/i);
  // Um default diferente de 10 muda a regra do dono silenciosamente: toda
  // empresa nova nasceria com outra cota, e so apareceria um resgate a mais ou
  // a menos semanas depois.
  assert.ok(!/add column if not exists\s+free_coupon_allowance\s+integer\s+not null\s+default\s+(?!10\b)\d+/i.test(sqlOnly), 'default da allowance mudou');
});

test('as duas colunas tem check nao-negativo', () => {
  // Sem isto, um -1 digitado numa tela de admin valeria 11 cupons de graca.
  assert.match(sqlOnly, /add constraint\s+businesses_free_coupon_allowance_nonneg\s+check\s*\(\s*free_coupon_allowance\s*>=\s*0\s*\)/i);
  assert.match(sqlOnly, /add constraint\s+businesses_free_coupons_used_nonneg\s+check\s*\(\s*free_coupons_used\s*>=\s*0\s*\)/i);
});

test('claim_coupon e recriada com a MESMA assinatura de 7 parametros da p5', () => {
  // Mudar a assinatura quebra o handler em producao na hora do deploy, e o
  // erro no cliente e "function claim_coupon is not unique" ou "does not
  // exist" -- nunca um aviso sobre a cota.
  const assinatura = 'claim_coupon(uuid, uuid, text, text, text, text, text)';
  assert.match(sqlOnly, new RegExp(`drop function if exists\\s+public\\.${assinatura.replace(/[()]/g, '\\$&')}`, 'i'));
  assert.match(sqlOnly, /create function public\.claim_coupon\(\s*p_tenant_id uuid,\s*p_template_id uuid,\s*p_customer_phone text,\s*p_customer_name text,\s*p_customer_instagram text default null::text,\s*p_customer_email text default null::text,\s*p_idempotency_key text default null::text\s*\)/i);
  assert.ok(!/create or replace function public\.claim_coupon/i.test(sqlOnly), 'CREATE OR REPLACE deixaria versao antiga com os dois DEFAULTs');
});

test('claim_coupon continua security definer com search_path travado', () => {
  const corpo = sqlOnly.slice(sqlOnly.indexOf('create function public.claim_coupon'));
  assert.match(corpo, /security definer/i, 'claim_coupon deixou de ser security definer');
  assert.match(corpo, /set search_path = 'public', 'extensions'/i, 'search_path nao travado');
  assert.match(sqlOnly, /revoke execute on function public\.claim_coupon\(uuid, uuid, text, text, text, text, text\) from public, anon, authenticated/i);
  assert.match(sqlOnly, /grant\s+execute on function public\.claim_coupon\(uuid, uuid, text, text, text, text, text\) to service_role/i);
});

test('a cota e UM UPDATE condicional, e nao ler-depois-escrever', () => {
  // A forma quebrada seria:
  //   select free_coupons_used into v_used from businesses where id = ...;
  //   if v_used < v_allowance then
  //     update businesses set free_coupons_used = v_used + 1 ...
  // Dois resgates simultaneos do MESMO negocio passariam os dois com used = 9 e
  // o allowance estouraria para 11 sem ninguem notar. E o tipo de bug que so
  // aparece no pico de um evento.
  const incrementos = sqlOnly.match(/free_coupons_used = free_coupons_used \+ 1/g) || [];
  assert.strictEqual(incrementos.length, 1, `esperava 1 incremento da cota, achei ${incrementos.length}`);
  assert.ok(!/select[\s\S]{0,200}free_coupons_used\s+into/i.test(sqlOnly), 'a cota le free_coupons_used antes de escrever');

  // O incremento e o predicado tem de estar no MESMO statement: e o predicado
  // no WHERE que faz o UPDATE devolver zero linhas quando o saldo acabou.
  const update = sqlOnly.slice(sqlOnly.indexOf('set free_coupons_used = free_coupons_used + 1'));
  const fim = update.indexOf(';');
  assert.match(update.slice(0, fim), /free_coupons_used\s*<\s*free_coupon_allowance/i, 'o WHERE condicional nao esta no mesmo UPDATE do incremento');
});

test('sem saldo, o resgate e recusado com FREE_COUPON_QUOTA_EXCEEDED', () => {
  // `if not found` e o que traduz "zero linhas afetadas" em erro. Sem ele o
  // resgate seguiria e emitiria um cupom que a empresa nao pode ter.
  assert.match(sqlOnly, /update businesses\s+set free_coupons_used = free_coupons_used \+ 1[\s\S]{0,220}if not found then raise exception 'FREE_COUPON_QUOTA_EXCEEDED'/i);
});

test('a ordem e: replay idempotente < limite do cliente < cota < insert do cupom', () => {
  const iReplay = sqlOnly.indexOf('from idempotency_keys');
  const iLimite = sqlOnly.indexOf("raise exception 'LIMIT_REACHED");
  const iCota = sqlOnly.indexOf('set free_coupons_used = free_coupons_used + 1');
  const iInsert = sqlOnly.indexOf('insert into coupons');
  const iErro = sqlOnly.indexOf("raise exception 'FREE_COUPON_QUOTA_EXCEEDED'");
  for (const [nome, i] of [['replay', iReplay], ['LIMIT_REACHED', iLimite], ['cota', iCota], ['insert do cupom', iInsert], ['erro da cota', iErro]]) {
    assert.ok(i >= 0, `nao encontrei ${nome} no arquivo`);
  }
  assert.ok(iReplay < iCota, 'a cota ficou ANTES do replay: um retry devolveria FREE_COUPON_QUOTA_EXCEEDED para um cupom que o cliente ja tem');
  assert.ok(iLimite < iCota, 'a cota ficou antes de LIMIT_REACHED: o cliente veria "esgotou a cota" no lugar do erro que ele pode resolver sozinho');
  assert.ok(iCota < iInsert, 'a cota ficou DEPOIS do insert: o cupom seria emitido antes de saber se havia saldo');
  assert.ok(iCota < iErro, 'o erro da cota nao vem da propria zona da cota');
});

test('billing_plan NULL conta como FREE nos tres pontos', () => {
  // businesses.billing_plan nao tem NOT NULL e veio do banco assim. Uma empresa
  // com NULL pagaria taxa igual a FREE (p2:75), logo tem de ter a mesma cota:
  // sem o coalesce, a empresa mais exposta do sistema ficaria sem limite.
  const coalesces = sqlOnly.match(/coalesce\(b\.billing_plan, 'FREE'\) = 'FREE'/g) || [];
  assert.ok(coalesces.length >= 3, `esperava coalesce no backfill, no claim e na RPC; achei ${coalesces.length}`);
  // A RPC devolve 'plan' para o consumidor final: com o coalesce, um NULL
  // chega como 'FREE' e nao como null ao lado de limited = true.
  assert.match(sqlOnly, /'plan',\s*coalesce\(b\.billing_plan, 'FREE'\)/i, 'a RPC devolve plan null para uma empresa que e FREE');
});

test('business_coupon_allowance e security definer, search_path travado e so service_role', () => {
  // Sem revoke, qualquer authenticated leria a cota de qualquer empresa por id.
  assert.match(sqlOnly, /create function public\.business_coupon_allowance\(\s*p_tenant_id uuid,\s*p_actor_user_id uuid\s*\)/i);
  const corpo = sqlOnly.slice(sqlOnly.indexOf('create function public.business_coupon_allowance'));
  assert.match(corpo, /security definer/i);
  assert.match(corpo, /set search_path = 'public', 'extensions'/i);
  assert.match(sqlOnly, /revoke execute on function public\.business_coupon_allowance\(uuid, uuid\) from public, anon, authenticated/i);
  assert.match(sqlOnly, /grant\s+execute on function public\.business_coupon_allowance\(uuid, uuid\) to service_role/i);
  // O escopo tem de vir do ator, com papel de empresa.
  assert.match(corpo, /v_actor\.role not in \('MERCHANT','ADMIN','STAFF','SUPER_ADMIN'\)/i, 'a RPC de cota nao checa papel de empresa');
  assert.ok(!/p_business_id/.test(corpo), 'a RPC de cota nao pode receber business_id do cliente (IDOR)');
});

test('o backfill conta cupom vivo e so mexe em empresa FREE', () => {
  assert.match(sqlOnly, /set free_coupons_used = c\.n[\s\S]{0,260}where status <> 'CANCELLED'[\s\S]{0,120}group by business_id/i, 'o backfill nao conta cupom cancelado');
  assert.match(sqlOnly, /where c\.business_id = b\.id and coalesce\(b\.billing_plan, 'FREE'\) = 'FREE';/i, 'o backfill do used toca empresa que nao e FREE');
});

test('a grandclause so ELEVA o allowance, e nunca o reduz', () => {
  // Decisao do dono: ambiente ainda em teste, campanhas e cupons ja emitidos
  // ficam como estao. O UPDATE da p8 nao pode apagar nada nem DROPAR nada --
  // e o que faria um rollout parecer "limpar os cupons de teste".
  assert.match(sqlOnly, /set free_coupon_allowance = c\.n/i);
  // `c.n > b.free_coupon_allowance` e o que impede uma empresa dentro do limite
  // de ter a cota alterada para o valor exato do que usou (que daria saldo 0 a
  // uma empresa que ainda tem cupom a perder).
  assert.match(sqlOnly, /and coalesce\(b\.billing_plan, 'FREE'\) = 'FREE' and c\.n > b\.free_coupon_allowance;/i, 'a grandclause nao tem a condicao de elevar apenas');
});

test('nem a p8 nem o rollback apagam cupom ou campanha', () => {
  for (const [nome, txt] of [['p8', sqlOnly], ['rollback', rbOnly]]) {
    assert.ok(!/delete\s+from\s+(public\.)?(coupons|coupon_templates|coupon_campaigns|campaigns)/i.test(txt), `${nome} apaga cupom ou campanha`);
    assert.ok(!/drop\s+table[^;]*\b(coupons|coupon_templates|coupon_campaigns|campaigns)\b/i.test(txt), `${nome} derruba tabela de cupom/campanha`);
  }
});

test('o rollback restaura a claim_coupon CIFRADA da p5, e nao a da p3', () => {
  // O erro caro aqui seria voltar para a versao em texto claro (o rollback da
  // p5): o rawToken passaria a ser gravado em claro e o motivo do rollback
  // estaria piorando o problema.
  assert.match(rbOnly, /insert into idempotency_keys \(tenant_id, operation, idempotency_key, result_enc\)/i, 'o rollback voltou a gravar em texto claro');
  assert.ok(!/insert into idempotency_keys \(tenant_id, operation, idempotency_key, result\)/i.test(rbOnly), 'o rollback gravou result em texto claro');
  assert.match(rbOnly, /pgp_sym_encrypt/i, 'o rollback perdeu a cifragem do pgcrypto');
  // E tem de devolver a mesma assinatura que o handler em producao chama.
  assert.match(rbOnly, /create function public\.claim_coupon\([\s\S]{0,400}?p_idempotency_key text default null::text\s*\)/i);
  assert.match(rbOnly, /revoke execute on function public\.claim_coupon\(uuid, uuid, text, text, text, text, text\) from public, anon, authenticated/i);
});

test('o rollback tira a RPC de leitura antes de tirar as colunas', () => {
  // Ao contrario: derrubar as colunas primeiro deixa a RPC viva apontando para
  // colunas inexistentes, e ela so falha no runtime de quem a chama.
  const iFuncao = rbOnly.indexOf('drop function if exists public.business_coupon_allowance');
  const iColuna = rbOnly.indexOf('drop column if exists free_coupon_allowance');
  assert.ok(iFuncao >= 0 && iColuna >= 0);
  assert.ok(iFuncao < iColuna, 'a RPC precisa cair antes das colunas que ela le');
});

test('a migration nao faz DELETE em idempotency_keys (a p5 que e dona dessas linhas)', () => {
  assert.ok(!/delete\s+from\s+(public\.)?idempotency_keys/i.test(sqlOnly), 'a p8 mexe nas linhas da p5');
});

test('o handler degrada enquanto a p8 nao estiver aplicada', () => {
  // /empresa sobe antes da p8 (ou se ela falhar). A RPC nao existindo precisa
  // virar `available:false` -- nunca 500, e nunca limited:false com numbers
  // inventados, que a tela leria como "cota zero".
  assert.match(empresa, /mode === 'allowance'/, 'o mode=allowance nao existe no handler');
  assert.match(empresa, /business_coupon_allowance/i);
  assert.match(empresa, /available: false/, 'sem degradacao a tela cai em 500 antes da p8');
  assert.match(empresa, /'Cache-Control': 'no-store'/, 'a cota e dado do negocio: nunca em cache');
  assert.ok(!/p_business_id|businessId: body/.test(empresa.slice(empresa.indexOf("mode === 'allowance'"), empresa.indexOf('empresa_dashboard'))), 'o modo allowance nao pode aceitar businessId da query (IDOR)');
});

test('o cliente final nunca ve o codigo cru da cota', () => {
  // O handler devolve so o codigo (nunca o detail do Postgres). Se a tela
  // mostrar `FREE_COUPON_QUOTA_EXCEEDED`, o cliente final le um erro de banco
  // em vez de "esta empresa ja usou os cupons gratis".
  assert.match(cliente, /FREE_COUPON_QUOTA_EXCEEDED:\s*t\?\./, 'a cota nao tem frase amigavel no /cliente');
  assert.ok(/function claimErrorMessage\(code, t\)/.test(cliente), 'claimErrorMessage ausente');
  assert.ok(/claimErrorMessage\(\(data && data\.error\)/.test(cliente), 'o tratamento de erro nao passa por claimErrorMessage');
  // Fallback generico obrigatorio: um codigo novo no banco nao pode virar
  // texto cru na tela do cliente.
  assert.match(cliente, /return map\[code\] \|\| \(t\?\.claimGenericFail/, 'sem fallback generico, codigo desconhecido vaza para a tela');
});