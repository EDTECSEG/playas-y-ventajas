'use strict';

// Guarda de migration para o contato publico da empresa (p9).
//
// Nao testa o banco: testa o ARQUIVO. Estas migracoes sao aplicadas a mao, e a
// forma como a p9 quebra e silenciosa -- exatamente o tipo de bug que o
// AGENTS.md manda fechar antes de deploy.
//
// Os tres erros que estas guardas existem para pegar:
//
//   1. PERDA DE DADO NA JANELA DE DEPLOY. As 4 funcoes de escrita ganham
//      `p_instagram text default null` no fim. O worker em producao, ate o
//      deploy, manda os argumentos VELHOS, ou seja, o Postgres preenche
//      p_instagram = NULL. Se NULL significar "limpar", basta alguem editar
//      "Meus dados" nessa janela para o Instagram de uma empresa desaparecer.
//      Daí a regra: NULL mantem, string vazia limpa.
//
//   2. ACL REABERTO. Regra 4 do AGENTS.md: toda funcao recreate por DROP +
//      CREATE perde as permissoes e nasce com EXECUTE para todo mundo ate o
//      proximo GRANT. Como estas escrevem em `businesses`, uma janela aberta
//      entrega a/edicao da base de empresas para `authenticated`.
//
//   3. SOBRECARGA DUPLA. `create or replace` nao aceita parametro novo. Sem o
//      DROP ficariam duas versoes de register_business, e toda chamada passaria
//      a responder "function ... is not unique" - a RPC deixa de resolver sem
//      erro visivel em quem chama.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const P9 = path.join(ROOT, 'supabase', 'p9-contato-publico-empresa.sql');
const RB = path.join(ROOT, 'supabase', 'p9-contato-publico-empresa.rollback.sql');
const EMPRESA = path.join(ROOT, 'netlify', 'functions', 'empresa.js');
const ADMIN = path.join(ROOT, 'netlify', 'functions', 'admin.js');

const src = fs.readFileSync(P9, 'utf8');
const rb = fs.readFileSync(RB, 'utf8');
const empresa = fs.readFileSync(EMPRESA, 'utf8');
const admin = fs.readFileSync(ADMIN, 'utf8');

// Sem os comentarios '--'. Este arquivo explica bastante sobre a regra do NULL,
// e uma busca por /instagram/i no texto inteiro accusationaria a prosa que
// descreve o que a migration NAO faz.
const sqlOnly = src.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
const rbOnly = rb.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');

// As 4 funcoes de escrita: assinatura antiga (a que o DROP precisa casar) e a
// nova. A coluna nova entra NO FIM, porque no Postgres parametro com DEFAULT nao
// pode ser seguido de parametro sem DEFAULT.
const ESCRITAS = [
  {
    nome: 'register_business',
    antiga: 'register_business(text, text, text, text, text, text, text, text, text, double precision, double precision, text, text)',
    nova: 'register_business(text, text, text, text, text, text, text, text, text, double precision, double precision, text, text, text)',
  },
  {
    nome: 'admin_create_business',
    antiga: 'admin_create_business(uuid, uuid, text, text, text, text, text, double precision, double precision, text, text, text, text, text, text)',
    nova: 'admin_create_business(uuid, uuid, text, text, text, text, text, double precision, double precision, text, text, text, text, text, text, text)',
  },
  {
    nome: 'admin_update_business',
    antiga: 'admin_update_business(uuid, uuid, uuid, text, text, text, text, text, text, text, text)',
    nova: 'admin_update_business(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text)',
  },
  {
    nome: 'business_update_own',
    antiga: 'business_update_own(uuid, uuid, text, text, text, text, text, text, double precision, double precision)',
    nova: 'business_update_own(uuid, uuid, text, text, text, text, text, text, double precision, double precision, text, text)',
  },
];

