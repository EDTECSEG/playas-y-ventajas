// Geracao de QR Code com logo no centro, em um lugar so.
//
// Antes cada tela tinha sua propria copia de loadQrCode() e chamava
// `new QRCode(...)` direto. Isso significava tres QRs que precisavam de logo
// e nao tinham: o cupom resgatado, o cupom aberto e o cartaz do afiliado. A
// solucao e esta funcao ser o unico caminho de geracao de QR do projeto, para
// que "todo QR tem logo" seja verdade por construcao e nao por lembranca.
//
// Tres decisoes que vem da geometria real dos arquivos em public/, medidas
// pixel a pixel (ver o comentario do bloco de layout abaixo):
//
//   1. O logo NAO e sobreposto cru. public/logo.png e public/icon-512.png tem
//      fundo quase branco (RGB 252/253) e o desenho ocupa 92% do quadro. Se o
//      arquivo fosse jogado no centro, apareceria um quadrado palido de 92% do
//      QR inteiro por cima dos modulos. public/icon-512-maskable.png e pior: um
//      bloco verde solido. Por isso o logo entra DENTRO de um "chip" branco
//      menor, e o fundo quase branco do arquivo some dentro do branco do chip.
//
//   2. O chip e 11,5% do lado, e esse numero saiu de medico, nao de gosto.
//      A medicao nao conta codewords: ela monta a matriz de verdade com o
//      qrcodejs 1.0.0, aplica o chip por cima exatamente como o CSS faz,
//      rasteriza e tenta DECODIFICAR com um leitor de verdade (jsQR). A
//      pergunta que importa nao e "quantos codewords quebra", e "o leitor ainda
//      le". Textos de producao: o link de indicacao e `PYV1|{publicId}|{rawToken}`
//      com o token variando de tamanho, o que muda a versao do QR.
//
//        chip    41x41    49x49    53x53    65x65    73x73    primeira falha
//         10%    le       le       le       le       le      ~29%
//       11,5%    le       le       le       le       le      ~29%
//
//      Le em 100% das leituras (5 resolucoes de 3 a 12 px por modulo, com e
//      sem zona de silencio) em todas as matrizes, e so quebra perto de 29%.
//      Entao o limite NAO e o QR, e a legibilidade do logo: abaixo de ~4
//      modulos o desenho vira um ponto colorido, que e pior do que nao ter
//      logo. 11,5% mantem o logo grande em tela e no cartaz impresso de 46mm
//      -- onde ele dava ~5,3mm -- sem gastar area de QR que o leitor precisaria.
//
//      No papel o mesmo chip da ~22px na tela e ~5,3mm no cartaz de 46mm.
//
//   3. O chip e dimensionado em %, nao em px. O QR do cartaz do afiliado e
//      impresso em 46mm e o mesmo componente aparece em 200px na tela; em % os
//      dois casos saem com a mesma proporcao. E o chip nao depende de CSS
//      externo: as posicoes sao inline, porque o container do QR no cartaz vem
//      de uma classe que so existe dentro de @media print.

const SCRIPT_SRC = 'https://unpkg.com/qrcodejs@1.0.0/qrcode.min.js';

// Fallback do logo. Um QR de cupom sem logo cadastrado ainda precisa dizer de
// quem ele e, e um QR de indicacao e do sistema, nao da empresa.
export const QR_SYSTEM_LOGO = '/logo.png';

// Proporcao do lado do chip em relacao ao QR. Medida por leitura real, ver
// ponto 2 acima: 11,5% le em todos os payloads e resolucoes testados e so
// quebra perto de 29%. Os testes de guarda falham se este numero crescer.
const CHIP_RATIO = 0.115;

let scriptPromise = null;

// Uma unica instancia da biblioteca por aba. As duas telas carregavam a
// biblioteca com Copies concorrentes do mesmo codigo, cada uma injetando um
// <script> no body: a segunda chamada resolvia antes da primeira e o
// download ia duas vezes.
export function loadQrCode() {
  if (typeof window === 'undefined') return Promise.reject(new Error('QR code so existe no navegador'));
  if (window.QRCode) return Promise.resolve(window.QRCode);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.onload = () => resolve(window.QRCode);
      // Sem onerror a promessa nunca resolve nem rejeita: a tela ficava em
      // "gerando" para sempre quando a CDN estava fora do ar. O cartaz do
      // afiliado sofria exatamente desse vazamento.
      script.onerror = () => {
        scriptPromise = null;
        reject(new Error('falha de rede ao carregar a biblioteca de QR code'));
      };
      document.body.appendChild(script);
    });
  }
  return scriptPromise;
}

