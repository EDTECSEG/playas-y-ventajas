'use strict';

// /cliente: chave de idempotencia do resgate.
//
// Resgatar cupom emite cupom e consome estoque. Se a rede cai DEPOIS do
// servidor ter emitido, o cliente fica sem cupom e sem erro claro; ao tocar de
// novo sem chave, a RPC emite OUTRO cupom. E o que estes testes seguram.
//
// Nao da para renderizar JSX neste runner, entao a estrategia e dupla:
//
//   1) os helpers (newClaimKey / claimKeyFor / clearClaimKey) sao JS puro de
//      escopo de modulo, sem React e sem JSX. Eles sao EXTRAIDOS do fonte e
//      EXECUTADOS de verdade, com sessionStorage e crypto falsos. Isso testa
//      comportamento, nao texto.
//   2) o `claim()` depende de React, entao nele a guarda e de codigo-fonte,
//      no mesmo estilo de cliente-shuttle-reservation-guard.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'app', 'cliente', 'page.jsx');
const src = readFileSync(PAGE, 'utf8');

function bloco(inicio, fim) {
  const a = src.indexOf(inicio);
  assert.ok(a !== -1, `nao encontrei ${inicio} na pagina`);
  const b = src.indexOf(fim, a + 1);
  assert.ok(b !== -1, `nao encontrei ${fim} depois de ${inicio}`);
  return src.slice(a, b);
}

const helpers = bloco('const CLAIM_KEYS_STORAGE', 'export default function');
const claim = bloco('async function claim(offer)', 'useEffect(() => {');

// Carrega os helpers num contexto controlado.
function carregar({ storage, crypto } = {}) {
  const st = storage || fakeStorage();
  const cr = crypto === undefined ? fakeCrypto() : crypto;
  const f = new Function(
    'sessionStorage', 'window',
    helpers + '\nreturn { claimKeyFor, clearClaimKey, newClaimKey, readClaimKeys };',
  );
  return f(st, { crypto: cr });
}

function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

function fakeCrypto() {
  let s = 0;
  return {
    getRandomValues: (b) => {
      for (let i = 0; i < b.length; i++) { s = (s * 1103515245 + 12345) % 2147483648; b[i] = s % 256; }
      return b;
    },
  };
}

const CHAVE = 'pyv_claim_keys';

// ---------------------------------------------------------------------------
// 1) Comportamento executado
// ---------------------------------------------------------------------------

test('duas tentativas do mesmo template reusam a MESMA chave', () => {
  const { claimKeyFor } = carregar();
  const a = claimKeyFor('tmpl-1');
  const b = claimKeyFor('tmpl-1');
  assert.ok(a, 'deveria gerar chave');
  assert.strictEqual(b, a, 'o retry tem que reusar a chave, senao emite um segundo cupom');
});

test('templates diferentes nunca compartilham chave', () => {
  const { claimKeyFor } = carregar();
  assert.notStrictEqual(claimKeyFor('tmpl-1'), claimKeyFor('tmpl-2'));
});

test('depois de concluir, o proximo resgate do MESMO template usa chave nova', () => {
  const { claimKeyFor, clearClaimKey } = carregar();
  const a = claimKeyFor('tmpl-1');
  clearClaimKey('tmpl-1');
  const b = claimKeyFor('tmpl-1');
  // Se reusasse, o segundo resgate legitimo (o limite e 3) viraria replay e
  // o cliente receberia o cupom antigo de novo em vez de um novo.
  assert.notStrictEqual(b, a);
});

test('a chave tem 128 bits em hex e nao e adivinhavel', () => {
  const { claimKeyFor } = carregar();
  const k = claimKeyFor('tmpl-1');
  assert.strictEqual(k.length, 32);
  assert.ok(/^[0-9a-f]{32}$/.test(k), 'tem que ser hex de 32 chars: ' + k);
});

test('chave vencida pelo TTL e descartada', () => {
  const st = fakeStorage();
  // ts no passado, bem alem do TTL de 30min.
  st.setItem(CHAVE, JSON.stringify({ 'tmpl-1': { k: 'a'.repeat(32), ts: Date.now() - 31 * 60 * 1000 } }));
  const { claimKeyFor } = carregar({ storage: st });
  const k = claimKeyFor('tmpl-1');
  assert.notStrictEqual(k, 'a'.repeat(32), 'chave expirada nao pode ser reusada');
});

test('o TTL conta desde a PRIMEIRA tentativa, nao desde o ultimo retry', () => {
  const st = fakeStorage();
  const velho = Date.now() - 29 * 60 * 1000; // ainda dentro do TTL
  st.setItem(CHAVE, JSON.stringify({ 'tmpl-1': { k: 'b'.repeat(32), ts: velho } }));
  const { claimKeyFor } = carregar({ storage: st });
  // Reaproveita e nao regrava com timestamp novo: se regravasse, um retry
  // arrastado nunca deixaria a chave expirar.
  assert.strictEqual(claimKeyFor('tmpl-1'), 'b'.repeat(32));
  const guardado = JSON.parse(st.getItem(CHAVE));
  assert.strictEqual(guardado['tmpl-1'].ts, velho, 'o ts original tem que ser preservado');
});

