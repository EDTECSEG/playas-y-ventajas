'use strict';

// Guarda da cifragem do resultado de coupon.claim (supabase/p5-cifrar-idempotency-keys.sql).
//
// Em operation='coupon.claim' a linha de idempotency_keys carrega o rawToken do
// cupom -- o mesmo valor que vai no QR e da direito ao desconto. Ate 2026-10-03
// esse campo estava em texto claro e service_role tinha SELECT na tabela, entao
// qualquer leitura parcial (replica, export, job de BI, log de query) expurrava
// todos os tokens ativos de uma vez. A p5 grava em result_enc, cifrado, com a
// chave numa tabela que so o postgres le.
//
// operation='coupon.validate' continua em texto claro, de proposito: ali o que
// ha e nome e telefone, nao segredo. Ver o cabecalho da p5.
//
// Estos testes naoRodam a migration (isso e do Supabase, com MCP/CLI). Travam os
// invariantes no arquivo versionado. A prova de que a cifra funciona e de que
// o token nao aparece em claro nos bytes gravados sai do MCP.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const SQL = path.join(__dirname, '..', 'supabase', 'p5-cifrar-idempotency-keys.sql');
const ROLLBACK = path.join(__dirname, '..', 'supabase', 'p5-cifrar-idempotency-keys.rollback.sql');

test('os dois arquivos existem', () => {
  assert.ok(existsSync(SQL), 'falta supabase/p5-cifrar-idempotency-keys.sql');
  assert.ok(existsSync(ROLLBACK), 'falta o rollback correspondente');
});

const sql = readFileSync(SQL, 'utf8');
const rollback = readFileSync(ROLLBACK, 'utf8');

// O SQL documenta o que NAO protege ("dump completo do banco: leva a tabela e a
// chave juntas"). Testar sobre o arquivo cru faria o proprio comentario falhar o
// teste. As asserções de DDL olham o arquivo sem comentarios de linha.
const ddl = sql.replace(/^\s*--.*$/gm, '');
const ddlRollback = rollback.replace(/^\s*--.*$/gm, '');

// ---------------------------------------------------------------------------
// O BUG QUE ESTE ARQUIVO EXISTE PARA NAO REPETIR
// ---------------------------------------------------------------------------
// A p5 foi aplicada uma vez com a chave em bytea e pgp_sym_encrypt(v_result::text,
// v_key) onde v_key era bytea. Em producao (pgcrypto 1.3 / PG 17.6) isso deu
// ERROR 42883: function pgp_sym_encrypt(text, bytea) does not exist. A senha do
// pgcrypto e text dos dois lados; so o texto cifrado e bytea.
//
// O bug so aparecia no caminho COM idempotencyKey, e o frontend ainda nao havia
// sido publicado, entao ninguem no ar foi afetado. O round-trip no MCP pegou --
// nenhum teste pegou, porque nao havia teste. Estes travam a assinatura.

test('a chave e text, nunca bytea', () => {
  assert.ok(
    /key\s+text\s+not\s+null/.test(ddl),
    'a coluna da chave tem que ser text: pgp_sym_encrypt/pgp_sym_decrypt recebem text como senha',
  );
  assert.ok(
    !/key\s+bytea/.test(ddl),
    'a chave nao pode ser bytea: nao existe pgp_sym_encrypt(text, bytea) no pgcrypto 1.3',
  );
});

test('a variavel da chave dentro da funcao tambem e text', () => {
  // Se a coluna virar text mas a variavel continuar bytea, o erro reaparece em
  // tempo de execucao e nao de compilacao -- que e exatamente o que aconteceu.
  assert.ok(/v_key\s+text;/.test(ddl), 'declare v_key text');
  assert.ok(!/v_key\s+bytea;/.test(ddl), 'v_key nao pode ser bytea');
});

