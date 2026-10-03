'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const comp = read('app/components/PasswordInput.jsx');
const admin = read('app/admin/page.jsx');
const empresa = read('app/empresa/page.jsx');
const motorista = read('app/motorista/page.jsx');

function count(src, needle) {
  return src.split(needle).length - 1;
}

test('PasswordInput mascara por padrão e alterna para texto', () => {
  assert.ok(comp.includes("type={show ? 'text' : 'password'}"), 'alterna password/text');
  assert.ok(comp.includes('useState(false)'), 'começa oculto (bolinhas)');
});

test('PasswordInput tem botão de olho para visualizar', () => {
  assert.ok(comp.includes('<button'), 'tem botão');
  assert.ok(comp.includes('type="button"'), 'botão não submete formulário');
  assert.ok(comp.includes('onClick={() => setShow((s) => !s)}'), 'clique alterna a visão');
  assert.ok(comp.includes('Mostrar senha') && comp.includes('Ocultar senha'), 'rotula mostrar/ocultar');
});

test('nenhum campo de senha cru no app (tudo pelo PasswordInput)', () => {
  const jsx = read('app/components/Header.jsx') + admin + empresa + motorista;
  assert.strictEqual(count(jsx, 'type="password"'), 0, 'sem type="password" inline');
  assert.strictEqual(count(jsx, "type='password'"), 0, 'sem type=password com aspas simples');
});

test('todos os pontos de senha usam PasswordInput', () => {
  for (const [name, src, expected] of [
    ['admin', admin, 2],
    ['empresa', empresa, 6],
    ['motorista', motorista, 3],
  ]) {
    assert.ok(src.includes("import PasswordInput from '../components/PasswordInput'"), `${name} importa o componente`);
    assert.strictEqual(count(src, '<PasswordInput'), expected, `${name} usa PasswordInput ${expected}x`);
  }
});

test('os campos que estavam sem máscara agora usam PasswordInput', () => {
  assert.ok(admin.includes('<PasswordInput style={input} placeholder={t.pinMin} value={form.ownerPin}'), 'PIN da empresa');
  assert.ok(empresa.includes('<PasswordInput style={input} placeholder={t.password} value={form.pin}'), 'senha do login da empresa');
});
