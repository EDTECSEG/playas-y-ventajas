// Autorizacao e contrato de driver-reset-pin.
//
// Esta rota troca o PIN de um motorista — a credencial que separa "entrou no
// cadastro" de "entrou na conta". E o unico caminho de recuperacao que existe
// (driver-set-pin so funciona com o pinToken do cadastro, que morre no primeiro
// uso), o que faz deste o endpoint onde um erro de IDOR e uma escalada direta.
//
// O que os testes travam:
//  - sem sessao valida, nada toca o banco (401 antes da RPC);
//  - p_actor_user_id e p_tenant_id vem da sessao, nunca do corpo — um corpo
//    forjado com userId de outro usuario nao muda o ator da RPC;
//  - PIN fora de 4 a 8 digitos morre em 400, sem escrita;
//  - FORBIDDEN da RPC (motorista de outra empresa) vira 403, nao 400;
//  - a resposta nunca carrega o PIN.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const raiz = path.join(__dirname, '..');

const adminPath = require.resolve(path.join(raiz, 'netlify', 'functions', '_supabaseAdmin.js'));

let respostaRpc = { data: null, error: null };
let argsRpc = null;
let tokenPresente = true;
let sessaoLanca = null;

require.cache[adminPath] = {
  id: adminPath,
  filename: adminPath,
  loaded: true,
  exports: {
    getSupabaseAdminClient: () => ({
      rpc: async (nome, args) => {
        argsRpc = { nome, args };
        return respostaRpc;
      },
    }),
    resolveSession: async () => {
      if (sessaoLanca) throw new Error(sessaoLanca);
      // Identidade do ator derivada da sessao: e este par que o corpo nao pode
      // sobrescrever.
      return {
        tenantId: 'tenant-da-sessao',
        userId: 'ator-da-sessao',
        role: 'MERCHANT',
        businessId: 'negocio-do-ator',
      };
    },
    extractSessionToken: () => (tokenPresente ? 'tok-de-sessao' : null),
    rpcErrorCode: (e) => String((e && e.message) || '').split(':')[0].trim(),
    safeRpcError: (e, fallback) => (/^[A-Z0-9]{3,10}$/.test(String(e && e.code)) ? e.code : fallback),
    rpcErrorStatus: (e) => {
      const c = String((e && e.message) || '');
      if (c.includes('FORBIDDEN')) return 403;
      if (c.includes('NOT_FOUND')) return 404;
      return 400;
    },
  },
};

const { handler } = require(path.join(raiz, 'netlify', 'functions', 'driver-reset-pin.js'));

const ev = (body) => ({ httpMethod: 'POST', body: JSON.stringify(body) });
const valido = { driverId: '11111111-1111-1111-1111-111111111111', newPin: '4821' };

function reset() {
  respostaRpc = { data: null, error: null };
  argsRpc = null;
  tokenPresente = true;
  sessaoLanca = null;
}

test('sem token de sessao responde 401 e nao chama a RPC', async () => {
  reset();
  tokenPresente = false;
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(JSON.parse(r.body).error, 'AUTH_REQUIRED');
  assert.strictEqual(argsRpc, null, 'sem sessao nao pode tocar o banco');
});

test('sessao expirada responde 401', async () => {
  reset();
  sessaoLanca = 'SESSION_EXPIRED';
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(JSON.parse(r.body).error, 'SESSION_EXPIRED');
  assert.strictEqual(argsRpc, null);
});

test('ator e tenant vem da sessao; o corpo nao escolhe quem age', async () => {
  reset();
  respostaRpc = { data: { ok: true, driverId: valido.driverId, sessionsRevoked: true }, error: null };
  const r = await handler(ev({
    ...valido,
    // Tentativa de forjar o ator: nao pode ganhar.
    tenantId: 'tenant-do-atacante',
    userId: 'usuario-do-atacante',
    p_actor_user_id: 'usuario-do-atacante',
  }));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(argsRpc.nome, 'admin_driver_reset_pin');
  assert.strictEqual(argsRpc.args.p_actor_user_id, 'ator-da-sessao');
  assert.strictEqual(argsRpc.args.p_tenant_id, 'tenant-da-sessao');
  assert.strictEqual(argsRpc.args.p_driver_id, valido.driverId);
});

