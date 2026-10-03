'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const header = read('app/components/Header.jsx');
const adminPage = read('app/admin/page.jsx');
const modulosPage = read('app/admin/modulos/page.jsx');
const adminModules = read('lib/adminModules.js');
const i18n = read('lib/i18n.js');

function countKey(src, key) {
  const re = new RegExp(`\\b${key}\\s*:`, 'g');
  return (src.match(re) || []).length;
}

test('Header centraliza o Volver: consome origem e volta via replace', () => {
  assert.ok(header.includes('consumeAdminModulesOrigin'), 'Header importa/usa consumeAdminModulesOrigin');
  assert.ok(header.includes('ADMIN_MODULES_PATH'), 'Header importa ADMIN_MODULES_PATH');
  assert.ok(header.includes('router.replace(ADMIN_MODULES_PATH)'), 'Volver usa router.replace para o menu');
  assert.ok(header.includes('t.backToModules'), 'rótulo do botão vem do i18n');
  assert.ok(header.includes('showBack &&'), 'o botão só renderiza quando a origem é válida');
  assert.ok(header.includes('useEffect'), 'origem é consumida no mount (reload/URL direta não mostram)');
});

test('menu de módulos marca a origem antes de navegar e protege a rota', () => {
  assert.ok(modulosPage.includes('markAdminModulesOrigin()'), 'clique marca a origem');
  assert.ok(/openModule[\s\S]*markAdminModulesOrigin\(\)[\s\S]*router\.push\(href\)/.test(modulosPage), 'marca origem e só então navega');
  assert.ok(modulosPage.includes('router.replace(\'/admin\')'), 'sem sessão admin volta para o login');
  assert.ok(modulosPage.includes('isAdminRole'), 'valida o perfil admin');
  assert.ok(modulosPage.includes('t.adminModulesTitle'), 'usa o título i18n do menu');
});

test('admin persiste sessão, redireciona pós-login e limpa no logout', () => {
  assert.ok(adminPage.includes('saveAdminSession(data)'), 'login salva a sessão');
  assert.ok(adminPage.includes('router.replace(ADMIN_MODULES_PATH)'), 'login redireciona ao menu');
  assert.ok(adminPage.includes('loadAdminSession()'), 'mount restaura a sessão');
  assert.ok(adminPage.includes('clearAdminSession()'), 'logout limpa a sessão');
  assert.ok(adminPage.includes('isAdminRole'), 'valida o perfil');
});

test('helper centraliza rota, origem e sessão', () => {
  assert.ok(adminModules.includes("export const ADMIN_MODULES_PATH = '/admin/modulos'"), 'rota do menu');
  assert.ok(adminModules.includes('export const ADMIN_MODULES'), 'catálogo de módulos');
  assert.ok(adminModules.includes('export function isAdminRole'), 'validação de perfil');
  assert.ok(adminModules.includes('export function markAdminModulesOrigin'), 'marca origem');
  assert.ok(adminModules.includes('export function consumeAdminModulesOrigin'), 'consome origem');
  assert.ok(/value === ADMIN_ORIGIN_VALUE/.test(adminModules), 'comparação estrita (case-sensitive)');
  assert.ok(adminModules.includes('export function saveAdminSession'), 'salva sessão');
  assert.ok(adminModules.includes('export function loadAdminSession'), 'carrega sessão');
  assert.ok(adminModules.includes('export function clearAdminSession'), 'limpa sessão');
});

test('i18n traz as novas chaves nos três idiomas (paridade)', () => {
  const keys = ['backToModules', 'adminModulesTitle', 'motoristaSub', 'affiliateTitle', 'affiliateSub'];
  for (const k of keys) {
    assert.strictEqual(countKey(i18n, k), 3, `${k} deve existir em pt/en/es`);
  }
});

test('i18n cobre todos os rótulos dinâmicos do catálogo', () => {
  const catalog = read('lib/adminModules.js');
  const keyNames = [...catalog.matchAll(/(?:titleKey|subKey):\s*'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
  assert.ok(keyNames.length >= 10, 'catálogo expõe todos os titleKey/subKey');
  for (const k of keyNames) {
    assert.strictEqual(countKey(i18n, k), 3, `${k} deve existir em pt/en/es`);
  }
});
