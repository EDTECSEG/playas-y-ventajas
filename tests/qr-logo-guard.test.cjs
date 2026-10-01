'use strict';

// Todo QR Code do projeto com logo no centro.
//
// A exigencia e "todo QR que for gerado tenha a imagem do logo de quem o
// gerou, e QR de cadastro use o logo do sistema". O risco real nao e fazer o
// overlay: e alguem criar um QR novo amanha com `new QRCode(...)` e ele
// nascer sem logo, sem ninguem perceber. Por isso a guarda central e a
// inventory: fora de lib/qr-logo.js nao pode existir nenhum outro gerador.
//
// Nao da para renderizar JSX nem DOM neste runner, entao o padrao e travar o
// codigo-fonte, como em afiliado-extrato-guard.test.cjs e
// afiliado-folha-guard.test.cjs.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const helper = readFileSync(path.join(root, 'lib', 'qr-logo.js'), 'utf8');
const cliente = readFileSync(path.join(root, 'app', 'cliente', 'page.jsx'), 'utf8');
const afiliado = readFileSync(path.join(root, 'app', 'afiliado', 'page.jsx'), 'utf8');

// Raiz da varredura: codigo-fonte de verdade. Nao usar `root` recursivo porque
// .next/, out/ e .netlify/ guardam copias COMPILADAS do codigo antigo, e um QR
// sem logo ja gravado la dentro deixaria a guarda vermelha para sempre sem
// corresponder ao que esta no fonte.
const SCAN_ROOTS = ['app', 'lib', 'components', 'netlify'];

// Artefatos de build e dependencias nunca entram na conta.
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'out', '.netlify', '.wrangler', 'coverage', 'dist', 'build', '.staging-bk17']);

