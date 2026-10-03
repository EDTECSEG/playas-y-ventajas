'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const menu = read('app/components/LanguageMenu.jsx');
const header = read('app/components/Header.jsx');
const home = read('app/page.jsx');

test('LanguageMenu oferece exatamente pt/en/es', () => {
  assert.ok(menu.includes("[['pt', 'PT'], ['en', 'EN'], ['es', 'ES']]"), 'lista com as três opções');
  assert.ok(menu.includes('setLang(code)'), 'troca o idioma ao clicar');
  assert.ok(menu.includes('useLanguage'), 'usa o contexto de idioma');
});

test('Header compartilhado renderiza o seletor (cobre todas as telas)', () => {
  assert.ok(header.includes("import LanguageMenu from './LanguageMenu'"), 'importa o seletor');
  assert.ok(header.includes('<LanguageMenu light />'), 'renderiza no cabeçalho');
});

test('home reutiliza o componente compartilhado (sem duplicar)', () => {
  assert.ok(home.includes("import LanguageMenu from './components/LanguageMenu'"), 'importa o compartilhado');
  assert.ok(home.includes('<LanguageMenu />'), 'renderiza o seletor');
  assert.ok(!home.includes('function LanguageMenu'), 'não mantém definição local duplicada');
});
