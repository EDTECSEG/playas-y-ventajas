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
      // Qualquer seletor de atributo, e nao so [data-qr-logo]: o quadro que
      // abraça o QR (data-qr-frame) tambem precisa ser endereçável nos testes.
      const wantAttr = sel.startsWith('[') ? sel.slice(1, -1) : null;
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

// O chip e dimensionado em %, e % resolve contra o bloco que o contem. O
// container do QR nunca tem o tamanho do QR -- na tela e um div de largura
// cheia, na folha e a caixa de 46mm, e a <img> do qrcodejs sempre tem 200px
// naturais. Medido no browser em 2026-10-01, com o codigo antes da correcao:
// o chip saia com 41,4% do QR na tela e 10,0% na folha, esta ultima com
// 13,1px fora do centro. O 11,5% nao aparecia em nenhum dos dois lugares.
//
// estes testes nao medem pixels -- travam a ESTRUTURA que faz o % valer: o
// chip tem de estar dentro de um quadro que abraça a imagem, e nao solto no
// container.
// O chip passou a morar dentro do quadro, entao contar por filhos diretos do
// container passa a dar 0 e nao "duplicado". A contagem precisa ser funda.
function deepCount(el, attr) {
  let n = 0;
  for (const c of el.children) {
    if (attr in c.attrs) n++;
    n += deepCount(c, attr);
  }
  return n;
}

test('o QR fica dentro de um quadro que o abraca, e e o quadro que recebe o chip', async () => {
  const c = makeEl('div');
  await helper.renderQrWithLogo(c, { text: 'https://exemplo.test/?ref=X', size: 200, logoUrl: null });

  const quadro = c.querySelector('[data-qr-frame]');
  assert.ok(quadro, 'o QR precisa ficar dentro de um quadro');
  assert.equal(quadro.style.position, 'relative', 'o quadro e o contexto do chip');
  assert.equal(quadro.style.display, 'inline-block', 'tem que encolher para a imagem');
  // line-height:0 tira o descascamento de inline-block que desalinha o chip.
  assert.equal(quadro.style.lineHeight, '0');

  const chip = c.querySelector('[data-qr-logo]');
  assert.ok(chip, 'o chip nao foi criado');
  assert.ok(
    quadro.children.includes(chip),
    'o chip tem de estar DENTRO do quadro: solto no container o % mede o container, nao o QR'
  );
});

test('o quadro abraça a imagem do QR, e nao a contorna', async () => {
  const c = makeEl('div');
  await helper.renderQrWithLogo(c, { text: 'https://exemplo.test/?ref=X', size: 200, logoUrl: null });
  const quadro = c.querySelector('[data-qr-frame]');
  const img = quadro.querySelector('img');
  assert.ok(img, 'a imagem do QR tem que estar dentro do quadro');
  // Fora do quadro a % volta a medir o container, que e o bug original.
  assert.ok(!c.children.includes(img), 'a imagem nao pode ficar solta no container');
  // O quadro e criado uma vez por QR: dois quadros sobrepostos desalinhariam
  // tudo de novo, e com o chip dentro do segundo o primeiro sumiria vazio.
  assert.equal(deepCount(c, 'data-qr-frame'), 1, 'nao pode haver quadro duplicado');
  assert.equal(deepCount(c, 'data-qr-logo'), 1, 'nao pode haver chip duplicado');
});

test('o redesenhe nao empilha quadros nem chips', async () => {
  const c = makeEl('div');
  await helper.renderQrWithLogo(c, { text: 'https://exemplo.test/?ref=X', size: 200, logoUrl: null });
  await helper.renderQrWithLogo(c, { text: 'https://exemplo.test/?ref=X', size: 200, logoUrl: null });
  assert.equal(deepCount(c, 'data-qr-frame'), 1);
  assert.equal(deepCount(c, 'data-qr-logo'), 1);
});

test('a folha impressa preenche a caixa de 46mm, senao o QR transborda', () => {
  const pagina = fs.readFileSync(path.join(root, 'app', 'afiliado', 'page.jsx'), 'utf8');
  // A <img> do qrcodejs sai sem width/height e com 200px naturais, o que da
  // 52,9mm dentro de uma caixa de 46mm. Medido: transbordo de 6,9mm.
  assert.match(pagina, /\.pyv-sheet-qr \[data-qr-frame\] \{ width: 46mm; height: 46mm; \}/);
  assert.match(pagina, /\.pyv-sheet-qr \[data-qr-frame\] img \{ width: 100%; height: 100%; display: block; \}/);
});

test('o helper documenta que o % e do QR, nao do container', () => {
  // O comentario antigo afirmava que o % daria a mesma proporcao na tela e na
  // folha, sem mentionar contra o que o % resolvia. Era a suposicao que nao se
  // confirmou, e ela estava no codigo como justificativa -- dai a trava.
  assert.ok(
    !/em % os\s*\r?\n?\s*dois casos saem com a mesma proporcao/.test(src),
    'o comentário original, que omitia contra o que o % resolvia, nao pode voltar'
  );
  assert.match(src, /% resolve contra o bloco que o contem/);
  assert.match(src, /contra o QR, e nao contra o container/);
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
  assert.equal(chip.style.width, '11.5%', 'o chip tem que ser 11,5% do lado, em %');
  assert.equal(chip.style.height, '11.5%');
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
  assert.equal(chip.style.width, '11.5%');
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
  assert.equal(deepCount(c, 'data-qr-logo'), 1, 'o redesenhe deixou mais de um chip no QR');
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