test('a p9 e o rollback existem e nao tem BEGIN/COMMIT solto', () => {
  assert.ok(fs.existsSync(P9), 'p9-contato-publico-empresa.sql nao existe');
  assert.ok(fs.existsSync(RB), 'p9-contato-publico-empresa.rollback.sql nao existe');
  for (const [nome, txt] of [['p9', src], ['rollback', rb]]) {
    assert.ok(!/^\s*begin\s*;/im.test(txt), `BEGIN solto na ${nome}`);
    assert.ok(!/^\s*commit\s*;/im.test(txt), `COMMIT solto na ${nome}`);
  }
});

test('a coluna instagram e nullable e sem default explicito', () => {
  assert.match(sqlOnly, /add column if not exists\s+instagram\s+text/i);
  // NOT NULL barraria a migration INTEIRA: a tabela tem linhas e nenhuma tem
  // Instagram. O erro so apareceria em producao, no momento de aplicar.
  assert.ok(!/add column if not exists\s+instagram\s+text\s+not\s+null/i.test(sqlOnly), 'instagram nao pode ser not null: quebra a migration em producao');
  // Default '' faria toda empresa nascer com Instagram vazio em vez de nulo,
  // e o `is null` do "campo preenchido" passaria a mentir.
  assert.ok(!/add column if not exists\s+instagram\s+text\s+default/i.test(sqlOnly), 'instagram nao pode ter default');
});

test('as 4 funcoes de escrita sao DROP + CREATE, nao CREATE OR REPLACE', () => {
  for (const f of ESCRITAS) {
    assert.match(
      sqlOnly,
      new RegExp(`drop function if exists\\s+public\\.${f.antiga.replace(/[()]/g, '\\$&')}`, 'i'),
      `${f.nome}: o DROP precisa casar com a assinatura que esta em producao`,
    );
    assert.match(
      sqlOnly,
      new RegExp(`create function public\\.${f.nome}\\s*\\(`, 'i'),
      `${f.nome}: falta o CREATE`,
    );
    assert.ok(
      !new RegExp(`create or replace function public\\.${f.nome}\\s*\\(`, 'i').test(sqlOnly),
      `${f.nome}: CREATE OR REPLACE deixaria a versao antiga de pe, e toda chamada cairia em "not unique"`,
    );
  }
});

