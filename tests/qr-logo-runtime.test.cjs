'use strict';

// lib/qr-logo.js em execucao, nao em texto.
//
// A guarda estatica (qr-logo-guard.test.cjs) trava o codigo-fonte: ela prova
// que existe correctLevel H, que o chip e 10% e que as telas passam pelo
// helper. Ela NAO prova o que acontece em tempo de execucao, e o comportamento
// que mais quebra e justamente o de tempo de execucao:
//
//   - logo cadastrado com URL quebrada: o centro do QR pode ficar vazio
//   - /logo.png falhando tambem: pode entrar em laco de onerror
//   - logo da empresa chegando DEPOIS: o centro precisa acompanhar
//   - redesenho: pode deixar dois chips sobrepostos no mesmo QR
//   - CDN fora do ar: a promessa pode ficar pendurada e a tela travada
//
// Por isso um DOM minimo aqui. Nao e mock do QR Code: e o bastante para o
// helper montar e_ADDRESSAR elementos de verdade.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'lib', 'qr-logo.js'), 'utf8');

// O helper e ESM (o Next compila). Node trata .js como CJS neste projeto, sem
// "type": "module", entao a copia temporaria precisa da extensao .mjs para o
// import() abaixo aceitar.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyv-qr-'));
const modFile = path.join(tmpDir, 'qr-logo.mjs');
const modUrl = 'file:///' + modFile.replace(/\\/g, '/');
fs.writeFileSync(modFile, src, 'utf8');

function makeEl(tag) {
  const el = {
    tag,
    children: [],
    attrs: {},
    style: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    // O helper limpa o container com innerHTML = '' antes de redesenhar. Um
    // stub que ignora isso deixaria o chip velho vivo e o redesenhe criaria um
    // SEGUNDO chip sobre o primeiro -- o bug que estes stubs precisam pegar.
    get innerHTML() { return ''; },
    set innerHTML(v) {
      if (v === '') this.children.length = 0;
      else throw new Error('stub so sabe innerHTML = ""');
    },
    querySelector(sel) {
      const wantTag = sel === 'img' ? 'img' : null;
      const wantAttr = sel === '[data-qr-logo]' ? 'data-qr-logo' : null;
      for (const c of this.children) {
        if (wantTag && c.tag === wantTag) return c;
        if (wantAttr && wantAttr in c.attrs) return c;
        const deep = c.querySelector ? c.querySelector(sel) : null;
        if (deep) return deep;
      }
      return null;
    },
    countAttr(name) { return this.children.filter((c) => name in c.attrs).length; },
  };
  return el;
}

class FakeQRCode {
  constructor(el, opts) {
    this.opts = opts;
    el.appendChild(makeEl('canvas'));
    FakeQRCode.calls.push(opts);
  }
}
FakeQRCode.calls = [];
FakeQRCode.CorrectLevel = { L: 1, M: 0, Q: 3, H: 2 };

let helper;
let body;

before(async () => {
  body = makeEl('body');
  globalThis.document = { body, createElement: (tag) => makeEl(tag) };
  globalThis.window = { QRCode: FakeQRCode };
  helper = await import(modUrl);
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete globalThis.document;
  delete globalThis.window;
});

test('QR de cupom: logo da empresa no centro, correcao de erro maxima', async () => {
  FakeQRCode.calls.length = 0;
  const c = makeEl('div');
  await helper.renderQrWithLogo(c, { text: 'PYV1|abc|tok', size: 200, logoUrl: 'https://loja/logo.png' });

  assert.equal(FakeQRCode.calls.length, 1, 'o QR nao foi gerado');
  assert.equal(FakeQRCode.calls[0].correctLevel, FakeQRCode.CorrectLevel.H, 'correctLevel tem que ser H');
  assert.equal(FakeQRCode.calls[0].width, 200);
  assert.equal(c.style.position, 'relative', 'o container precisa virar contexto de posicionamento do chip');

  const chip = c.querySelector('[data-qr-logo]');
  assert.ok(chip, 'o chip do logo nao foi criado no centro');
  assert.equal(chip.style.width, '10%', 'o chip tem que ser 10% do lado, em %');
  assert.equal(chip.style.height, '10%');
  assert.equal(chip.style.background, '#ffffff', 'o chip precisa ser branco para cobrir os modulos');
  assert.equal(chip.style.border, 'none', 'o chip nao pode gastar area de QR com filete');
  assert.equal(chip.style.pointerEvents, 'none', 'o chip nao pode roubar o toque do QR');
  assert.equal(chip.style.transform, 'translate(-50%, -50%)', 'o chip tem que ficar no centro');

  const img = chip.querySelector('img');
  assert.ok(img, 'o logo nao foi inserido no chip');
  assert.equal(img.getAttribute('src'), 'https://loja/logo.png', 'deveria usar o logo da empresa');
  assert.equal(img.style.objectFit, 'contain', 'logo de lojista retangular seria distorcido com fill');
});

