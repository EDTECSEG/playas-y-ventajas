'use strict';

// Guarda da retencao de idempotency_keys (supabase/p4-purge-idempotency-keys.sql).
//
// idempotency_keys guarda o resultado das operacoes idempotentes. Em
// operation='coupon.claim' esse resultado carrega o rawToken do cupom; em
// 'coupon.validate', nome e telefone do cliente. Sem ttl nem expurgo, segredo
// e dado pessoal ficavam retidos indefinidamente -- foi assim ate 2026-10-03,
// quando a p3 passou a gravar uma linha por resgate.
//
// Estes testes naoRodam a migration (isso e do Supabase, com MCP/CLI). Eles
// travam os invariantes no arquivo versionado, para o dia a dia nao mudar em
// silencio. A prova de que a funcao funciona, e de que o primeiro run vai
// apagar as linhas vencidas, sai do MCP.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const SQL = path.join(__dirname, '..', 'supabase', 'p4-purge-idempotency-keys.sql');
const ROLLBACK = path.join(__dirname, '..', 'supabase', 'p4-purge-idempotency-keys.rollback.sql');

test('os dois arquivos existem', () => {
  assert.ok(existsSync(SQL), 'falta supabase/p4-purge-idempotency-keys.sql');
  assert.ok(existsSync(ROLLBACK), 'falta o rollback correspondente');
});

const sql = readFileSync(SQL, 'utf8');
const rollback = readFileSync(ROLLBACK, 'utf8');

// O SQL documenta o que NAO faz ("Nao ha necessidade de SECURITY DEFINER...").
// Testar sobre o arquivo cru faria o proprio comentario do arquivo falhar o
// teste. As asserções de DDL olham o arquivo sem comentarios de linha.
const ddl = sql.replace(/^\s*--.*$/gm, '');
const ddlRollback = rollback.replace(/^\s*--.*$/gm, '');

test('a janela de retencao e 7 dias', () => {
  assert.ok(
    /make_interval\(days\s*=>\s*7\)/.test(ddl),
    'a politica de retencao precisa ser 7 dias (decisao do dono em 2026-10-03)',
  );
});

test('so apaga o que esta VENCIDO, nunca a tabela inteira', () => {
  assert.ok(/delete from idempotency_keys/.test(ddl), 'a funcao tem que apagar de idempotency_keys');
  assert.ok(
    /where created_at < now\(\) - make_interval/.test(ddl),
    'o DELETE precisa ter filtro de data: sem ele, um erro de digitacao limpa o cache inteiro',
  );
});

test('a migration NAO apaga nada sozinha', () => {
  // O expurgo e do job do cron. Se a migration tambem deletasse, subir o
  // arquivo ja seria um DELETE em producao sem ninguem pedir.
  const foraDaFuncao = ddl.slice(0, ddl.indexOf('create or replace function'));
  assert.ok(
    !/delete from/i.test(foraDaFuncao),
    'a migration nao pode conter DELETE: a limpeza e do cron, nao do deploy',
  );
});

test('o expurgo nao encosta no caminho critico de dinheiro', () => {
  // claim_coupon esta marcado como intocavel no codigo por emitir cupom e
  // mexer estoque. Um DELETE dentro dela arriscaria o resgate por causa de
  // limpeza.
  assert.ok(
    !/create or replace function[^;]*claim_coupon/i.test(ddl),
    'a p4 nao pode redefinir claim_coupon: o caminho de dinheiro e intocavel',
  );
  assert.ok(
    !/create or replace function[^;]*validate_and_redeem_coupon/i.test(ddl),
    'idem para validate_and_redeem_coupon',
  );
});

test('EXECUTE fica fechado para o cliente', () => {
  assert.ok(
    /revoke all on function public\.purge_expired_idempotency_keys\(\) from public, anon, authenticated;/.test(ddl),
    'a limpeza nao e uma operacao que o cliente possa pedir',
  );
});

test('a funcao NAO e SECURITY DEFINER', () => {
  // O job do cron roda como postgres, dono da tabela. SECURITY DEFINER aqui
  // nao resolveria nada e so serviria para ampliar o alcance da funcao.
  assert.ok(
    !/security\s+definer/i.test(ddl),
    'nao use SECURITY DEFINER: o cron ja roda como dono da tabela',
  );
  assert.ok(
    !/alter function[^;]*security\s+definer/i.test(ddl),
    'nem via ALTER FUNCTION',
  );
});

test('o search_path e fixado mesmo com INVOKER', () => {
  assert.ok(
    /set search_path to 'public', 'extensions'/.test(ddl),
    'search_path fixado evita que o objeto errado seja resolvido se o schema mudar de lugar',
  );
});

test('o agendamento e diario, de madrugada, e nao no minuto :00', () => {
  assert.ok(/cron\.schedule\(/.test(ddl), 'precisa agendar o job');
  assert.ok(
    /'23 4 \* \* \*'/.test(ddl),
    "esperado '23 4 * * *' (04:23 UTC = 01:23 em Brasilia). Nao usar :00, todo mundo agenda em :00",
  );
});

test('reaplicar o arquivo nao duplica o job nem o indice', () => {
  assert.ok(
    /cron\.unschedule\('purge-idempotency-keys'\)/.test(ddl),
    'precisa desagendar antes de agendar, senao reaplicar cria dois jobs',
  );
  assert.ok(
    /create index if not exists idempotency_keys_created_at_idx/.test(ddl),
    'o indice precisa ser IF NOT EXISTS para o arquivo ser reaplicavel',
  );
  assert.ok(/create or replace function/.test(ddl), 'a funcao precisa ser CREATE OR REPLACE');
});

test('o indice existe porque o filtro do expurgo e por created_at', () => {
  // A PK e (tenant_id, operation, idempotency_key): nao ajuda num filtro por
  // data. Sem este indice o DELETE faz seq scan todo dia.
  assert.ok(
    /on public\.idempotency_keys \(created_at\)/.test(ddl),
    'indice em created_at: sem ele o expurgo varre a tabela inteira',
  );
});

test('o rollback desfaz tudo e avisa que as linhas nao voltam', () => {
  assert.ok(/cron\.unschedule\('purge-idempotency-keys'\)/.test(ddlRollback), 'desagendar');
  assert.ok(/drop function if exists public\.purge_expired_idempotency_keys\(\)/.test(ddlRollback), 'dropar a funcao');
  assert.ok(/drop index if exists public\.idempotency_keys_created_at_idx/.test(ddlRollback), 'dropar o indice');
  assert.ok(
    /NAO restaura as linhas vencidas/i.test(rollback),
    'o rollback tem que avisar que o DELETE do cron e irreversivel',
  );
});

test('nenhum arquivo novo tem BOM nem caractere de substituicao', () => {
  for (const [nome, txt] of [['p4', sql], ['rollback p4', rollback]]) {
    assert.ok(!txt.startsWith('\uFEFF'), nome + ' comecando com BOM');
    assert.ok(!txt.includes('\uFFFD'), nome + ' com caractere de substituicao (U+FFFD)');
  }
});