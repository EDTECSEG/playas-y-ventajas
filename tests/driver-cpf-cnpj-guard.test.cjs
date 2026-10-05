'use strict';

// Guarda de migration para o CPF/CNPJ do motorista.
//
// Nao testa o banco: testa o ARQUIVO. Estas migracoes sao aplicadas a mao, e o
// modo como elas quebram e silencioso -- a p6 ja entrou com 'comment on column
// public.drivers legal_name' (espaco no lugar do ponto), que o Postgres so
// rejeita na hora de aplicar. Um teste que le o arquivo pega antes.
//
// Os casos de DV nao moram aqui: os de JS ficam em motorista-logic.test.cjs e os
// de SQL foram conferidos contra o Postgres. Aqui o que importa e o INVARIANTE:
// o que o codigo depende e o que o arquivo precisa continuar garantindo.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const P6 = path.join(__dirname, '..', 'supabase', 'p6-cpf-cnpj-motorista.sql');
const P7 = path.join(__dirname, '..', 'supabase', 'p7-cpf-obrigatorio-motorista.sql');
const RB = path.join(__dirname, '..', 'supabase', 'p6-cpf-cnpj-motorista.rollback.sql');
const RB7 = path.join(__dirname, '..', 'supabase', 'p7-cpf-obrigatorio-motorista.rollback.sql');
const MOD4B = path.join(__dirname, '..', 'supabase', 'modulo4b-token-cadastro.sql');
const src = fs.readFileSync(P6, 'utf8');
const p7 = fs.readFileSync(P7, 'utf8');
const rb = fs.readFileSync(RB, 'utf8');
const rb7 = fs.readFileSync(RB7, 'utf8');
const mod4b = fs.readFileSync(MOD4B, 'utf8');

// Normaliza espacos para a busca nao depender de quebra de linha nem de
// alinhamento. O SQL real nao liga, mas a busca por texto sim.
const flat = src.replace(/\s+/g, ' ');

// O mesmo, mas sem os comentarios '--'. Necessario porque este arquivo explica
// o bastante para que a palavra CPF apareca na prosa -- e uma busca por /cpf/i
// sobre o texto inteiro acusaria o comentario que diz que o CPF nao vaza, que e
// exatamente o oposto do que a regra quer.
// O p6 nao usa '--' dentro de literal, entao o corte e seguro aqui.
const sqlOnly = src.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

test('a p6 existe e nao tem BEGIN/COMMIT', () => {
  assert.ok(fs.existsSync(P6), 'p6-cpf-cnpj-motorista.sql nao existe');
  // Migration versionada roda em transacao explicita do executor. Um BEGIN
  // solto aqui criaria warning do psql e, num rollback manual, transacao aninhada.
  assert.ok(!/^\s*begin\s*;/im.test(src), 'BEGIN solto na migration');
  assert.ok(!/^\s*commit\s*;/im.test(src), 'COMMIT solto na migration');
});

test('as tres colunas existem e sao nullable (nao ha motorista com CPF ainda)', () => {
  for (const col of ['cpf', 'cnpj', 'legal_name']) {
    assert.match(
      src,
      new RegExp(`add column if not exists\\s+${col}\\s+text`, 'i'),
      `coluna ${col} ausente ou com tipo unexpectedo`,
    );
  }
  // Se algum virar NOT NULL, a migration quebra: a tabela tem linhas e nenhuma
  // tem CPF. E o erro aparece so em producao.
  assert.ok(
    !/add column if not exists\s+\w+\s+text\s+not null/i.test(src),
    'coluna NOT NULL barra a migration: a tabela nao esta vazia',
  );
});

test('comment on column usa ponto, e nao espaco', () => {
  // Este foi o bug real: 'public.drivers legal_name'. O Postgres rejeita, mas
  // so na hora de aplicar.
  const comments = src.match(/comment on column[^;]+;/gi) || [];
  assert.ok(comments.length >= 3, `esperava 3 comment on column, achei ${comments.length}`);
  for (const c of comments) {
    assert.match(c, /on column\s+public\.drivers\.\w+/i, `comment on column sem ponto: ${c}`);
  }
});