test('logo cadastrado quebrado cai no logo do sistema, e nao ha laco', async () => {
  const c = makeEl('div');
  await helper.renderQrWithLogo(c, { text: 'PYV1|abc|tok', size: 200, logoUrl: 'https://loja/quebrado.png' });
  const img = c.querySelector('[data-qr-logo]').querySelector('img');

  img.onerror();
  assert.equal(img.getAttribute('src'), helper.QR_SYSTEM_LOGO, 'URL quebrada deveria cair no logo do sistema');
  assert.equal(img.onerror, null, 'o onerror precisa ser desarmado, senao o proprio /logo.png entra em laco');

  // Se o /logo.png tambem falhar, nada pode explodir nem ficar oscilando.
  const antes = img.getAttribute('src');
  img.onerror?.();
  assert.equal(img.getAttribute('src'), antes, 'o src nao pode ficar mudando sozinho');
});

test('empresa sem logo: o centro sai com o logo do sistema', async () => {
  const c = makeEl('div');
  await helper.renderQrWithLogo(c, { text: 'PYV1|def|tok', size: 220, logoUrl: null });
  const chip = c.querySelector('[data-qr-logo]');
  assert.equal(chip.querySelector('img').getAttribute('src'), helper.QR_SYSTEM_LOGO);
  // O chip e em %, entao 220px nao muda a proporcao: e o mesmo objeto que
  // aparece em 46mm no cartaz impresso.
  assert.equal(chip.style.width, '10%');
});

test('QR de cadastro/indicacao usa o logo do sistema', async () => {
  const c = makeEl('div');
  await helper.renderQrWithLogo(c, { text: 'https://pyv/?ref=JOSDASCOUVE-EB29', size: 200, logoUrl: helper.QR_SYSTEM_LOGO });
  assert.equal(c.querySelector('[data-qr-logo]').querySelector('img').getAttribute('src'), helper.QR_SYSTEM_LOGO);
});

test('logo que chega depois: o QR e refeito, o centro acompanha, sem chip duplo', async () => {
  const c = makeEl('div');
  await helper.renderQrWithLogo(c, { text: 'PYV1|def|tok', size: 220, logoUrl: null });
  FakeQRCode.calls.length = 0;

  // E o caminho real do /cliente: o logo do cupom aberto so vem depois, por
  // /offers?businessLogoFor=, num segundo state update.
  await helper.renderQrWithLogo(c, { text: 'PYV1|def|tok', size: 220, logoUrl: 'https://loja/tarde.png' });

  assert.equal(FakeQRCode.calls.length, 1, 'a chegada do logo tem que redesenhar o QR');
  assert.equal(c.querySelector('[data-qr-logo]').querySelector('img').getAttribute('src'), 'https://loja/tarde.png',
    'o centro do QR nao acompanhou o logo que chegou depois');
  assert.equal(c.countAttr('data-qr-logo'), 1, 'o redesenhe deixou mais de um chip no container');
});

test('re-render identico nao recria o canvas', async () => {
  const c = makeEl('div');
  const args = { text: 'PYV1|def|tok', size: 220, logoUrl: 'https://loja/tarde.png' };
  await helper.renderQrWithLogo(c, args);
  FakeQRCode.calls.length = 0;
  await helper.renderQrWithLogo(c, args);
  assert.equal(FakeQRCode.calls.length, 0, 'render identico nao pode recriar o canvas (a imagem piscaria)');
});

test('script da CDN fora do ar rejeita, em vez de deixar a tela pendurada', async () => {
  // Regressao do cartaz do afiliado: o loader local nao tinha onerror, entao a
  // promessa nunca resolvia e o QR nunca aparecia, sem nenhuma mensagem.
  const qrCode = globalThis.window.QRCode;
  delete globalThis.window.QRCode;
  try {
    const promessa = helper.loadQrCode();
    const script = body.children.at(-1);
    assert.ok(script, 'o loader nao injetou o <script>');
    script.onerror();
    await assert.rejects(promessa, /falha de rede/);
  } finally {
    globalThis.window.QRCode = qrCode;
  }
});
