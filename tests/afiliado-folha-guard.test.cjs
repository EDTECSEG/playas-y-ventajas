'use strict';

// /afiliado: guarda da folha de divulgacao em papel.
//
// Pedido do dono (setembro/2026): o afiliado precisa de um cartaz para
// entregar a quem encontra na rua, nao so de link na tela. O PDF sai pelo
// proprio navegador (Imprimir > Salvar em PDF), sem passar por servidor: nao
// ha pagina, template ou fonta carregando.
//
// Nao da para renderizar JSX neste runner, entao o padrao e travar o
// codigo-fonte, como em cliente-coupon-contact-guard.test.cjs.
//
// Os tres erros que estas guardas evitam:
//   1. a folha some no papel: se o CSS de impressao nao esconder a tela, o
//      afiliado imprime o painel inteiro junto do cartaz.
//   2. a folha aparece na tela: sem `display: none` no estado normal, o
//      cartaz fica duplicado embaixo do formulario.
//   3. QR desatualizado: o QR precisa ser desenhado no ponto da folha, e nao
//      reaproveitado do canvas da tela, que e pequeno demais para quem recebe
//      o papel.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'app', 'afiliado', 'page.jsx');
const src = readFileSync(PAGE, 'utf8');

// So o conteudo do bloco de estilo, sem as tags: assim o teste de chevron
// nao casa com a propria tag de abertura.
const ESTILO = src.slice(src.indexOf('<style>') + '<style>'.length, src.indexOf('</style>'));