test('os validadores de DV sao IMMUTABLE e com search_path fixo', () => {
  for (const fn of ['is_valid_cpf', 'is_valid_cnpj', 'digits_only']) {
    assert.match(src, new RegExp(`create or replace function public\\.${fn}\\s*\\(`, 'i'), `${fn} ausente`);
  }
  // IMMUTABLE porque sao funcoes puras: o planner usa isso para pre-calcular.
  // search_path fixo porque um objeto malicioso no schema do usuario nao pode
  // ser encontrado no meio do calculo do DV.
  for (const fn of ['is_valid_cpf', 'is_valid_cnpj']) {
    const bloco = src.slice(src.indexOf(`function public.${fn}`));
    const fim = bloco.indexOf('$$;');
    const corpo = bloco.slice(0, fim);
    assert.match(corpo, /immutable/i, `${fn} sem IMMUTABLE`);
    assert.match(corpo, /set search_path = pg_temp/i, `${fn} sem search_path = pg_temp`);
  }
});

test('os validadores nao ficam abertos para anon/authenticated', () => {
  // public.digits_only e os dois is_valid_* sao criadas em public, que o
  // PostgREST expoe. Sem o revoke, qualquer anon com a anon key chamaria
  // public.is_valid_cpf(qualquer_coisa) -- uma funcao pura, sem vazamento, mas
  // que cria superficie de API nao auditada. A postura do projeto e revogar.
  for (const sig of ['digits_only(text)', 'is_valid_cpf(text)', 'is_valid_cnpj(text)']) {
    const nome = sig.split('(')[0];
    assert.match(
      src,
      new RegExp(`revoke execute on function public\\.${nome}\\(text\\) from public, anon, authenticated;`, 'i'),
      `revoke ausente ou incompleto em ${sig}`,
    );
  }
});

test('sequencia de digitos repetidos e rejeitada no validators de DV', () => {
  // E o caso que o calculo de DV sozinho nao pega: '11111111111' satisfaz a
  // conta, entao passaria como CPF valido sem esta guarda.
  assert.match(flat, /\(\.\)\\1\{10\}\$/, 'CPF sem guarda de repeticao');
  assert.match(flat, /\(\.\)\\1\{13\}\$/, 'CNPJ sem guarda de repeticao');
});

test('os dois indices unicos sao por tenant e parciais', () => {
  // Por tenant, e nao por cpf global: dois tenants podem ter o mesmo motorista.
  // Parciais (is not null) porque a coluna nasce vazia para os ja cadastrados.
  assert.match(src, /create unique index if not exists drivers_tenant_cpf_uniq\s+on public\.drivers \(tenant_id, cpf\)\s+where cpf is not null/i);
  assert.match(src, /create unique index if not exists drivers_tenant_cnpj_uniq\s+on public\.drivers \(tenant_id, cnpj\)\s+where cnpj is not null/i);
  // Um unique sem 'tenant_id' seria um bug de multilocacao: a empresa B nao
  // poderia cadastrar o motorista que a empresa A ja cadastrou.
  assert.ok(!/create unique index[^;]*drivers \(cpf\)/i.test(src), 'indice de CPF sem tenant_id');
});

test('driver_register mantem os 6 parametros antigos e adiciona 3 com DEFAULT', () => {
  // Sem o DEFAULT, a chamada de 6 argumentos do worker em producao passaria a
  // dar "function does not exist" e o cadastro pararia ate o deploy.
  const bloco = src.slice(src.indexOf('create or replace function public.driver_register'));
  assert.match(
    bloco,
    /p_business_id uuid DEFAULT NULL/i,
    'p_business_id perdeu o DEFAULT: quebra o worker de 6 argumentos em producao',
  );
  assert.match(bloco, /p_invite_code text DEFAULT NULL/i, 'p_invite_code perdeu o DEFAULT');
  assert.match(bloco, /p_cpf text DEFAULT NULL/i, 'p_cpf sem DEFAULT');
  assert.match(bloco, /p_cnpj text DEFAULT NULL/i, 'p_cnpj sem DEFAULT');
  assert.match(bloco, /p_legal_name text DEFAULT NULL/i, 'p_legal_name sem DEFAULT');
});

