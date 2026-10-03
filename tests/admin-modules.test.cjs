'use strict';

const test = require('node:test');
const assert = require('node:assert');

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

global.window = { sessionStorage: fakeStorage() };

let m;

test.before(async () => {
  m = await import('../lib/adminModules.js');
});

test('rota do menu é /admin/modulos', () => {
  assert.strictEqual(m.ADMIN_MODULES_PATH, '/admin/modulos');
});

test('isAdminRole é estrito e case-sensitive', () => {
  assert.strictEqual(m.isAdminRole('ADMIN'), true);
  assert.strictEqual(m.isAdminRole('SUPER_ADMIN'), true);
  assert.strictEqual(m.isAdminRole('MERCHANT'), false);
  assert.strictEqual(m.isAdminRole('admin'), false);
  assert.strictEqual(m.isAdminRole(undefined), false);
  assert.strictEqual(m.isAdminRole(null), false);
});

test('origem: marca e consome uma única vez', () => {
  global.window.sessionStorage.clear();
  m.markAdminModulesOrigin();
  assert.strictEqual(m.consumeAdminModulesOrigin(), true);
  assert.strictEqual(m.consumeAdminModulesOrigin(), false);
});

test('origem: sem marca não mostra Volver', () => {
  global.window.sessionStorage.clear();
  assert.strictEqual(m.consumeAdminModulesOrigin(), false);
});

test('origem: valor errado (case-sensitive) não mostra Volver', () => {
  for (const bad of ['Admin-Modulos', 'admin_modulos', ' admin-modulos', 'admin-modulos ']) {
    global.window.sessionStorage.clear();
    global.window.sessionStorage.setItem(m.ADMIN_ORIGIN_KEY, bad);
    assert.strictEqual(m.consumeAdminModulesOrigin(), false, `não deveria aceitar "${bad}"`);
  }
});

test('origem: consumo remove a chave mesmo com valor errado', () => {
  global.window.sessionStorage.clear();
  global.window.sessionStorage.setItem(m.ADMIN_ORIGIN_KEY, 'x');
  assert.strictEqual(m.consumeAdminModulesOrigin(), false);
  assert.strictEqual(global.window.sessionStorage.getItem(m.ADMIN_ORIGIN_KEY), null);
});

test('sessão admin: salva, carrega e limpa', () => {
  const data = { sessionToken: 'tok', userId: 'u1', tenantId: 't1', role: 'ADMIN', businessId: null };
  m.saveAdminSession(data);
  assert.deepStrictEqual(m.loadAdminSession(), data);
  m.clearAdminSession();
  assert.strictEqual(m.loadAdminSession(), null);
});

test('sessão admin: ausente e corrompida viram null', () => {
  global.window.sessionStorage.clear();
  assert.strictEqual(m.loadAdminSession(), null);
  global.window.sessionStorage.setItem(m.ADMIN_SESSION_KEY, '{corrompido');
  assert.strictEqual(m.loadAdminSession(), null);
});

test('catálogo cobre os cinco módulos com href, título e subtítulo', () => {
  const ids = m.ADMIN_MODULES.map((x) => x.id).sort();
  assert.deepStrictEqual(ids, ['admin', 'afiliado', 'cliente', 'empresa', 'motorista']);
  for (const x of m.ADMIN_MODULES) {
    assert.ok(x.href.startsWith('/'), `${x.id} href`);
    assert.ok(typeof x.titleKey === 'string' && x.titleKey.length > 0, `${x.id} titleKey`);
    assert.ok(typeof x.subKey === 'string' && x.subKey.length > 0, `${x.id} subKey`);
  }
});