test('a folha fica escondida na tela e e a unica coisa que sai na impressora', () => {
  assert.match(ESTILO, /\.pyv-sheet\s*\{\s*display:\s*none/, 'a folha precisa sumir na tela');
  assert.match(
    ESTILO,
    /@media print[\s\S]*\.pyv-screen\s*\{\s*display:\s*none\s*!important/,
    'a tela inteira precisa sair na impressao, senao o painel vai junto do cartaz'
  );
  assert.match(ESTILO, /@media print[\s\S]*\.pyv-sheet\s*\{[\s\S]*display:\s*block\s*!important/);
});

test('o CSS de impressao e de verdade, nao so display', () => {
  // display:block sozinho imprimiria a folha com a cor de fundo da tela e sem
  // as cores da marca; sem -webkit-print-color-adjust o Chrome descarta o
  // fundo do box e o cartaz sai sem a moldura verde.
  assert.match(ESTILO, /print-color-adjust:\s*exact/);
  assert.match(ESTILO, /@page[\s\S]*size:\s*A4 portrait/);
  // Uma folha A4 com quebra no meio do cartaz fica inutil.
  assert.match(ESTILO, /page-break-inside:\s*avoid/);
});

test('o reset de impressao vence o estilo inline da folha', () => {
  // padding e max-width da folha sao inline, e inline ganha de regra de
  // classe. Sem !important o papel sai com a margem da tela e o cartaz fica
  // desalinhado dentro da caixa.
  assert.match(ESTILO, /@media print[\s\S]*\.pyv-sheet\s*\{[\s\S]*padding:\s*0\s*!important/);
  // O color-adjust precisa valer para a folha tambem, nao so para os filhos:
  // e o fundo branco dela que some sem isso.
  assert.match(ESTILO, /\.pyv-sheet,\s*\.pyv-sheet \*/);
});

test('o cartaz e montado dentro de .pyv-sheet, fora do wrapper de tela', () => {
  const tela = src.indexOf('className="pyv-screen"');
  const folha = src.indexOf('className="pyv-sheet"');
  assert.ok(tela !== -1, 'faltou o wrapper .pyv-screen');
  assert.ok(folha !== -1, 'faltou a folha .pyv-sheet');
  assert.ok(folha > tela, 'a folha precisa vir depois do wrapper de tela');
  // A folha so existe para quem ja tem cadastro: antes disso nao ha link nem
  // codigo para imprimir.
  assert.match(src, /\{affiliate && \(\s*<div className="pyv-sheet"/);
});

test('nada fora da folha entra no papel', () => {
  // O InstallPrompt vem do layout, antes do main e fora do .pyv-screen: sem
  // esta regra a faixa amarela de instalar o app sai impressa no topo do
  // cartaz. Esconder por classe, e nao por seletor de filho.
  assert.match(ESTILO, /@media print[\s\S]*\.app-install-prompt\s*\{\s*display:\s*none\s*!important/);
  assert.match(ESTILO, /@media print[\s\S]*\.pyv-screen\s*\{\s*display:\s*none\s*!important/);

  // A classe precisa existir no componente que o layout renderiza.
  const PROMPT = readFileSync(path.join(__dirname, '..', 'app', 'components', 'InstallPrompt.jsx'), 'utf8');
  assert.match(PROMPT, /className="app-install-prompt"/, 'o InstallPrompt precisa da classe que a folha esconde');
});

test('o main para de valer a altura da tela na impressao', () => {
  // main tem min-height:100vh para cobrir a tela. Na impressao 100vh e a altura
  // da folha: o main ocuparia uma pagina inteira e, com a margem do @page,
  // empurraria uma segunda folha em branco para tras do cartaz.
  assert.match(src, /<main style=\{\{ background: theme\.bg, minHeight: '100vh' \}\}>/);
  assert.match(ESTILO, /@media print[\s\S]*main\s*\{[\s\S]*min-height:\s*0\s*!important/);
});

test('nenhum texto com chevron de tag dentro do bloco de estilo', () => {
  // Regressao: escrever uma tag com chevron num comentario de CSS fazia o
  // servidor escapar para &lt; e o cliente nao, o React acusava hydration
  // mismatch e jogava o HTML inteiro fora.
  assert.ok(!ESTILO.includes('&lt;'), 'nao deve haver escape de HTML dentro do CSS');
  assert.ok(!/<style|<\/style/.test(ESTILO), 'nao escrever tags com chevron dentro do CSS: quebra o hydration');
  // O mesmo vale para o chevron de combinador: no HTML exportado ele vira
  // &gt;, que o texto de um bloco de estilo nao decodifica, e o seletor
  // chegaria invalido. Por isso a folha nao usa seletor de filho.
  assert.ok(!/[a-z0-9)\]]\s+>/.test(ESTILO.replace(/&gt;/g, '')), 'evite seletor de combinador filho no CSS da folha');
});

test('o QR e desenhado nos dois pontos, com o da folha em tamanho de leitura', () => {
  assert.match(src, /const qrSheetRef = useRef\(null\)/);
  const efeito = src.slice(src.indexOf('// O mesmo QR e desenhado'), src.indexOf('async function register'));
  assert.match(efeito, /\[qrRef, qrSheetRef\]/, 'os dois pontos precisam receber o QR');
  // O QR da tela e 200px porque a tela e larga; na folha 46mm e o que faz o
  // cartaz funcionar a um metro de distancia.
  assert.match(ESTILO, /\.pyv-sheet-qr\s*\{\s*width:\s*46mm;\s*height:\s*46mm;\s*\}/);
  assert.match(src, /className="pyv-sheet-qr"/);
});

test('o cartaz carrega o que o afiliado precisa para a pessoa agir', () => {
  const folha = src.slice(src.indexOf('className="pyv-sheet"'));
  assert.match(folha, /\{shareUrl\}/, 'o link tem que estar escrito, nao so no QR: nem todo mundo tem camera');
  assert.match(folha, /\{affiliate\.referralCode\}/, 'o codigo e o caminho para quem nao consegue ler o link');
  assert.match(folha, /\{affiliate\.phone\}/, 'o telefone de quem indicou, para a pessoa confiar em quem entregou');
  assert.match(folha, /\{affiliate\.name\}/);
  // Como usar, em tres passos: e o que o cartaz precisa explicar.
  for (const passo of ['se cadastra', 'pega um cupom', 'validado']) {
    assert.ok(folha.includes(passo), `falta o passo "${passo}" na instrucao de uso`);
  }
});

test('o botao de imprimir chama a impressora do navegador', () => {
  assert.match(src, /onClick=\{\(\)\s*=>\s*\{[\s\S]*window\.print\(\)[\s\S]*\}\}/);
  // O texto precisa avisar que PDF sai do navegador, senao o afiliado acha
  // que o botao esta quebrado quando abre o dialogo do sistema.
  assert.match(src, /Salvar em PDF/);
});