test('a p6 exige cpf OU aceita ausencia? (a exigencia mora na p7)', () => {
  // Este e o ponto que evita a janela de cadastro fora do ar. Se a p6 passar a
  // exigir CPF, todo cadastro novo quebra ate o worker novo chegar.
  const bloco = src.slice(src.indexOf('create or replace function public.driver_register'));
  assert.ok(
    !/raise exception 'CPF_REQUIRED'/.test(bloco),
    'a p6 esta exigindo CPF: a exigencia tem que ficar na p7, senao quebra o cadastro em producao',
  );
  // Mas o formato, quando vem, e conferido.
  assert.match(bloco, /is_valid_cpf/, 'CPF informado nao passa por is_valid_cpf');
  assert.match(bloco, /is_valid_cnpj/, 'CNPJ informado nao passa por is_valid_cnpj');
});

test('os erros de dominio tem codigo, e nao texto de regra em portugues', () => {
  // O rpcErrorCode corta a mensagem no primeiro ':' e devolve isso ao
  // motorista. Um erro sem codigo (#{}) chegaria cru.
  for (const code of [
    'CPF_INVALID',
    'CNPJ_INVALID',
    'LEGAL_NAME_REQUIRED',
    'LEGAL_NAME_TOO_LONG',
    'CPF_ALREADY_REGISTERED',
    'CNPJ_ALREADY_REGISTERED',
  ]) {
    assert.match(src, new RegExp(`raise exception '${code}'`), `codigo ${code} ausente`);
  }
});

test('CNPJ com razao social e um par: um sem o outro e barrado', () => {
  // Lido do arquivo achatado: o SQL real quebra a linha entre o if e o raise,
  // e um teste que depende dessa quebra falha quando alguem so formata.
  assert.match(
    flat,
    /if v_cnpj is not null and v_legal_name is null then raise exception 'LEGAL_NAME_REQUIRED'/i,
    'CNPJ sem razao social nao e barrado: guarda metade do registro fiscal',
  );
});

test('a empresa ve cpf, cnpj e razao na revisao', () => {
  const bloco = src.slice(src.indexOf('create or replace function public.driver_list_for_business'));
  assert.match(bloco, /'cpf', d\.cpf/i, 'cpf ausente de driver_list_for_business');
  assert.match(bloco, /'cnpj', d\.cnpj/i, 'cnpj ausente de driver_list_for_business');
  assert.match(bloco, /'legalName', d\.legal_name/i, 'razao social ausente de driver_list_for_business');
  // O CPF so pode ser lido de uma funcao: a revisao da empresa. Um segundo
  // SELECT em qualquer outro leitor (mapa do cliente, agenda de corridas)
  // colocaria dado pessoal na mao de quem nao e a empresa -- e nao apareceria em
  // revisao de diff, porque a funcao nao mudou.
  const seletoresCpf = (sqlOnly.match(/'cpf', d\.cpf/gi) || []).length;
  assert.strictEqual(seletoresCpf, 1, `cpf aparece em ${seletoresCpf} consultas, esperado 1`);
  // Lido do SQL sem comentarios: no arquivo cheio, este teste acusaria a frase
  // "nem list_live_vehicles selecionam estes campos".
  assert.ok(
    !/list_live_vehicles[^;]*\bcpf\b/i.test(sqlOnly),
    'list_live_vehicles nao pode selecionar cpf: ele alimenta o mapa do cliente',
  );
});

