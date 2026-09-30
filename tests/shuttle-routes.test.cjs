'use strict';

// Worker: as duas rotas novas precisam estar na whitelist.
//
// Fora do ROUTES, o endpoint responde 404 em producao mesmo com a funcao
// existindo e o import estar la. A lista e a superficie publica do plano Free
// (Regra 2 do AGENTS.md: endpoint novo na whitelist e "perguntar antes"), e o
// teste existe para a entrada nunca ser esquecida junto do handler.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const WORKER = path.join(__dirname, '..', 'worker', 'main.js');
const src = readFileSync(WORKER, 'utf8');

const ROTAS_NOVAS = ['shuttle-reservation', 'driver-shuttle-runs'];

test('os dois handlers novos tem import estatico no worker', () => {
  // Import estatico e nao dinamico: o bundle do postbuild (scripts/bundle-worker.mjs)
  // so enxerga o que o analisador ve estaticamente, e uma rota sem import
  // responderia 404 em producao.
  assert.ok(
    /import shuttleReservation from '\.\.\/netlify\/functions\/shuttle-reservation\.js'/.test(src),
    'falta o import estatico de shuttle-reservation',
  );
  assert.ok(
    /import driverShuttleRuns from '\.\.\/netlify\/functions\/driver-shuttle-runs\.js'/.test(src),
    'falta o import estatico de driver-shuttle-runs',
  );
});

test('as duas rotas novas estao no ROUTES', () => {
  const ini = src.indexOf('const ROUTES');
  assert.ok(ini !== -1, 'ROUTES nao encontrado no worker/main.js');
  const blocoRoutes = src.slice(ini, src.indexOf('};', ini));
  for (const nome of ROTAS_NOVAS) {
    assert.ok(
      new RegExp(`'${nome}':`).test(blocoRoutes),
      `a rota ${nome} precisa estar no ROUTES de worker/main.js, senao responde 404 em producao`,
    );
  }
});

test('os nomes das rotas novas casam com a regex que o worker extrai da URL', () => {
  // A regex de rota aceita so [a-z0-9-]; um nome com ponto, barra ou underscore
  // cai no 404 silencioso em vez de chegar no ROUTES. Lemos a regex do proprio
  // arquivo: se ela mudar, o teste acompanha em vez de Navarra de verdade.
  const achado = src.match(/path\.match\((\/\^.*?\$\/)\)/);
  assert.ok(achado, 'nao encontrei a regex de rota em worker/main.js');
  const re = eval(achado[1]);
  for (const nome of ROTAS_NOVAS) {
    const m = re.exec(`/.netlify/functions/${nome}`);
    assert.ok(m, `${nome} nao casa com a regex de rota do worker`);
    assert.strictEqual(m[1], nome, 'o grupo capturado precisa ser o nome da rota');
  }
});

test('o handler importado e o que o ROUTES aponta', () => {
  // Trocar a chave pelo identificador errado (ou inverter) faz a rota responder
  // com a funcao da outra: 200 no lugar de 401 vira brecha.
  const blocoRoutes = src.slice(src.indexOf('const ROUTES'), src.indexOf('};', src.indexOf('const ROUTES')));
  assert.ok(/: shuttleReservation,/.test(blocoRoutes), "'shuttle-reservation' precisa apontar para shuttleReservation");
  assert.ok(/: driverShuttleRuns,/.test(blocoRoutes), "'driver-shuttle-runs' precisa apontar para driverShuttleRuns");
});

test('as rotas novas sao treatment de sessao, sem entrada anonima no adapter', () => {
  // Nao ha bypass por Allowlist: o token e conferido dentro do handler
  // (customerToken HMAC no cliente, driver_sessions no banco).
  const blocoRoutes = src.slice(src.indexOf('const ROUTES'), src.indexOf('};', src.indexOf('const ROUTES')));
  assert.ok(
    !/allowlist|allowList|bypass/i.test(blocoRoutes),
    'as rotas novas nao podem entrar por bypass de sessao: a credencial e conferida no handler',
  );
});