test('a cifragem e a decifragem usam a assinatura que existe', () => {
  assert.ok(
    /pgp_sym_encrypt\(v_result::text,\s*v_key\)/.test(ddl),
    'esperado pgp_sym_encrypt(v_result::text, v_key): texto no primeiro arg, senha no segundo',
  );
  assert.ok(
    /pgp_sym_decrypt\(v_cipher,\s*v_key\)/.test(ddl),
    'esperado pgp_sym_decrypt(v_cipher, v_key): bytea no primeiro arg, senha no segundo',
  );
});

test('a chave e gerada em base64, com 256 bits', () => {
  assert.ok(
    /encode\(gen_random_bytes\(32\),\s*'base64'\)/.test(ddl),
    'encode(gen_random_bytes(32), \'base64\'): 32 bytes = 256 bits, e base64 deixa a chave legivel',
  );
  assert.ok(
    !/values\s*\(\s*true,\s*gen_random_bytes\(32\)\s*\)/.test(ddl),
    'nao grave gen_random_bytes direto: em coluna text isso vira lixo nao imprimivel',
  );
});

test('a chave tem trava de tamanho', () => {
  // 44 chars = 32 bytes em base64. Um INSERT futuro com valor hardcoded fraco
  // ou uma chave truncada por edicao manual caem aqui.
  assert.ok(
    /check\s*\(\s*length\(key\)\s*>=\s*40\s*\)/.test(ddl),
    'a constraint de tamanho impede chave curta por engano',
  );
});

// ---------------------------------------------------------------------------
// O QUE A CIFRAGEM PRECISA PRESERVAR
// ---------------------------------------------------------------------------

test('coupon.claim nunca grava texto claro', () => {
  // Toda insercao da p5 em idempotency_keys tem que ir para result_enc. Se
  // alguem adicionar um insert com `result`, o segredo volta a vazar e o
  // CHECK XOR barra em vez de deixar passar.
  const inserts = ddl.match(/insert into idempotency_keys[^;]*;/gi) || [];
  assert.ok(inserts.length >= 1, 'a p5 tem que gravar o resultado da claim');
  for (const ins of inserts) {
    assert.ok(
      /result_enc/.test(ins),
      'toda insercao em idempotency_keys na p5 tem que usar result_enc: ' + ins.trim(),
    );
  }
});

test('result vira nullable e result_enc e criada', () => {
  assert.ok(
    /alter column result drop not null/.test(ddl),
    'result precisa aceitar nulo: as linhas de claim ficam so em result_enc',
  );
  assert.ok(
    /add column if not exists result_enc bytea/.test(ddl),
    'result_enc e bytea: e o texto cifrado, nao a chave',
  );
});

test('o CHECK garante exatamente um dos dois preenchido', () => {
  // XOR. Sem isto uma linha pode ficar sem nada (replay quebrado em silencio) ou
  // com os dois (texto claro convivendo com a cifra).
  assert.ok(
    /check\s*\(\s*\(result\s+is\s+null\)\s*<>\s*\(result_enc\s+is\s+null\)\s*\)/.test(ddl),
    'esperado check ((result is null) <> (result_enc is null))',
  );
});

test('o replay decifra e devolve idempotent=true', () => {
  // E o que a idempotencia inteira existe para fazer. Perder o caminho de
  // decrypt deixaria a segunda chamada emitir um segundo cupom.
  assert.ok(
    /jsonb_build_object\('idempotent',\s*true\)/.test(ddl),
    'o replay precisa marcar idempotent=true',
  );
  assert.ok(
    /v_cached\s*\|\|\s*jsonb_build_object\('idempotent',\s*true\)/.test(ddl),
    'o replay devolve o resultado decifrado + idempotent, nao um objeto novo',
  );
});