test('o insert grava os tres campos', () => {
  assert.match(
    flat,
    /insert into public\.drivers \(tenant_id, name, phone, email, business_id, status, cpf, cnpj, legal_name\)/i,
    'insert nao grava cpf/cnpj/legal_name: os campos seriam aceitos e descartados',
  );
});

test('a normalizacao para digitos vem antes das regras de duplicidade', () => {
  // Se comparasse mascarado, '529.982.247-25' e '52998224725' passariam os dois
  // exists() e o indice unico nao veria a colisao.
  const bloco = src.slice(src.indexOf('create or replace function public.driver_register'));
  // O alinhamento dos ':=' muda com o formatter, entao a posicao e lida por
  // expressao regular e nao por string exata com espacos.
  const mNorm = /v_cpf\s*:=\s*nullif\(public\.digits_only\(p_cpf\), ''\)/.exec(bloco);
  const posDup = bloco.indexOf('CPF_ALREADY_REGISTERED');
  assert.ok(mNorm, 'normalizacao do CPF ausente');
  assert.ok(posDup > -1, 'regra de duplicidade do CPF ausente');
  assert.ok(mNorm.index < posDup, 'a comparacao de duplicidade vem antes da normalizacao');
});

// --- p7: a fase que exige CPF -----------------------------------------------

test('a p7 e a unica que exige CPF, e exige antes de validar', () => {
  assert.match(p7, /raise exception 'CPF_REQUIRED'/, 'a p7 nao exige CPF: a exigencia nao foi implantada');
  // A ordem REQUIRED -> INVALID e o que evita "CPF invalido" num campo que o
  // usuario simplesmente nao preencheu. public.is_valid_cpf(NULL) daria false,
  // que e o mesmo resultado do DV errado.
  const iRequired = p7.indexOf("raise exception 'CPF_REQUIRED'");
  const iInvalid = p7.indexOf("raise exception 'CPF_INVALID'");
  assert.ok(iRequired > -1 && iInvalid > -1);
  assert.ok(iRequired < iInvalid, 'CPF_INVALID antes de CPF_REQUIRED: erro errado para campo vazio');
});

test('a p7 continua deixando o CNPJ opcional', () => {
  // Exigir CNPJ deixaria de fora a maioria dos motoristas de translado, que sao
  // autonomos. O dono pediu CPF obrigatorio e CNPJ opcional.
  assert.ok(
    !/raise exception 'CNPJ_REQUIRED'/.test(p7),
    'a p7 exige CNPJ: nao era o combinado',
  );
});

test('p6 e p7 derrubam a assinatura de 6 parametros antes de criar a de 9', () => {
  // Sem este drop, aplicou a p7 sem a p6 (ou reaplicou a p6 depois) e sobram
  // duas sobrecargas: a de 6 e a de 9. Toda chamada com 6 argumentos ou menos
  // passa a responder 'function ... is not unique', e a RPC simplesmente para
  // de resolver sem erro nenhum no codigo que chama.
  for (const [nome, arquivo] of [['p6', src], ['p7', p7]]) {
    assert.match(
      arquivo,
      /drop function if exists public\.driver_register\(uuid, text, text, text, uuid, text\);/i,
      `${nome} nao derruba a assinatura de 6 parametros: risco de sobrecarga ambigua`,
    );
  }
});

test('reaplicar o modulo4b DEPOIS da p7 nao recria a sobrecarga ambigua', () => {
  // O modulo4b e o arquivo que ORIGINA a assinatura de 6. Nele o
  // "create or replace" e inofensivo enquanto a p6 nao rodou, porque a de 6 ja
  // existe e e so reescrita. Depois da p7, nao: a de 6 foi derrubada e o
  // create volta a cria-la AO LADO da de 9 -- que tem DEFAULT NULL nos 3
  // ultimos parametros, entao uma chamada de 6 argumentos casa com as DUAS e o
  // Postgres responde "is not unique" sem erro no codigo que chama.
  // Como reaplicar o modulo4b por habito e o movimento mais natural do mundo
  // depois de mexer em qualquer coisa do cadastro, a protecao tem que estar nele.
  assert.match(
    mod4b,
    /drop function if exists public\.driver_register\(uuid, text, text, text, uuid, text, text, text, text\);/i,
    'o modulo4b nao derruba a assinatura de 9: reapplicar ele apos a p7 volta a deixar duas sobrecargas de pe',
  );
});