function buildChip(container) {
  const chip = document.createElement('span');
  chip.setAttribute('data-qr-logo', '1');
  const s = chip.style;
  s.position = 'absolute';
  s.left = '50%';
  s.top = '50%';
  s.transform = 'translate(-50%, -50%)';
  s.width = `${CHIP_RATIO * 100}%`;
  s.height = `${CHIP_RATIO * 100}%`;
  s.display = 'flex';
  s.alignItems = 'center';
  s.justifyContent = 'center';
  s.background = '#ffffff';
  // Cantos arredondados, mais fechados que um circulo: o chip acompanha a
  // forma do logo em vez de virar um quadrado duro no meio do QR.
  s.borderRadius = '25%';
  s.boxSizing = 'border-box';
  // Sem borda. Com o chip em ~5 modulos, 1px de filete comeria 10% da caixa de
  // conteudo -- um custo estetico pago em cima do tamanho util do logo, que e
  // justamente o que foi maksimalizado. O branco do chip ja separa o logo dos
  // modulos escuros em volta, e sem filete o dano medido bate exatamente com a
  // area do chip da medicao.
  s.border = 'none';
  // O chip nunca e alvo de clique: ele fica sobre o QR e roubaria o toque.
  s.pointerEvents = 'none';
  container.appendChild(chip);
  return chip;
}

function showLogo(chip, src) {
  let img = chip.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    img.alt = '';
    const s = img.style;
    s.width = '100%';
    s.height = '100%';
    // contain preserva a proporcao: logo de empresa e conteudo enviado pelo
    // lojista e pode ser retangular. Com "fill" um logo largo viraria um
    // quadrado esticado.
    s.objectFit = 'contain';
    s.display = 'block';
    chip.appendChild(img);
  }
  const target = src || QR_SYSTEM_LOGO;
  if (img.getAttribute('src') === target) return;
  img.onerror = () => {
    // URL cadastrada quebrada (empresa apagou o arquivo do storage) nao pode
    // deixar o centro do QR vazio. Cai no logo do sistema, e se ate esse
    // falhar nao entra em laco: o onerror e desarmado na segunda tentativa.
    img.onerror = null;
    if (target !== QR_SYSTEM_LOGO) img.setAttribute('src', QR_SYSTEM_LOGO);
  };
  img.setAttribute('src', target);
}

// Gera o QR em `container` e coloca o logo no centro.
//
//   text     conteudo codificado no QR
//   size     lado em px do canvas gerado
//   logoUrl  logo da empresa; null/vazio usa o logo do sistema
export async function renderQrWithLogo(container, { text, size, logoUrl } = {}) {
  if (!container) throw new Error('container do QR code nao encontrado');
  if (!text) throw new Error('texto do QR code vazio');

  const QRCode = await loadQrCode();
  // O chip e posicionado de forma absoluta em relacao ao container. Sem isto o
  // navegador subiria ate um ancestral posicionado qualquer e o logo apareceria
  // no meio da pagina em vez do meio do QR. Feito aqui porque o container do
  // cartaz (classe .pyv-sheet-qr) so existe dentro de @media print.
  if (!container.style.position) container.style.position = 'relative';
  const prev = container.getAttribute('data-qr-size');
  // So redesenha quando o conteudo ou o lado mudam. Redesenhar a cada
  // renderitzacao recria o canvas e faz a imagem piscar.
  if (prev !== `${text}|${size}|${logoUrl || ''}`) {
    container.innerHTML = '';
    container.setAttribute('data-qr-size', `${text}|${size}|${logoUrl || ''}`);
    new QRCode(container, {
      text,
      width: size,
      height: size,
      // Sem isto o qrcodejs usa o nivel M padrao e o chip de 22% come parte
      // dos modulos de correcao: o leitor passa a falhar em tela suja.
      correctLevel: QRCode.CorrectLevel.H,
    });
    showLogo(buildChip(container), logoUrl);
  } else {
    const chip = container.querySelector('[data-qr-logo]');
    if (chip) showLogo(chip, logoUrl);
  }
  return container;
}
