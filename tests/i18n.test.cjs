'use strict';

// Guard i18n: toda chave `t.KEY`/`t?.KEY`/`t\['KEY'\]` usada no app precisa
// existir em pt, en e es — e os tres idiomas precisam ter exatamente o mesmo
// conjunto de chaves. Assim uma tela nova nao consegue quebrar EN/ES em
// silencio (o dict fica completo de novo no mesmo passo).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers.cjs');

const APP_DIR = path.join(ROOT, 'app');
const I18N_PATH = path.join(ROOT, 'lib', 'i18n.js');

function listJsx(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsx(p));
    else if (e.name.endsWith('.jsx')) out.push(p);
  }
  return out;
}

function dictKeys() {
  const src = fs.readFileSync(I18N_PATH, 'utf8');
  const start = src.indexOf('export const translations =');
  const end = src.indexOf('\n};', start);
  const literal = src.slice(start + 'export const translations ='.length, end + 2);
  // eslint-disable-next-line no-new-func
  const translations = new Function('return ' + literal)();
  return {
    pt: translations.pt,
    en: translations.en,
    es: translations.es,
  };
}

function usedKeys() {
  const src = listJsx(APP_DIR).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const used = new Set();
  for (const m of src.matchAll(/\bt\.([A-Za-z0-9_]+)\b/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bt\?\.([A-Za-z0-9_]+)\b/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bt\[['"]([^'"]+)['"]\]/g)) used.add(m[1]);
  return used;
}

test('pt, en e es tem exatamente o mesmo conjunto de chaves', () => {
  const keys = dictKeys();
  const kp = Object.keys(keys.pt).sort();
  assert.deepStrictEqual(Object.keys(keys.en).sort(), kp, 'en deve ter as mesmas chaves que pt');
  assert.deepStrictEqual(Object.keys(keys.es).sort(), kp, 'es deve ter as mesmas chaves que pt');
});

test('toda chave usada no app existe em pt, en e es', () => {
  const keys = dictKeys();
  const pt = new Set(Object.keys(keys.pt));
  const en = new Set(Object.keys(keys.en));
  const es = new Set(Object.keys(keys.es));
  const used = usedKeys();
  const missing = [...used].filter((k) => !pt.has(k)).sort();
  assert.deepStrictEqual(missing, [], 'chaves usadas no app ausentes do dicionario');
  for (const k of used) {
    assert.ok(en.has(k), `chave usada ausente em en: ${k}`);
    assert.ok(es.has(k), `chave usada ausente em es: ${k}`);
  }
});