// --- rollback ---------------------------------------------------------------

test('o rollback da p6 existe e volta a assinatura de 6 parametros', () => {
  assert.ok(fs.existsSync(RB), 'rollback da p6 nao existe');
  assert.match(
    rb,
    /create or replace function public\.driver_register\(\s*p_tenant_id uuid,\s*p_name text,\s*p_phone text,\s*p_email text,\s*p_business_id uuid DEFAULT NULL,\s*p_invite_code text DEFAULT NULL\s*\)/i,
    'o rollback nao restaura a assinatura de 6 parametros',
  );
  assert.match(
    rb,
    /drop function if exists public\.driver_register\(uuid, text, text, text, uuid, text, text, text, text\);/i,
    'o rollback nao derruba a assinatura de 9: ela voltaria em cima da de 6',
  );
});

test('o rollback NAO apaga as colunas (CPF preenchido seria perdido)', () => {
  // 'drop column cpf' destruiria dado real de motorista, e o backup e o unico
  // caminho de volta. O rollback tem de desfazer a RPC e deixar o schema.
  const sql = rb.replace(/--[^\n]*/g, ' ');
  assert.ok(
    !/drop\s+column/i.test(sql),
    'o rollback apaga coluna: perderia os CPFs ja preenchidos',
  );
});

test('o rollback avisa que, com a p7 aplicada, a volta e p7 -> p6', () => {
  // A ordem importa e nao e obvia: rodar so o rollback da p6 com a p7 no ar
  // deixaria a p7 recriando a assinatura de 9 parametros logo depois.
  assert.match(rb.replace(/\s+/g, ' '), /ordem de volta e p7 -> p6/i);
});

// --- rollback da p7 ---------------------------------------------------------

test('p6, p7 e o rollback da p7 FECHAM o ACL de driver_register neles mesmos', () => {
  // O invariant real do projeto e app_ainda_abertas = 0 (verificado em
  // producao: 823 funcoes em public, 0 abertas). Como p6 e p7 DROPparam a
  // assinatura e recriam a funcao, ela nasce com o default do schema, que e
  // EXECUTE para PUBLIC -- e anon/authenticated sao membros de PUBLIC. O
  // close-function-exec.sql fecha no fim do modulo, mas entre a migration e o
  // close a funcao fica chamavel direto pelo navegador. Duas linhas por arquivo
  // fecham a janela; este teste existe para ninguem remove-las depois.
  for (const [nome, arquivo] of [['p6', src], ['p7', p7], ['rollback da p7', rb7]]) {
    assert.match(
      arquivo,
      /revoke execute on function public\.driver_register\(uuid, text, text, text, uuid, text, text, text, text\) from public, anon, authenticated;/i,
      `${nome} nao revoga o EXECUTE de driver_register: fica aberta a anon/authenticated`,
    );
    assert.match(
      arquivo,
      /grant\s+execute on function public\.driver_register\(uuid, text, text, text, uuid, text, text, text, text\)\s+to service_role;/i,
      `${nome} nao devolve EXECUTE de driver_register para service_role: o worker quebra`,
    );
  }
});