test('falha de decifragem vira erro limpo, sem detalhe da cifra', () => {
  // Sem este tratamento, chave trocada ou ausente propaga o erro do pgcrypto,
  // que pode carregar byte da cifra na mensagem.
  assert.ok(
    /exception when others then[\s\S]{0,200}raise exception 'IDEMPOTENCY_UNAVAILABLE'/.test(ddl),
    'erro de decifragem tem que virar IDEMPOTENCY_UNAVAILABLE',
  );
  assert.ok(
    /if v_key is null then\s+raise exception 'IDEMPOTENCY_UNAVAILABLE'/.test(ddl),
    'chave ausente tem que falhar explicito, antes de tentar cifrar',
  );
});

test('claim_coupon continua SECURITY DEFINER (e por isso consegue ler a chave)', () => {
  // A chave e restrita a postgres. Se a funcao virar INVOKER, o resgate com
  // idempotencyKey passa a falhar com IDEMPOTENCY_UNAVAILABLE.
  assert.ok(
    /security\s+definer/.test(ddl),
    'claim_coupon tem que rodar como postgres para ler a chave',
  );
  assert.ok(
    /set search_path to 'public', 'extensions'/.test(ddl),
    "as funcoes do pgcrypto vivem em 'extensions': sem isso no search_path a cifragem nao resolve",
  );
});

test('validate_and_redeem_coupon NAO e tocada', () => {
  // E INVOKER e roda como service_role, que nao le a chave. Cifrar as duas
  // exigiria dar a chave ao service_role ou promover a funcao a DEFINER numa
  // rota de dinheiro. Fora de escopo, por proposito.
  assert.ok(
    !/validate_and_redeem_coupon/i.test(ddl),
    'a p5 nao pode redefinir validate_and_redeem_coupon: ali nao ha segredo, so PII',
  );
});

// ---------------------------------------------------------------------------
// ACESSO A CHAVE
// ---------------------------------------------------------------------------

test('ninguem alem do postgres le a chave', () => {
  // E o ponto da migration inteira. service_role mantem SELECT em
  // idempotency_keys, entao e justamente ele que nao pode ler a chave.
  assert.ok(
    /revoke all on table public\.idempotency_keys_secret from public, anon, authenticated, service_role;/.test(ddl),
    'a tabela da chave nao pode conceder nada a ninguem alem do postgres',
  );
});

test('nao existe GRANT devolvendo acesso a chave', () => {
  assert.ok(
    !/grant[^;]*idempotency_keys_secret/i.test(ddl),
    'nenhum GRANT na tabela da chave, em nenhuma forma',
  );
});

test('a tabela da chave so pode ter uma linha', () => {
  // PRIMARY KEY sozinho permitiria varias linhas com singleton=false, e ai a
  // funcao leria uma delas por engano e o replay decryptaria errado.
  assert.ok(
    /idempotency_keys_secret_unica\s+check\s*\(\s*singleton\s*\)/.test(ddl),
    'falta o check (singleton)',
  );
});

// ---------------------------------------------------------------------------
// REAPLICABILIDADE
// ---------------------------------------------------------------------------

test('reaplicar o arquivo nao gera uma chave nova', () => {
  // Se o ON CONFLICT sumisse, um re-apply trocaria a chave e TODAS as linhas ja
  // cifradas ficariam indecifraveis -- sem volta, porque o DELETE da tabela nao
  // e reversivel por este arquivo.
  assert.ok(
    /on conflict \(singleton\) do nothing/.test(ddl),
    'o ON CONFLICT DO NOTHING e o que impede a regeneracao da chave',
  );
});

test('o arquivo se autocorrige onde a versao com bytea ja rodou', () => {
  // Este projeto JA aplicou a p5 quebrada. Nao ha como reescrever o historico
  // de migrations, entao o arquivo precisa consertar o estado, nao so describir
  // o estado desejado.
  assert.ok(
    /alter column key type text using key::text/.test(ddl),
    'falta o ALTER COLUMN ... TYPE text que conserta o ambiente onde a p5 quebrada rodou',
  );
});

