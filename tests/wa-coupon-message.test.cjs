'use strict';

// Guarda do texto da mensagem de WhatsApp do cupom (netlify/functions/_wa.js).
//
// O texto foi reescrito a pedido do dono (setembro/2026): a saudacao "Ola! Vim
// pelo..." e a pergunta "Podem me informar como utilizo?" sairam, e o link do
// site (mais o de indicacao, quando faz sentido) entraram. Este teste existe
// para ninguem reintroduzir a saudacao/frase final sem perceber, e para
// garantir que o link do site nao suma em silencio.

const { test } = require('node:test');
const assert = require('node:assert');
const { buildCouponMessage, buildWaLink, siteUrl } = require('../netlify/functions/_wa.js');

test('a mensagem comeca na marca e nao faz pergunta', () => {
  const msg = buildCouponMessage({
    publicId: 'PYV-DF36FB2C64',
    businessName: 'Restaurante Sabor Company',
    title: '10% desc Feijoada light',
    shortCode: '453033',
    site: 'https://exemplo.test',
  });
  const linhas = msg.split('\n');

  assert.strictEqual(linhas[0], '*Playas y Ventajas*', 'a primeira linha e a marca');
  assert.ok(!/^Ola!/i.test(msg), 'sem saudacao');
  assert.ok(!/Vim pelo/i.test(msg), 'sem "vim pelo"');
  assert.ok(!/informar como utilizo/i.test(msg), 'sem a pergunta final');
  assert.ok(!/utm_/i.test(msg), 'sem parametro de rastreio');
  assert.strictEqual(linhas[linhas.length - 1], '*Site:* https://exemplo.test', 'a ultima linha e o site');
});

test('a mensagem mantem os dados que o balcao precisa (cupom, empresa, codigo)', () => {
  const msg = buildCouponMessage({
    publicId: 'PYV-DF36FB2C64',
    businessName: 'Restaurante Sabor Company',
    title: '10% desc Feijoada light',
    site: 'https://exemplo.test',
  });
  assert.ok(msg.includes('*Cupom:* 10% desc Feijoada light'));
  assert.ok(msg.includes('*Estabelecimento:* Restaurante Sabor Company'));
  assert.ok(msg.includes('*Codigo:* PYV-DF36FB2C64'));
});

// O codigo curto foi retirado do texto: o balcao nao tem campo para digitar e
// o codigo longo ja autoriza sozinho, entao ele so gerava confusao. Se
// alguem reintroduzir, este teste avisa.
test('a mensagem nao manda mais o codigo curto', () => {
  const msg = buildCouponMessage({
    publicId: 'PYV-DF36FB2C64',
    businessName: 'Restaurante Sabor Company',
    title: '10% desc Feijoada light',
    shortCode: '453033',
    site: 'https://exemplo.test',
  });
  assert.ok(!/Codigo curto/.test(msg), 'voltou o codigo curto: ninguem no balcao consegue usar');
  assert.ok(!msg.includes('453033'));
});

test('o link de indicacao so aparece quando ha codigo de afiliado', () => {
  const semAfiliado = buildCouponMessage({ publicId: 'PYV-1', site: 'https://exemplo.test' });
  assert.ok(!/Link de indicacao/.test(semAfiliado), 'cliente comum nao recebe link de filiacao');

  const comAfiliado = buildCouponMessage({
    publicId: 'PYV-1',
    site: 'https://exemplo.test',
    referralCode: 'MEUNOME-8E94',
  });
  assert.ok(comAfiliado.includes('*Link de indicacao:* https://exemplo.test/?ref=MEUNOME-8E94'));
});

test('campos vazios nao viram linhas "undefined"', () => {
  const msg = buildCouponMessage({ site: 'https://exemplo.test' });
  assert.ok(!/undefined|null|NaN/.test(msg), 'sem undefined/null/NaN na mensagem');
  assert.strictEqual(msg, '*Playas y Ventajas*\n*Site:* https://exemplo.test');
});

test('siteUrl usa a reserva de producao e nunca barra dupla', () => {
  const original = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    assert.strictEqual(siteUrl(), 'https://playas-y-ventajas.pages.dev');

    process.env.NEXT_PUBLIC_SITE_URL = 'https://exemplo.test/';
    assert.strictEqual(siteUrl(), 'https://exemplo.test');
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = original;
  }
});

test('buildWaLink continua mandando o texto no link wa.me', () => {
  const url = buildWaLink({ phone: '11 98765-4321', message: '*Playas y Ventajas*' });
  assert.ok(url.startsWith('https://wa.me/5511987654321?text='), url);
  assert.ok(url.includes(encodeURIComponent('*Playas y Ventajas*')));
});