test('a p6 tambem fecha driver_list_for_business, que devolve PII', () => {
  // Pior que a driver_register: esta devolve nome, telefone, e-mail, CPF e CNPJ
  // de todos os motoristas do tenant. DROP + CREATE no fim da p6 a reabre para
  // PUBLIC (que inclui anon) ate o close-function-exec.sql rodar -- leitura
  // direta da tabela via PostgREST, nao um detalhe teorico.
  assert.match(
    src,
    /revoke execute on function public\.driver_list_for_business\(uuid, uuid, text\) from public, anon, authenticated;/i,
    'a p6 nao revoga driver_list_for_business: PII de motorista aberta para anon',
  );
  assert.match(
    src,
    /grant\s+execute on function public\.driver_list_for_business\(uuid, uuid, text\)\s+to service_role;/i,
    'a p6 nao devolve EXECUTE de driver_list_for_business para service_role: a aba Motoristas quebra',
  );
});

test('nenhuma migration deste lote abre funcao para anon ao recria-la', () => {
  // Varredura estrutural sobre TODAS as migrations e rollbacks deste lote. A
  // regra e do AGENTS.md (Regra 4): DROP + CREATE zera o ACL e reabre a funcao
  // para PUBLIC, que inclui anon e authenticated. Rodar close-function-exec.sql
  // depois fecha, mas deixa uma janela aberta entre a aplicacao e o close -- e o
  // rollback de uma migration e justamente o caminho usado quando algo deu
  // errado, ou seja, o pior momento para abrir uma funcao.
  const lote = [
    'p6-cpf-cnpj-motorista.sql',
    'p6-cpf-cnpj-motorista.rollback.sql',
    'p7-cpf-obrigatorio-motorista.sql',
    'p7-cpf-obrigatorio-motorista.rollback.sql',
    'p8-cota-free-cupons.sql',
    'p8-cota-free-cupons.rollback.sql',
  ];
  const dir = path.join(__dirname, '..', 'supabase');
  let verificadas = 0;

  for (const arquivo of lote) {
    const sql = fs.readFileSync(path.join(dir, arquivo), 'utf8');
    const criadas = [...sql.matchAll(/create\s+(or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi)].map((m) => m[2]);

    for (const nome of criadas) {
      const q = (re) => new RegExp(re.replace('FN', nome), 'i').test(sql);
      // Sem o DROP na mesma migration, o CREATE OR REPLACE preserva o ACL: nao
      // ha o que fechar. Com o DROP, a funcao nasce nova e precisa ser fechada.
      const recriada = q(`drop\\s+function\\s+if\\s+exists\\s+public\\.FN\\s*\\(`);
      if (!recriada) continue;
      verificadas++;

      assert.match(
        sql,
        new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.${nome}\\s*\\(`, 'i'),
        `${arquivo}: recria ${nome} com DROP+CREATE e nao revoga PUBLIC/anon/authenticated`,
      );
      assert.match(
        sql,
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${nome}\\s*\\(`, 'i'),
        `${arquivo}: recria ${nome} com DROP+CREATE e nao devolve EXECUTE para service_role`,
      );
    }
  }

  // Trava contra a varredura deixar de rodar por accident (regex vazia, lista
  // esvaziada): sem funcao verificada, o teste passa nao fazendo nada.
  assert.ok(verificadas >= 6, `a varredura so verificou ${verificadas} funcoes: ela pode estar cega`);
});

test('o rollback da p6 tambem devolve o EXECUTE para service_role', () => {
  // O rollback da p6 DROPa a de 9 e cria a de 6, entao nasce nova e aberta.
  assert.match(
    rb,
    /grant\s+execute on function public\.driver_register\(uuid, text, text, text, uuid, text\)\s+to service_role;/i,
    'o rollback da p6 nao devolve EXECUTE para service_role: o cadastro para de funcionar',
  );
});

test('o rollback da p7 existe e nao tem BEGIN/COMMIT', () => {
  assert.ok(fs.existsSync(RB7), 'rollback da p7 nao existe');
  assert.ok(!/^\s*begin\s*;/im.test(rb7), 'BEGIN solto no rollback da p7');
  assert.ok(!/^\s*commit\s*;/im.test(rb7), 'COMMIT solto no rollback da p7');
});

test('o rollback da p7 troca o CORPO, sem derrubar a funcao', () => {
  // DROP + CREATE perderia o revoke/grant que ja vale em producao, e a RPC
  // ficaria executavel por quem nao devia ate a proxima linha rodar. Como a p6
  // e a p7 tem a MESMA assinatura, o CREATE OR REPLACE basta e preserva ACL.
  assert.match(
    rb7,
    /create or replace function public\.driver_register\(\s*p_tenant_id uuid,\s*p_name text,\s*p_phone text,\s*p_email text,\s*p_business_id uuid DEFAULT NULL,\s*p_invite_code text DEFAULT NULL,\s*p_cpf text DEFAULT NULL,\s*p_cnpj text DEFAULT NULL,\s*p_legal_name text DEFAULT NULL\s*\)/i,
    'o rollback da p7 nao restaura a assinatura de 9 parametros igual a da p6',
  );
  assert.ok(
    !/drop function if exists public\.driver_register/i.test(rb7),
    'o rollback da p7 derruba a funcao e perde as ACLs',
  );
});

test('o rollback da p7 volta a PERMITIR CPF ausente', () => {
  // Sem comentarios: o cabecalho do arquivo cita CPF_REQUIRED ao descrever o
  // que esta sendo desfeito, e uma busca no texto inteiro acusaria a prosa.
  const sql = rb7.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
  assert.ok(!/raise exception 'CPF_REQUIRED'/i.test(sql), 'o rollback ainda exige CPF: nao desfaz a p7');
  assert.ok(!/if v_cpf is null then/i.test(sql), 'o rollback ainda tem a guarda de CPF ausente');
  assert.match(
    sql,
    /if v_cpf is not null and not public\.is_valid_cpf\(v_cpf\) then raise exception 'CPF_INVALID'/i,
    'o rollback nao volta a validar o CPF quando ele vem preenchido',
  );
});

test('o rollback da p7 nao Introduz exigencia que o dono nunca pediu', () => {
  // CNPJ e razao social continuam OPCIONAIS em toda a cadeia. Um rollback que
  // passasse a exigir CNPJ derrubaria a maioria dos motoristas de translado --
  // e o efeito seria descoberto por quem triescadastrar, nao por teste.
  const sql = rb7.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
  for (const proibido of ['CNPJ_REQUIRED', 'CPF_ALREADY_REGISTERED_ALWAYS']) {
    assert.ok(!new RegExp(`raise exception '${proibido}'`, 'i').test(sql), `o rollback introduz ${proibido}`);
  }
  assert.match(sql, /if v_cnpj is not null and not public\.is_valid_cnpj\(v_cnpj\) then/i, 'o rollback passou a exigir CNPJ');
  assert.match(sql, /if v_cnpj is not null and v_legal_name is null then/i, 'o rollback perdeu o par CNPJ + razao social');
});

test('o rollback da p7 NAO recria a sobrecarga de 6 parametros', () => {
  // Recriar a de 6 aqui deixaria as duas de pe -- que e exatamente a
  // ambiguidade que a p7 existe para eliminar. A p7 dropou a de 6; desfaz-la e
  // voltar ao estado da p6, e nao ao estado do modulo4.
  assert.ok(
    !/create( or replace)? function public\.driver_register\(\s*p_tenant_id uuid,\s*p_name text,\s*p_phone text,\s*p_email text,\s*p_business_id uuid DEFAULT NULL,\s*p_invite_code text DEFAULT NULL\s*\)/i.test(rb7),
    'o rollback da p7 recria a assinatura de 6 e reintroduz a sobrecarga ambigua',
  );
});

test('o rollback da p7 nao apaga coluna nem dado de motorista', () => {
  const sql = rb7.replace(/--[^\n]*/g, ' ');
  assert.ok(!/drop\s+column/i.test(sql), 'o rollback apaga coluna');
  assert.ok(!/delete\s+from/i.test(sql), 'o rollback apaga linha de motorista');
});