function sourceFiles(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      sourceFiles(full, out);
    } else if (/\.(jsx|js|mjs)$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function scannedFiles() {
  const out = [];
  for (const r of SCAN_ROOTS) sourceFiles(path.join(root, r), out);
  return out;
}

test('lib/qr-logo.js exporta o helper e o logo do sistema', () => {
  assert.match(helper, /export const QR_SYSTEM_LOGO = '\/logo\.png'/);
  assert.match(helper, /export async function renderQrWithLogo/);
});

test('o QR usa correcao de erro maxima', () => {
  // O qrcodejs usa nivel M por padrao. O chip branco cobre ~1,4% da area, o que
  // sobra folga ate com H (~30% de recuperacao) -- mas a H e a unica que segura
  // o QR com logo em camera de celular com brilho, sombra e papel sujo.
  assert.match(helper, /correctLevel: QRCode\.CorrectLevel\.H/);
});

test('o chip e dimensionado em %, nao em px', () => {
  // O mesmo componente aparece a 200px na tela e a 46mm no cartaz impresso do
  // afiliado. Em px o chip sairia enorme no papel (46mm ~ 174px) e as medidas
  // em mm quebrariam a proporcao na impressora.
  assert.match(helper, /s\.width = `\$\{CHIP_RATIO \* 100\}%`/);
  assert.match(helper, /s\.height = `\$\{CHIP_RATIO \* 100\}%`/);
});

test('o chip fica no menor tamanho que ainda se le: 10% (5x5 modulos)', () => {
  // A medicao na matriz real (qrcodejs 1.0.0, textos de producao) mostrou que
  // a correcao de erro nunca foi o gargalo: a 22% ainda havia 11x de folga, e
  // as regioes criticas ficam de pe em qualquer tamanho testado. O limite real
  // e a legibilidade do logo -- abaixo de ~5 modulos ele vira um ponto. Este
  // teste trava esse piso E trava o teto: se alguem inflar o chip de novo, a
  // guarda falha, porque area de QR gasta a toa nao compra leitura nenhuma.
  assert.match(helper, /const CHIP_RATIO = 0\.10/);
  const ratio = Number(/const CHIP_RATIO = ([\d.]+)/.exec(helper)[1]);
  assert.ok(ratio <= 0.10, `chip ${ratio} maior que o maximo de 0.10: gasta area de QR a toa`);
  assert.ok(ratio >= 0.06, `chip ${ratio} pequeno demais: o logo deixa de se ler`);
  // 10% de 45 (indicacao/cupom tipico) e de 53 (cupom longo) arredonda para 5.
  assert.equal(Math.round(0.10 * 45), 5, '5 modulos na matriz 45x45');
  assert.equal(Math.round(0.10 * 53), 5, '5 modulos na matriz 53x53');
});

test('o chip nao gasta area de QR com borda', () => {
  // Com o chip em 5 modulos, 1px de filete comeria 10% da caixa de conteudo do
  // logo -- custo estetico pago em cima do tamanho util, que e o que foi
  // minimalizado. E o branco do chip ja separa o logo dos modulos escuros.
  assert.match(helper, /s\.border = 'none'/);
  assert.doesNotMatch(helper, /s\.border = '1px/);
});

test('o container do QR vira contexto de posicionamento', () => {
  // O chip e absolute. Sem position:relative no container ele sobe ate o
  // ancestral posicionado mais proximo e o logo aparece no meio da pagina.
  // Precisa estar no helper porque o container do cartaz so existe em
  // @media print.
  assert.match(helper, /container\.style\.position = 'relative'/);
});

test('logo de empresa entra com contain, sem esticar', () => {
  // O logo vem do cadastro do lojista e pode ser retangular. Com fill um logo
  // largo viraria um quadrado deformado.
  assert.match(helper, /s\.objectFit = 'contain'/);
});

test('sem logo cadastrado, e sem logo carregando, o centro cai no logo do sistema', () => {
  assert.match(helper, /const target = src \|\| QR_SYSTEM_LOGO/);
  // E o onerror precisa trocar pelo logo do sistema: URL cadastrada quebrada
  // (loja apagou o arquivo do storage) nao pode deixar o centro vazio.
  assert.match(helper, /img\.onerror = \(\) => \{/);
  assert.match(helper, /if \(target !== QR_SYSTEM_LOGO\) img\.setAttribute\('src', QR_SYSTEM_LOGO\)/);
  // Desarmar o onerror antes de trocar impede laco infinito quando o proprio
  // /logo.png falha.
  assert.match(helper, /img\.onerror = null;/);
});

test('loadQrCode rejeita em vez de ficar pendurada para sempre', () => {
  // Regressao do cartaz do afiliado: o loader local nao tinha onerror, entao
  // CDN fora do ar deixava a promessa pendurada e o QR nunca aparecia, sem
  // mensagem de erro.
  assert.match(helper, /script\.onerror = \(\) => \{/);
  assert.match(helper, /reject\(new Error\('falha de rede ao carregar a biblioteca de QR code'\)\)/);
  // E a biblioteca e carregada uma vez por aba, nao uma por tela.
  assert.match(helper, /if \(!scriptPromise\)/);
});

test('nenhum QR e gerado fora do helper: todo QR tem logo por construcao', () => {
  // A varredura tem que enxergar as telas de verdade, senao a guarda passa por
  // vacuidade e ninguum descobre ate um QR sem logo aparecer em producao.
  const files = scannedFiles();
  const rels = files.map((f) => path.relative(root, f).replace(/\\/g, '/'));
  assert.ok(rels.includes('app/cliente/page.jsx'), 'a varredura nao alcancou app/cliente/page.jsx');
  assert.ok(rels.includes('app/afiliado/page.jsx'), 'a varredura nao alcancou app/afiliado/page.jsx');
  assert.ok(files.length > 20, 'varredura curta demais para ser crivel: ' + files.length);

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (rel === 'lib/qr-logo.js') continue;
    const src = readFileSync(file, 'utf8');
    if (/new QRCode\s*\(/.test(src) || /qrcodejs@/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'QR gerado sem passar por renderQrWithLogo: ' + offenders.join(', '));
});

test('os 2 QRs de cupom do /cliente usam o logo da empresa', () => {
  const calls = cliente.match(/renderQrWithLogo\(/g) || [];
  assert.equal(calls.length, 2, 'o /cliente tem 2 QRs: o resgatado e o cupom aberto');
  // O do cupom resgatado.
  assert.match(cliente, /renderQrWithLogo\(qrDivRef\.current, \{[\s\S]{0,240}logoUrl: justClaimed\.logoUrl/);
  // O do cupom aberto, que pode ter o logo trazido pela API depois.
  assert.match(cliente, /renderQrWithLogo\(myCouponQrDivRef\.current, \{[\s\S]{0,240}logoUrl: openCoupon\.logoUrl/);
});

test('o QR do cupom e refeito quando o logo da empresa chega', () => {
  // Dependencia que o codigo original nao tinha: o logo do cupom aberto chega
  // depois, por /offers?businessLogoFor=, e o do resgatado vem do proprio
  // resgate. Sem o logoUrl na dependencia, o QR nasce com o logo do sistema e
  // nunca troca, mesmo com a empresa cadastrada.
  assert.match(cliente, /\}, \[justClaimed, justClaimed\?\.logoUrl\]\)/);
  assert.match(cliente, /\}, \[openCoupon, openCoupon\?\.logoUrl\]\)/);
});

test('os 2 QRs de cadastro/indicacao do /afiliado usam o logo do sistema', () => {
  // Tela e folha impressa. O QR de indicacao e do PYV, nao do lojista: quem
  // recebe o papel tem de ver o logo do sistema.
  assert.match(afiliado, /for \(const ref of \[qrRef, qrSheetRef\]\)/);
  assert.match(afiliado, /logoUrl: QR_SYSTEM_LOGO/);
});

test('o chip nao rouba o toque sobre o QR', () => {
  assert.match(helper, /s\.pointerEvents = 'none'/);
});
