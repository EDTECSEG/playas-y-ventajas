'use strict';

// Trava por precisao (accuracy) da posicao do motorista.
//
// Contexto do bug: a posicao gravada vinha do navegador que estava com a pagina
// aberta. Num COMPUTADOR sem GPS, getCurrentPosition cai para localizacao por
// Wi-Fi/IP e devolve centenas de metros a dezenas de km — a "posicao do
// computador", no no da operadora. Como vehicle_positions e upsert por
// driver_id, esse palpite sobrescrevia a posicao real do celular no mapa.
//
// A trava nao inventa posicao: usa o proprio `coords.accuracy` que o navegador
// ja informa. Toda a decisao fica na logica pura (app/motorista/logic.js); o
// que e so encanamento (repassar o campo, desenhar o aviso) e travado por
// guarda de codigo-fonte.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const MOTORISTA = readFileSync(path.join(RAIZ, 'app', 'motorista', 'page.jsx'), 'utf8');
const ENDPOINT = readFileSync(path.join(RAIZ, 'netlify', 'functions', 'driver-position.js'), 'utf8');
const SQL = readFileSync(path.join(RAIZ, 'supabase', 'fix-driver-position-accuracy.sql'), 'utf8');

const SESSION = { sessionToken: 'sess-abc', status: 'approved' };

let L;
test.before(async () => {
  L = await import(pathToFileURL(path.join(RAIZ, 'app', 'motorista', 'logic.js')).href);
});

test('o limite de precisao e de 150 m', () => {
  // 150 m aceita GPS de celular mesmo em condicao ruim e corta o palpite por
  // IP, que era o que derrubava a posicao verdadeira do celular.
  assert.strictEqual(L.ACCURACY_MAX_M, 150);
});

test('accuracyOk aceita fix bom e recusa palpite por IP', () => {
  for (const bom of [5, 30, 99.9, 150]) {
    assert.strictEqual(L.accuracyOk(bom), true, `${bom} m deveria passar`);
  }
  for (const ruim of [151, 500, 1000, 20000, 999999]) {
    assert.strictEqual(L.accuracyOk(ruim), false, `${ruim} m nao deveria transmitir sozinho`);
  }
});

test('accuracyOk trata desconhecido como nao confiavel', () => {
  // Sem numero confiavel nao da para afirmar que o fix e bom.
  for (const v of [null, undefined, '', 0, -5, 'abc', NaN, Infinity]) {
    assert.strictEqual(L.accuracyOk(v), false, `${JSON.stringify(v)} nao pode passar`);
  }
});

test('accuracyOk respeita um limite customizado', () => {
  assert.strictEqual(L.accuracyOk(200, 300), true);
  assert.strictEqual(L.accuracyOk(200, 100), false);
});

test('accuracyText vira metros ou km, e some quando nao ha numero', () => {
  assert.strictEqual(L.accuracyText(30), '±30 m');
  assert.strictEqual(L.accuracyText(30.4), '±30 m');
  assert.strictEqual(L.accuracyText(999), '±999 m');
  assert.strictEqual(L.accuracyText(1500), '±2 km');
  for (const v of [null, undefined, '', 0, -1, 'abc', NaN]) {
    assert.strictEqual(L.accuracyText(v), '', `${JSON.stringify(v)} nao pode virar texto`);
  }
});

test('buildPositionRequest leva a precisao junto e aceita ausencia', () => {
  const r = L.buildPositionRequest({ session: SESSION, lat: -22.9, lng: -43.1, accuracyM: 12.5 });
  assert.strictEqual(r.body.accuracyM, 12.5);
  const sem = L.buildPositionRequest({ session: SESSION, lat: -22.9, lng: -43.1 });
  assert.strictEqual(sem.body.accuracyM, null);
});

// ------------------------------------------------------- Encaminhamento

test('o endpoint repassa accuracyM como p_accuracy_m para a RPC', () => {
  assert.ok(/p_accuracy_m/.test(ENDPOINT), 'a RPC precisa receber a precisao');
  assert.ok(/accuracyM/.test(ENDPOINT), 'a precisao vem do corpo como accuracyM');
});

test('a tela do motorista le coords.accuracy e aplica a trava no auto-envio', () => {
  assert.ok(/pos\.coords\.accuracy/.test(MOTORISTA), 'a tela precisa capturar a precisao do fix');
  assert.ok(/accuracyOk\(/.test(MOTORISTA), 'o auto-envio precisa consultar accuracyOk');
});

test('o motorista ve a precisao e o motivo quando o sinal e fraco', () => {
  assert.ok(/accuracyText\(/.test(MOTORISTA), 'a precisao precisa aparecer na tela');
  assert.ok(/setPrecisao/.test(MOTORISTA), 'a tela precisa guardar a precisao lida');
});

// ------------------------------------------------------- Banco

test('a migracao cria a coluna, guarda e devolve a precisao', () => {
  assert.ok(/ADD COLUMN IF NOT EXISTS accuracy_m/.test(SQL), 'falta a coluna accuracy_m');
  assert.ok(/p_accuracy_m double precision/.test(SQL), 'a RPC precisa do parametro p_accuracy_m');
  assert.ok(/accuracy_m\s*=/.test(SQL) || /accuracy_m\s*,/.test(SQL), 'o upsert precisa gravar accuracy_m');
  assert.ok(/'accuracyM',\s*v\.accuracy_m/.test(SQL), 'list_live_vehicles precisa expor accuracyM');
});