test('todo DROP e seguido do ACL fechado em service_role', () => {
  // Regra 4 do AGENTS.md. A janela entre o DROP e o GRANT e real: e exatamente o
  // intervalo em que `authenticated` consegue chamar a funcao. Sem esta guarda o
  // arquivo pode ser reescrito com um REVOKE faltando, e o problema so apareceria
  // no teste de seguranca - depois da migration em producao.
  const drops = [...sqlOnly.matchAll(/drop function if exists public\.([a-z_]+)\(/gi)];
  assert.strictEqual(drops.length, ESCRITAS.length, `esperava ${ESCRITAS.length} DROP, achei ${drops.length}`);
  for (const d of drops) {
    const nome = d[1];
    const depois = sqlOnly.slice(d.index);
    assert.match(
      depois,
      new RegExp(`revoke execute on function public\\.${nome}\\([^)]*\\) from public, anon, authenticated`, 'i'),
      `${nome}: sem REVOKE logo apos o DROP (so service_role pode executar)`,
    );
    assert.match(
      depois,
      new RegExp(`grant\\s+execute on function public\\.${nome}\\([^)]*\\) to service_role`, 'i'),
      `${nome}: sem GRANT para service_role`,
    );
  }
});

test('o GRANT cita a assinatura NOVA, com o parametro a mais', () => {
  // Grant pela assinatura antiga e silenciosamente inoperante: o Postgres
  // warns "function does not exist" e segue. A chamada nova cai no default
  // (public) e a escrita para de funcionar para o service_role.
  for (const f of ESCRITAS) {
    const sig = f.nova.replace(/[()]/g, '\\$&');
    assert.match(sqlOnly, new RegExp(`revoke execute on function public\\.${sig} from public, anon, authenticated`, 'i'), `${f.nome}: REVOKE na assinatura nova`);
    assert.match(sqlOnly, new RegExp(`grant\\s+execute on function public\\.${sig} to service_role`, 'i'), `${f.nome}: GRANT na assinatura nova`);
  }
});

test('o parametro novo entra NO FIM e com DEFAULT NULL', () => {
  // No fim: DEFAULT no meio da assinatura quebra o CREATE. Com DEFAULT: e o que
  // mantem o worker antigo funcionando entre a migration e o deploy.
  for (const f of ESCRITAS) {
    const i = sqlOnly.search(new RegExp(`create function public\\.${f.nome}\\s*\\(`, 'i'));
    assert.ok(i !== -1, `${f.nome}: nao achei o CREATE`);
    const assinatura = sqlOnly.slice(i, sqlOnly.indexOf(')', i));
    const pInstagram = assinatura.search(/p_instagram/i);
    assert.ok(pInstagram !== -1, `${f.nome}: falta p_instagram`);
    assert.match(assinatura.slice(pInstagram), /p_instagram\s+text\s+default\s+null::text/i, `${f.nome}: p_instagram precisa de DEFAULT NULL`);
    const params = assinatura.match(/p_[a-z_]+\s+(text|uuid|double precision)/gi) || [];
    const ultimo = params[params.length - 1];
    assert.ok(/p_instagram/i.test(ultimo), `${f.nome}: p_instagram precisa ser o ULTIMO parametro (era ${ultimo})`);
  }
});

test('REGRA DO NULL: nos campos novos, NULL mantem e string vazia limpa', () => {
  // E o guard mais importante do arquivo. A forma quebrada seria
  // `coalesce(p_instagram, instagram)`: com o worker antigo mandando NULL, editar
  // "Meus dados" na janela entre migration e deploy apagaria o Instagram de uma
  // empresa. E a forma oposta tambem quebra: `nullif(btrim(p_instagram),'')` sem
  // o CASE grava '' em toda edicao de empresa que nem mexe no campo.
  const alvos = [
    ['business_update_own', /website\s*=\s*case when p_website is null then website else nullif\(btrim\(p_website\),\s*''\) end/i],
    ['business_update_own', /instagram\s*=\s*case when p_instagram is null then instagram else public\.normalize_instagram\(p_instagram\) end/i],
    ['admin_update_business', /instagram\s*=\s*case when p_instagram is null then instagram else public\.normalize_instagram\(p_instagram\) end/i],
  ];
  for (const [nome, re] of alvos) {
    const i = sqlOnly.search(new RegExp(`create function public\\.${nome}\\s*\\(`, 'i'));
    const corpo = sqlOnly.slice(i, sqlOnly.indexOf('end $function$', i));
    assert.match(corpo, re, `${nome}: a regra do NULL nao esta no UPDATE (${re})`);
    assert.ok(
      !new RegExp(`${nome}[\\s\\S]{0,4000}?instagram\\s*=\\s*coalesce\\(p_instagram`, 'i').test(sqlOnly),
      `${nome}: coalesce(p_instagram, ...) apaga o dado quando o worker antigo manda NULL`,
    );
  }
  // Nos INSERT das duas funcoes de cadastro nao ha "manter": a linha esta
  // nascendo. O que nao pode e normalizar NULL, que estouraria a funcao.
  assert.match(sqlOnly, /insert into businesses \(tenant_id, name[\s\S]{0,400}?instagram\)/i);
  assert.ok(
    /normalize_instagram\(p_instagram\)/i.test(sqlOnly),
    'os INSERT precisam passar por normalize_instagram',
  );
});

test('normalize_instagram deixa so o perfil, nos formatos que a empresa digita', () => {
  // Sem isto, a empresa digita "@playas" num campo e o QR mostra
  // "instagram.com/@playas", que nao existe. Os formatos tem de devolver todos
  // o mesmo "playas" -- e e isto que o teste MEDIR, em vez de procurar o texto
  // 'instagram\.com' no corpo. O assert antigo fazia so isso e passava com
  // '^https?://' exigindo o esquema, que e justamente o formato que a empresa
  // digita (instagram.com/playas) e que deixava de casar.
  const i = sqlOnly.indexOf('create or replace function public.normalize_instagram');
  // Do create ate o REVOKE: o corpo dessa funcao termina em `); $function$`, e nao
  // em `end $function$` como as plpgsql. Cortar pelo `$function$` pegaria o
  // cabecalho e deixaria o corpo de fora -- o teste passaria a medir nada.
  const corpo = sqlOnly.slice(i, sqlOnly.indexOf('revoke execute on function public.normalize_instagram', i));

  // Os padroes das regexp_replace, extraidos na ordem em que aparecem. As
  // strings vazias (coalesce e o '' da troca) e a flag 'i' ficam de fora.
  const aspas = [...corpo.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const padroes = aspas.filter((p) => /^\^|^\//.test(p) || /instagram/.test(p));
  assert.equal(padroes.length, 3, `esperava 3 padroes, achei: ${padroes.join(' | ')}`);
  assert.ok(!/^\^https/.test(padroes[0]),
    'o prefixo nao pode exigir o esquema: "instagram.com/perfil" precisa casar');
  // Estruturas que a porta abaixo assume e que a versao antiga nao tinha. O
  // btrim tem de estar no ARGUMENTO da primeira troca: '^@+' e ancorado, entao
  // com espaco a esquerda ele nao casa, o btrim de fora roda depois e o banco
  // guarda '@perfil' -- fora do contrato "sem @" que a coluna documenta. E o
  // lower(): o API.md descreve o resultado "em minusculas", e sem ele "@Playas"
  // e "@playas" gravavam duas linhas diferentes do mesmo perfil.
  assert.match(corpo, /regexp_replace\(\s*btrim\(\s*coalesce\(p_handle/i,
    'o btrim precisa envolver a ENTRADA, antes dos anchored');
  assert.match(corpo, /\blower\(/i, 'o resultado precisa ficar em minusculas (API.md)');

  // Porta fiel do corpo: trim de entrada, os 3 padroes na ordem, trim, lower.
  const normaliza = (bruto) => {
    let s = bruto == null ? '' : String(bruto).trim();
    for (const p of padroes) s = s.replace(new RegExp(p, 'i'), '');
    s = s.trim().toLowerCase();
    return s === '' ? null : s;
  };
  const casos = [
    ['@playas', 'playas'],
    ['instagram.com/playas', 'playas'],
    ['https://www.instagram.com/playas/', 'playas'],
    ['playas', 'playas'],
    ['https://instagram.com', null],
    ['PLAYAS', 'playas'],
    ['  @novo_perfil  ', 'novo_perfil'],
    ['', null],
    [null, null],
  ];
  for (const [entrada, esperado] of casos) {
    assert.equal(normaliza(entrada), esperado, `normalize(${JSON.stringify(entrada)}) devia dar ${JSON.stringify(esperado)}`);
  }

  // Campo vazio tem de virar NULL, e nao '' guardada no banco: `if (v)` na tela
  // trata os dois igual, mas o `is null` do SQL nao.
  assert.match(corpo, /nullif\([\s\S]*?''\s*\)/i, 'perfil vazio precisa virar NULL');
  // NULL tem de virar string vazia, e nao estourar: o INSERT passa p_instagram
  // NULL e chamava-se direto.
  assert.match(corpo, /coalesce\(p_handle,\s*''\)/i, 'normalize_instagram precisa tolerar NULL');
  assert.match(sqlOnly, /revoke execute on function public\.normalize_instagram\(text\) from public, anon, authenticated/i);
  assert.match(sqlOnly, /grant\s+execute on function public\.normalize_instagram\(text\) to service_role/i);
});

test('business_public_card e security definer, com search_path travado e ACL fechado', () => {
  const i = sqlOnly.indexOf('create or replace function public.business_public_card');
  const corpo = sqlOnly.slice(i, sqlOnly.indexOf('end $function$', i));
  assert.match(corpo, /security definer/i, 'sem SECURITY DEFINER a funcao roda com as permissoes do chamador');
  assert.match(corpo, /set search_path to public/i, 'search_path nao travado: um schema malicioso na frente de public sequestra a busca');
  for (const campo of ['phone', 'website', 'instagram', 'name', 'category', 'city']) {
    assert.match(corpo, new RegExp(`'${campo}'`), `business_public_card precisa devolver ${campo}`);
  }
  // A logo volta sob o nome que o app le ('logoUrl'), lida da coluna logo_url.
  assert.match(corpo, /'logoUrl',\s*v_row\.logo_url/i, 'a ficha precisa devolver a logo, na coluna logo_url');
  assert.match(sqlOnly, /revoke execute on function public\.business_public_card\(uuid\) from public, anon, authenticated/i);
  assert.match(sqlOnly, /grant\s+execute on function public\.business_public_card\(uuid\) to service_role/i);
  // Uma ficha "qualquer empresa por id" nao pode ser aberta por anon: e o mesmo
  // caminho que lista_contatos_filiais usaria, so que aqui sem assinatura.
  assert.ok(!/p_actor_user_id/i.test(corpo), 'a ficha nao valida ator: quem chamar com service_role traz qualquer id');
});

test('as leituras que nao mudam de assinatura usam CREATE OR REPLACE', () => {
  // Se qualquer uma delas virar DROP + CREATE, o ACL de producao se perde sem
  // ninguem reescrever o REVOKE/GRANT. Pior no caso de list_offers: e a tela de
  // maior trafego do app.
  for (const nome of ['list_offers', 'list_customer_coupons', 'admin_list_businesses', 'business_get_own']) {
    assert.match(
      sqlOnly,
      new RegExp(`create or replace function public\\.${nome}\\s*\\(`, 'i'),
      `${nome}: deveria ser CREATE OR REPLACE`,
    );
    assert.ok(
      !new RegExp(`drop function if exists public\\.${nome}\\s*\\(`, 'i').test(sqlOnly),
      `${nome}: nao deve haver DROP (o ACL se perderia)`,
    );
    assert.ok(
      !new RegExp(`revoke execute on function public\\.${nome}\\(`, 'i').test(sqlOnly),
      `${nome}: nao precisa de REVOKE/GRANT novo (o ACL foi preservado)`,
    );
  }
});

test('business_logo_by_id NAO foi tocada', () => {
  // Ela esta em uso pelo cliente ja publicado. Mexer nela trocaria o formato da
  // resposta de um endpoint vivo, sem ninguem pedir. A busca e no SQL sem os
  // comentarios, porque a p9 EXPLICA essa decisao e o nome aparece na prosa.
  assert.ok(!/business_logo_by_id/i.test(sqlOnly), 'a p9 nao deveria mexer em business_logo_by_id');
  const offers = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'offers.js'), 'utf8');
  assert.match(offers, /business_logo_by_id/, 'offers.js precisa continuar atendendo ao cliente antigo');
  assert.match(offers, /businessLogoFor/, 'o parametro antigo precisa continuar existindo');
});

test('os workers enviam o campo novo, e string vazia significa limpar', () => {
  // `body.instagram || null` no cadastro (nao ha dado a preservar) e
  // `undefined ? null : (body.instagram || '')` na edicao. A distincao e o que
  // segura a regra do NULL do lado do SQL.
  assert.match(empresa, /p_instagram: body\.instagram \|\| null/, 'register_business');
  assert.match(empresa, /p_instagram: body\.instagram === undefined \? null : \(body\.instagram \|\| ''\)/, 'business_update_own: vazio limpa, ausente nao mexe');
  assert.match(admin, /p_instagram: body\.instagram === undefined \? null : \(body\.instagram \|\| ''\)/, 'admin_update_business: vazio limpa, ausente nao mexe');
  // website chega em business_update_own, que antes nao tinha o parametro.
  assert.match(empresa, /p_website: body\.website === undefined \? null : \(body\.website \|\| ''\)/, 'business_update_own precisa poder editar o site');
});

test('o rollback desfaz as assinaturas novas e nao apaga dado preenchido', () => {
  // A coluna fica de proposito: e o mesmo padrao da p6 (rollback que nao apaga
  // dado real). As assin voltam para as de 13/15/11/10 parametros, casando com
  // o que o worker antigo manda.
  assert.ok(!/drop column/i.test(rbOnly), 'o rollback nao pode derrubar a coluna: apagaria Instagram ja preenchido');
  // Depois do DROP so pode ser CREATE: um CREATE OR REPLACE aqui casaria com a
  // assinatura de 14 parametros e nao recriaria a de 13.
  for (const nome of ['register_business', 'admin_create_business', 'admin_update_business', 'business_update_own']) {
    assert.match(rbOnly, new RegExp(`drop function if exists public\\.${nome}\\(`, 'i'), `rollback: falta o DROP de ${nome}`);
    assert.match(rbOnly, new RegExp(`create function public\\.${nome}\\s*\\(`, 'i'), `rollback: ${nome} precisa de CREATE (nao OR REPLACE)`);
    assert.ok(
      !new RegExp(`create or replace function public\\.${nome}\\s*\\(`, 'i').test(rbOnly),
      `rollback: CREATE OR REPLACE em ${nome} nao volta a assinatura antiga`,
    );
  }
  // Toda funcao RECRIADA pelo rollback precisa fechar o ACL de novo. O loop e
  // sobre as 4 de escrita, e nao sobre todo DROP do arquivo: business_public_card
  // e normalize_instagram sao dropadas sem recriacao (checado logo abaixo), e um
  // DROP puro nao tem ACL nenhum para fechar.
  for (const nome of ['register_business', 'admin_create_business', 'admin_update_business', 'business_update_own']) {
    const d = rbOnly.search(new RegExp(`drop function if exists public\\.${nome}\\(`, 'i'));
    assert.ok(d !== -1, `rollback: ${nome} nao foi dropada`);
    const depois = rbOnly.slice(d);
    assert.match(depois, new RegExp(`revoke execute on function public\\.${nome}\\([^)]*\\) from public, anon, authenticated`, 'i'), `${nome}: rollback sem REVOKE`);
    assert.match(depois, new RegExp(`grant\\s+execute on function public\\.${nome}\\([^)]*\\) to service_role`, 'i'), `${nome}: rollback sem GRANT`);
  }
  // E as leituras voltam a nao devolver os campos de contato.
  assert.ok(!/businessInstagram/i.test(rbOnly), 'o rollback precisa remover businessInstagram das leituras');

  // As duas funcoes que a p9 CRIOU somem no rollback. Nao ha REVOKE a fechar
  // aqui: funcao dropada deixa de existir, e nao existe ACL para ela. O que nao
  // pode e elas reaparecerem recriadas - o app novo em producao chamaria
  // business_public_card e levaria 404 ate o deploy do app antigo.
  for (const nome of ['business_public_card', 'normalize_instagram']) {
    assert.match(rbOnly, new RegExp(`drop function if exists public\\.${nome}\\(`, 'i'), `rollback: falta o DROP de ${nome}`);
    assert.ok(
      !new RegExp(`create (or replace )?function public\\.${nome}\\s*\\(`, 'i').test(rbOnly),
      `rollback: ${nome} nao deveria ser recriada`,
    );
  }
});