test('PIN fora de 4 a 8 digitos responde 400 sem escrever', async () => {
  reset();
  for (const pin of ['123', '123456789', 'abcd', '12 34', '', '   ']) {
    const r = await handler(ev({ driverId: valido.driverId, newPin: pin }));
    assert.strictEqual(r.statusCode, 400, `pin "${pin}" deveria ser 400`);
    assert.strictEqual(argsRpc, null, `pin "${pin}" nao pode chegar na RPC`);
  }
});

test('PIN com espacos nas pontas e aparado antes de conferir', async () => {
  reset();
  respostaRpc = { data: { ok: true, driverId: valido.driverId, sessionsRevoked: true }, error: null };
  const r = await handler(ev({ driverId: valido.driverId, newPin: '  4821  ' }));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(argsRpc.args.p_new_pin, '4821');
});

test('sem driverId responde 400', async () => {
  reset();
  const r = await handler(ev({ newPin: '4821' }));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(JSON.parse(r.body).error, 'DRIVER_ID_REQUIRED');
  assert.strictEqual(argsRpc, null);
});

test('FORBIDDEN da RPC (motorista de outra empresa) vira 403', async () => {
  reset();
  respostaRpc = { data: null, error: { message: 'FORBIDDEN: so a empresa do motorista ou o admin' } };
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(JSON.parse(r.body).error, 'FORBIDDEN');
});

test('motorista inexistente vira 404', async () => {
  reset();
  respostaRpc = { data: null, error: { message: 'DRIVER_NOT_FOUND' } };
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(JSON.parse(r.body).error, 'DRIVER_NOT_FOUND');
});

test('sucesso devolve ok e nao devolve o PIN', async () => {
  reset();
  respostaRpc = { data: { ok: true, driverId: valido.driverId, sessionsRevoked: true }, error: null };
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 200);
  const corpo = JSON.parse(r.body);
  assert.strictEqual(corpo.ok, true);
  assert.strictEqual(corpo.driverId, valido.driverId);
  assert.strictEqual(corpo.sessionsRevoked, true);
  assert.ok(!r.body.includes('4821'), 'o PIN nao pode voltar na resposta');
  assert.strictEqual(r.headers['Cache-Control'], 'no-store');
});

test('erro de infraestrutura nao vaza a mensagem do Postgres', async () => {
  reset();
  respostaRpc = { data: null, error: { message: 'relation "public.drivers" does not exist', code: '42P01' } };
  const r = await handler(ev(valido));
  assert.strictEqual(r.statusCode, 500);
  assert.ok(!r.body.includes('drivers'), 'o schema nao pode sair na resposta');
  assert.ok(!r.body.includes('relation'), 'a mensagem crua nao pode sair na resposta');
});

test('so POST, e JSON invalido responde 400', async () => {
  reset();
  assert.strictEqual((await handler({ httpMethod: 'GET' })).statusCode, 405);
  const r = await handler({ httpMethod: 'POST', body: '{nao é json' });
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual(JSON.parse(r.body).error, 'INVALID_JSON');
});

// --- Guarda de SQL ------------------------------------------------------------
//
// Publicar esta rota so e seguro com a RPC exigindo papel de empresa. A funcao
// nao checava papel, so business_id — e CUSTOMER tem business_id NULL, entao
// qualquer conta de cliente trocaria o PIN de um motorista INDEPENDENTE
// (business_id NULL), que e justamente o caso que a regra de business_id nao
// pega. Ver supabase/fix-admin-driver-reset-pin-role.sql.
//
// Estes testes leem o .sql do repo: nao provam o que o banco de producao tem,
// provam que o SQL versionado nao volta a ser o vulneravel.

