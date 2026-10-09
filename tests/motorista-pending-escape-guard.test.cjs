'use strict';

// Estado preso do cadastro do motorista (login simples).
//
// Contexto do bug: apos definir o PIN, o app tenta o login automatico
// (definirPin -> autenticar). Se esse login falha no momento (rede, servidor),
// o cadastro pela metade fica em localStorage SEM pinToken, e a tela cai no
// estado `pending && !session`. Nesse estado:
//   - as abas Entrar/Cadastrar so renderizam com `!session && !pending`, entao
//     o motorista NAO CHEGA ao formulario de login;
//   - o botao "Sair" so aparece com sessao;
//   - pior: o card de documentos fica visivel, e reenviar documento rebaixa um
//     motorista aprovado de volta para pending (driver_add_document).
// Resultado: um motorista com cadastro aprovado pela empresa fica preso numa
// tela que pede "colocar o pin e enviar documentos", sem saida e sem chegar ao
// login -- exatamente o relato que motivou esta correcao.
//
// Sem jsdom, o comportamento fica travado por guardas de codigo-fonte, no mesmo
// estilo de vehicle-pin.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const MOTORISTA = readFileSync(path.join(RAIZ, 'app', 'motorista', 'page.jsx'), 'utf8');
const I18N = readFileSync(path.join(RAIZ, 'lib', 'i18n.js'), 'utf8');

function trechoI18n(idioma) {
  const bloco = I18N.slice(I18N.indexOf(`  ${idioma}: {`));
  return bloco.slice(0, bloco.indexOf('\n  };'));
}

// --------------------------------------------------------- Saida do estado preso

test('o escape limpa o pending local e leva a aba Entrar, sem chamada ao servidor', () => {
  const bloco = MOTORISTA.slice(MOTORISTA.indexOf('const irParaLogin'));
  const fim = bloco.indexOf('\n  const ');
  const handler = fim === -1 ? bloco : bloco.slice(0, fim);
  assert.ok(/const irParaLogin = \(\) => \{/.test(handler), 'falta o handler de escape');
  assert.ok(
    /localStorage\.removeItem\('pyv_driver_pending'\)/.test(handler),
    'o escape precisa remover o cadastro pela metade do navegador',
  );
  assert.ok(/setPending\(null\)/.test(handler), 'o escape precisa limpar o estado pending');
  assert.ok(/setTab\('entrar'\)/.test(handler), 'o escape precisa mostrar a aba Entrar');
  assert.ok(
    !/await|fetch\(/.test(handler),
    'o escape nao pode depender de rede: o motorista preso nao tem sessao',
  );
});

test('o card de pending mostra o botao de escape ligado ao handler', () => {
  assert.ok(
    /onClick=\{irParaLogin\}>\{t\.goToLogin\}/.test(MOTORISTA),
    'o card de pending precisa renderizar o botao que leva ao login',
  );
});

test('o escape fica no card pending && !session, e a aba continua oculta nesse estado', () => {
  const card = MOTORISTA.slice(MOTORISTA.indexOf('pending && !session ?'));
  const dentro = card.slice(0, card.indexOf(') : null}'));
  assert.ok(/goToLogin/.test(dentro), 'o botao de escape fica no card do pending');
  assert.ok(
    /!session && !pending \?/.test(MOTORISTA),
    'as abas precisam continuar ocultas quando ha pending (e o escape, a saida)',
  );
});

// ------------------------------------------------- Non-rebaixamento de aprovado

test('o card de documentos so mostra o formulario quando NAO esta aprovado', () => {
  const card = MOTORISTA.slice(MOTORISTA.indexOf('(session || pending) ?'));
  const dentro = card.slice(0, card.indexOf(') : null}'));
  assert.ok(
    /canDrive\(session && session\.status\)/.test(dentro),
    'a decisao de mostrar o form precisa nascer do status da sessao',
  );
  assert.ok(
    /docApprovedNote/.test(dentro),
    'para approved o card precisa confirmar a situacao em vez de oferecer reenvio',
  );
});

test('o botao "Enviar documento" so existe no ramo nao-aprovado', () => {
  const card = MOTORISTA.slice(MOTORISTA.indexOf('(session || pending) ?'));
  const ramoAprovado = card.slice(0, card.indexOf(') : ('));
  assert.ok(
    !/docSend/.test(ramoAprovado),
    'o ramo de approved nao pode oferecer o botao que rebaixa o motorista',
  );
});

// -------------------------------------------------------------------- i18n

test('as chaves novas existem nos tres idiomas', () => {
  for (const chave of ['goToLogin', 'docApprovedNote']) {
    for (const idioma of ['pt', 'en', 'es']) {
      assert.match(
        trechoI18n(idioma),
        new RegExp(`\\b${chave}:`),
        `${chave} precisa existir em ${idioma}`,
      );
    }
  }
});

test('o texto do PIN ja definido nao promete mais a aba Entrar inexistente', () => {
  for (const idioma of ['pt', 'en', 'es']) {
    const re = trechoI18n(idioma).match(/pinAlreadySet: '([^']*)'/);
    assert.ok(re, `${idioma} precisa ter pinAlreadySet`);
    assert.ok(
      !/aba Entrar|Log in tab|pestaña Entrar/.test(re[1]),
      `${idioma}: o texto nao pode prometer a aba Entrar que nao renderiza`,
    );
  }
});

test('o texto do PIN ja definido aponta para o botao de escape', () => {
  const pt = trechoI18n('pt').match(/pinAlreadySet: '([^']*)'/)[1];
  assert.match(pt, /Já tenho cadastro/, 'o texto precisa indicar o botao de escape');
});