test('a migration nao apaga nem altera dados existentes', () => {
  // Subir o arquivo tem que ser estrutural. Um DELETE aqui seria perda de dados
  // em deploy sem ninguem pedir.
  assert.ok(
    !/delete\s+from/i.test(ddl),
    'a p5 nao pode conter DELETE: e uma migration de esquema',
  );
  assert.ok(
    !/truncate/i.test(ddl),
    'a p5 nao pode conter TRUNCATE',
  );
});

test('DROP da funcao e sem CASCADE', () => {
  // Com CASCADE, dependencia inesperada derrubaria junto em vez de abortar.
  assert.ok(
    !/drop function[^;]*cascade/i.test(ddl),
    'drop function sem cascade: dependencia inesperada tem que abortar a migration',
  );
});

// ---------------------------------------------------------------------------
// ROLLBACK
// ---------------------------------------------------------------------------

test('o rollback desfaz a coluna, a chave e a funcao', () => {
  assert.ok(
    /drop table if exists public\.idempotency_keys_secret/.test(ddlRollback),
    'derrubar a tabela da chave',
  );
  assert.ok(
    /alter column result set not null/.test(ddlRollback),
    'devolver o NOT NULL de result',
  );
  assert.ok(
    /alter column result_enc drop column/.test(ddlRollback) ||
      /drop column if exists result_enc/.test(ddlRollback),
    'derrubar a coluna result_enc',
  );
});

test('o rollback apaga as linhas cifradas em vez de tentar converter', () => {
  // pgp_sym_encrypt nao e reversivel sem a chave. As opcoes seriam guardar a
  // chave em claro no dump ou aceitar o token como perdido. Perder um cache e
  // melhor que reintroduzir o segredo em claro.
  assert.ok(
    /delete from idempotency_keys where operation = 'coupon\.claim' and result_enc is not null/.test(ddlRollback),
    'as linhas de claim cifradas tem que ser apagadas no rollback',
  );
  assert.ok(
    /perder um cache/i.test(rollback),
    'o rollback tem que registrar por que apaga em vez de converter',
  );
});

test('o rollback avisa que volta a um estado menos seguro', () => {
  assert.ok(
    /ESTADO MENOS SEGURO/i.test(rollback),
    'quem rodar o rollback precisa saber que religa o texto claro',
  );
});

test('o rollback restaura a claim em texto claro da p3', () => {
  // Contraria proposital: o rollback volta ao comportamento da p3, com `result`.
  const inserts = ddlRollback.match(/insert into idempotency_keys[^;]*;/gi) || [];
  assert.ok(inserts.length >= 1, 'o rollback precisa gravar o cache da claim');
  for (const ins of inserts) {
    assert.ok(
      /\)(\s*)values/i.test(ins) || /result\b/.test(ins),
      'a funcao restaurada grava em result',
    );
    assert.ok(
      !/result_enc/.test(ins),
      'a versao restaurada nao deve tocar em result_enc',
    );
  }
});

// ---------------------------------------------------------------------------
// HIGIENE DOS ARQUIVOS
// ---------------------------------------------------------------------------

test('nenhum arquivo novo tem BOM nem caractere de substituicao', () => {
  for (const [nome, txt] of [['p5', sql], ['rollback p5', rollback]]) {
    assert.ok(!txt.startsWith('\uFEFF'), nome + ' comecando com BOM');
    assert.ok(!txt.includes('\uFFFD'), nome + ' com caractere de substituicao (U+FFFD)');
  }
});

test('nenhum arquivo tem caractere CJK', () => {
  // Guard contra edicao botchada: CJK entrou duas vezes neste arquivo durante a
  // escrita e passou bate-bate pelo diff. Em SQL de um projeto pt-BR e sempre erro.
  for (const [nome, txt] of [['p5', sql], ['rollback p5', rollback]]) {
    const cjk = txt.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g);
    assert.ok(!cjk, nome + ' com caractere CJK: ' + (cjk || []).join(''));
  }
});