const fs = require('node:fs');
const SQL_DIR = path.join(raiz, 'supabase');
const ALVO = 'admin_driver_reset_pin';

// Marcador de "este corpo ja foi substituido por um patch mais novo". O unico
// arquivo que pode ter uma definicao sem o gate de papel e o que carrega isto —
// e ele precisa continuar carregando, senao o teste falha.
const SUPERADA = 'ESTE ARQUIVO ESTA SUPERADO';

// Corpo de cada CREATE [OR REPLACE] FUNCTION public.admin_driver_reset_pin(...),
// do AS $function$ ate o $function$ que fecha. Casa o corpo, nao o comentario.
function corposResetPin() {
  const achados = [];
  for (const arquivo of fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'))) {
    const src = fs.readFileSync(path.join(SQL_DIR, arquivo), 'utf8');
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.admin_driver_reset_pin\s*\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$\s*;/gi;
    let m;
    while ((m = re.exec(src)) !== null) {
      achados.push({ arquivo, corpo: m[1], superada: src.includes(SUPERADA) });
    }
  }
  return achados;
}

test('o SQL versionado de admin_driver_reset_pin existe no repo', () => {
  const corpos = corposResetPin();
  assert.ok(corpos.length > 0, 'nenhuma definicao de admin_driver_reset_pin no repo');
});

test('toda definicao vigente exige papel de empresa, antes do escopo', () => {
  for (const { arquivo, corpo, superada } of corposResetPin()) {
    if (superada) continue; // registro historico; o patch que o segue e o que vale
    const papel = corpo.indexOf("v_actor.role not in ('MERCHANT','ADMIN','STAFF','SUPER_ADMIN')");
    const ator = corpo.indexOf('select * into v_actor from users');
    const escopo = corpo.indexOf('v_actor.business_id is distinct from v_driver.business_id');
    assert.ok(papel !== -1, `${arquivo}: sem exigencia de papel — CUSTOMER passa`);
    assert.ok(ator < papel, `${arquivo}: o ator precisa ser carregado antes do papel`);
    assert.ok(papel < escopo, `${arquivo}: papel antes do escopo de business_id`);
  }
});

test('um corpo sem papel so pode existir em arquivo marcado como superado', () => {
  // Trava o outro lado: se alguem apagar o aviso do arquivo superado, ou criar
  // um patch sem o gate, a definicao vulneravel volta a contar como vigente.
  const semPapel = corposResetPin().filter(({ corpo }) => !corpo.includes('role not in'));
  assert.ok(semPapel.length <= 1, `corpos sem papel demais: ${semPapel.map((c) => c.arquivo).join(', ')}`);
});

test('quem reabre a funcao revoga, e o modulo tem o fecho de schema', () => {
  // Regra 4 do AGENTS.md: funcao nova nasce com EXECUTE para PUBLIC, e
  // DROP+CREATE zera o ACL. O fecho do modulo e o close-function-exec.sql, que a
  // Regra 4 manda rodar ao fim de TODO modulo — e o teste abaixo exige que ele
  // continue fechando o schema public inteiro.
  //
  // Nos patches (fora do modulo) nao ha esse passo: cada um tem que fechar a
  // propria funcao, senao o patch following deixa a porta aberta para anon ate
  // alguem rodar o fecho na mao.
  const fechaTudo = fs.readFileSync(path.join(SQL_DIR, 'close-function-exec.sql'), 'utf8');
  assert.ok(
    /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/i.test(fechaTudo),
    'close-function-exec.sql parou de fechar o schema public',
  );

  const MODULO = 'modulo4-motoristas.sql';
  for (const { arquivo, superada } of corposResetPin()) {
    if (superada) continue;
    const src = fs.readFileSync(path.join(SQL_DIR, arquivo), 'utf8');
    const revoga = /REVOKE EXECUTE ON FUNCTION public\.admin_driver_reset_pin/i.test(src);
    if (arquivo !== MODULO) {
      assert.ok(revoga, `${arquivo}: patch sem REVOKE explicito da funcao que ele recria`);
    }
  }
});