test('sem crypto, devolve null em vez de uma chave adivinhavel', () => {
  const { claimKeyFor, newClaimKey } = carregar({ crypto: null });
  assert.strictEqual(newClaimKey(), null);
  assert.strictEqual(claimKeyFor('tmpl-1'), null, 'sem crypto o resgate segue sem chave, nunca travado');
});

test('sem sessionStorage (dono negando), devolve null e nao quebra', () => {
  const storage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  const { claimKeyFor, clearClaimKey } = carregar({ storage });
  assert.strictEqual(claimKeyFor('tmpl-1'), null);
  assert.doesNotThrow(() => clearClaimKey('tmpl-1'));
});

test('storage com lixo no formato nao quebra o resgate', () => {
  for (const lixo of ['nao-e-json', '[]', 'null', '{"tmpl-1":"texto"}', '{"tmpl-1":{"k":"x","ts":"ontem"}}']) {
    const st = fakeStorage({ [CHAVE]: lixo });
    const { claimKeyFor, clearClaimKey } = carregar({ storage: st });
    assert.doesNotThrow(() => claimKeyFor('tmpl-1'), lixo);
    assert.doesNotThrow(() => clearClaimKey('tmpl-1'), lixo);
    assert.ok(claimKeyFor('tmpl-1'), 'precisa gerar uma chave valida mesmo com lixo: ' + lixo);
  }
});

test('clearClaimKey em template desconhecido nao cria entrada', () => {
  const st = fakeStorage();
  const { clearClaimKey } = carregar({ storage: st });
  clearClaimKey('tmpl-que-nunca-existiu');
  assert.strictEqual(st.getItem(CHAVE), null);
});

test('limpar um template nao apaga a chave de outro', () => {
  const { claimKeyFor, clearClaimKey } = carregar();
  const a = claimKeyFor('tmpl-1');
  const b = claimKeyFor('tmpl-2');
  clearClaimKey('tmpl-1');
  assert.strictEqual(claimKeyFor('tmpl-2'), b, 'tmpl-2 tem que continuar com a chave dele');
  assert.notStrictEqual(claimKeyFor('tmpl-1'), a);
});

// ---------------------------------------------------------------------------
// 2) Guardas de codigo-fonte no claim() (depende de React)
// ---------------------------------------------------------------------------

test('claim envia a idempotencyKey no corpo', () => {
  assert.ok(/idempotencyKey/.test(claim), 'a chave tem que ir no corpo do POST');
  assert.ok(/claimKeyFor\(templateId\)/.test(claim), 'claim tem que pedir a chave por template');
});

test('o fetch do resgate esta dentro de try/catch', () => {
  // Sem isto, uma queda de rede vira rejeicao nao tratada e a tela fica muda.
  const iTry = claim.indexOf('try {');
  const iFetch = claim.indexOf('fetch(');
  const iCatch = claim.indexOf('catch (e)', iFetch);
  assert.ok(iFetch !== -1, 'nao achei o fetch');
  assert.ok(iTry !== -1 && iTry < iFetch, 'o fetch precisa estar depois de um try');
  assert.ok(iCatch !== -1 && iCatch > iFetch, 'o fetch precisa ter catch');
});

test('a rede caída mostra mensagem e NAO segue como se tivesse resgatado', () => {
  const trecho = claim.slice(claim.indexOf('catch (e)', claim.indexOf('fetch(')));
  assert.ok(/setMsg\(/.test(trecho), 'tem que avisar o usuario');
  assert.ok(/return;/.test(trecho), 'tem que abortar: nao segue para o caminho de sucesso');
});

test('a chave e liberada quando o desfecho e definido', () => {
  assert.ok(
    /res\.ok \|\| \(res\.status >= 400 && res\.status < 500\)/.test(claim),
    '2xx e 4xx liberam a chave: a tentativa acabou',
  );
  assert.ok(
    /clearClaimKey\(templateId\)/.test(claim),
    'a chave precisa ser liberada em algum ponto, senao o segundo resgate vira replay',
  );
});

test('a chave e MANTIDA quando o desfecho e incerto (5xx / corpo invalido)', () => {
  // clearClaimKey nao pode estar antes do check de res.ok: num 502 o cupom
  // pode ter sido emitido e o retry tem que ser o replay dele.
  const iClear = claim.indexOf('if (res.ok ||');
  const iCheck = claim.indexOf('if (!res.ok');
  assert.ok(iClear !== -1, 'nao achei a liberacao condicional');
  assert.ok(iClear < iCheck, 'a liberacao vem antes do tratamento do erro: 502 perderia a chave');
});

test('o parse do corpo tambem esta protegido (502 nao devolve JSON)', () => {
  assert.ok(
    /try \{\s*data = await res\.json\(\);\s*\} catch/.test(claim),
    'res.json() sem try quebra a tela quando o gateway devolve HTML em vez de JSON',
  );
});

test('o tratamento de erro mostra o motivo devolvido pela RPC', () => {
  assert.ok(/data\.error/.test(claim), 'tem que mostrar o erro do servidor, tipo LIMIT_REACHED');
});