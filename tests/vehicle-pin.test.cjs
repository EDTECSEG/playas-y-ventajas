'use strict';

// Pin de motorista no mapa de /cliente + auto-transmissao no app do motorista.
//
// Contexto do bug: a posicao do motorista ja era gravada (vehicle_positions) e ja
// voltava na listagem de "Veiculos ao vivo", mas NUNCA era desenhada no Leaflet.
// O bloco do mapa so desenhava local do usuario, parceiros do radar e lugares do
// map-places. Ou seja: o dado chegava no estado `shuttle.vehicles` e nenhuma
// linha do mapa o lia. A segunda metade do problema era a janela de 5 min de
// list_live_vehixels contra um envio que so acontecia por botao.
//
// Nao da para renderizar JSX neste runner (sem jsdom, sem testing-library), então
// a parte visual e travada por guardas de codigo-fonte, no mesmo estilo de
// cliente-shuttle-reservation-guard.test.cjs. A parte testavel de verdade fica
// em logica pura (app/cliente/logic.js e app/motorista/logic.js), importada por
// import dinamico.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PAGE = readFileSync(path.join(RAIZ, 'app', 'cliente', 'page.jsx'), 'utf8');
const MOTORISTA = readFileSync(path.join(RAIZ, 'app', 'motorista', 'page.jsx'), 'utf8');

let CL;
let ML;
test.before(async () => {
  CL = await import(pathToFileURL(path.join(RAIZ, 'app', 'cliente', 'logic.js')).href);
  ML = await import(pathToFileURL(path.join(RAIZ, 'app', 'motorista', 'logic.js')).href);
});

// ---------------------------------------------------------------- Logic do pin

const T = {
  vehicleMoving: 'Em movimento',
  vehicleStopped: 'Parado',
  vehicleUpdated: 'atualizado {time}',
  vehicleShuttle: 'no servico',
};

const ROZINHA = {
  driverId: 'd-1',
  driverName: 'Rosiane Michelle',
  lat: -22.88947,
  lng: -42.04689,
  heading: null,
  speedKmh: 32,
  shuttleId: null,
  recordedAt: '2026-10-03T00:57:46.818217+00:00',
  distanceKm: 1.2,
};

test('o nome do motorista entra no marcador e no popup', () => {
  const html = CL.vehicleMarkerHtml(ROZINHA, T);
  assert.ok(html.includes('Rosiane Michelle'), 'o marcador precisa dizer de quem e a posicao');
});

test('o marcador distingue movimento de parada a partir da velocidade', () => {
  assert.ok(CL.vehicleMarkerHtml({ ...ROZINHA, speedKmh: 32 }, T).includes('Em movimento'));
  assert.ok(CL.vehicleMarkerHtml({ ...ROZINHA, speedKmh: 0 }, T).includes('Parado'));
});

test('velocidade ausente NAO vira "parado": nao se sabe', () => {
  // speed_kmh e null quando o navegador nao devolve heading/speed. Chamar isso
  // de "Parado" seria affirmar algo que o banco nao sabe.
  const html = CL.vehicleMarkerHtml({ ...ROZINHA, speedKmh: null }, T);
  assert.ok(!html.includes('Parado'), 'velocidade desconhecida nao pode virar "Parado"');
});

test('XSS: o nome do motorista vai escapado para o divIcon e para o popup', () => {
  // driver_name foi digitado no cadastro, por qualquer pessoa, sem validacao.
  // Entra direto em L.divIcon({html}) e em bindPopup. Sem escapar, quem se
  // cadastra como "<img src=x onerror=...>" executa script na pagina de todos que
  // olham o mapa. Este e o teste que segura a linha.
  const malicioso = {
    ...ROZINHA,
    driverName: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
  };
  for (const html of [CL.vehicleMarkerHtml(malicioso, T), CL.vehiclePopupHtml(malicioso, T, 'agora')]) {
    assert.ok(!html.includes('<script'), 'script cru no HTML do marcador');
    assert.ok(!/<img[^>]*onerror/i.test(html), 'img com onerror no HTML do marcador');
    assert.ok(!html.includes('onerror="'), 'atributo onerror cru');
    assert.ok(html.includes('&lt;img'), 'o nome precisa aparecer escapado, nao cru');
  }
});

test('XSS: o rotulo traduzido tambem e escapado, porque vem do i18n', () => {
  const tMalicioso = { ...T, vehicleMoving: '<b>movendo</b>' };
  const html = CL.vehicleMarkerHtml(ROZINHA, tMalicioso);
  assert.ok(!html.includes('<b>movendo</b>'), 'rotulo do i18n entrou cru');
  assert.ok(html.includes('&lt;b&gt;'), 'rotulo do i18n precisa ser escapado');
});

test('o popup mostra nome, velocidade, distancia e quando foi atualizado', () => {
  const html = CL.vehiclePopupHtml(ROZINHA, T, '3 min');
  assert.ok(html.includes('Rosiane Michelle'));
  assert.ok(html.includes('32 km/h'));
  assert.ok(html.includes('1.2 km'));
  assert.ok(html.includes('3 min'), 'o texto de "atualizado" chega do timeAgo da pagina');
});

test('distancia ausente nao vira "undefined km"', () => {
  const html = CL.vehiclePopupHtml({ ...ROZINHA, distanceKm: null, speedKmh: null }, T, 'agora');
  assert.ok(!/undefined|NaN|null/.test(html), 'campo ausente nao pode vazar para a tela');
});

test('so entra no mapa quem tem coordenada utilizavel', () => {
  const bons = CL.visibleVehicles([
    ROZINHA,
    { ...ROZINHA, driverId: 'd-2' },
    { ...ROZINHA, driverId: 'd-3', lat: null, lng: null },
    { ...ROZINHA, driverId: 'd-4', lat: 'abc', lng: 1 },
    { ...ROZINHA, driverId: 'd-5', lat: 999, lng: 1 },
    { ...ROZINHA, driverId: 'd-6', lng: null },
    null,
  ]);
  assert.deepStrictEqual(bons.map((v) => v.driverId), ['d-1', 'd-2'],
    'so as duas primeiras tem coordenada dentro de -90..90 / -180..180');
});

test('visibleVehicles aguenta estado que nao e lista', () => {
  assert.deepStrictEqual(CL.visibleVehicles(undefined), []);
  assert.deepStrictEqual(CL.visibleVehicles(null), []);
  assert.deepStrictEqual(CL.visibleVehicles({}), []);
});

test('a coordenada continua numerica depois do filtro, para o Leaflet nao receber string', () => {
  const [v] = CL.visibleVehicles([{ ...ROZINHA, lat: '-22.5', lng: '-42.0' }]);
  assert.strictEqual(typeof v.lat, 'number');
  assert.strictEqual(typeof v.lng, 'number');
});

// ------------------------------------------------------- Ligacao no page.jsx

test('a pagina le shuttle.vehicles dentro do mapa, e nao so no card de texto', () => {
  // Este e o teste que trava o bug original. O card de texto sempre leu
  // shuttle.vehicles; o mapa nao. Se alguem remover a camada de veiculos, o
  // cartao continua aparecendo e o bug volta sem nenhum teste falhar.
  assert.ok(
    /visibleVehicles\(shuttle\.vehicles\)/.test(PAGE),
    'o mapa precisa filtrar shuttle.vehicles; hoje ninguem le esse estado dentro do mapa',
  );
});

test('os pins vao para uma camada propria, e nao para o mapa solto', () => {
  // Sem layerGroup, cada render adiciona marcadores duplicados por cima dos
  // anteriores. O mapa e remontado quando o usuario clica em atualizar.
  assert.ok(PAGE.includes('vehicleLayerRef'), 'falta a ref da camada de veiculos');
  assert.ok(/vehicleLayerRef\.current\.clearLayers\(\)/.test(PAGE), 'a camada precisa ser limpa antes de redesenhar');
});

test('o redesenho dos pins acontece por efeito, nao dentro do getCurrentPosition', () => {
  // showMap() roda uma vez por clique. Se o pin for desenhado la dentro, ele
  // nasce atrasado em relacao a fetchShuttle e some em toda atualizacao de mapa.
  assert.ok(
    /useEffect\(\(\) => \{[\s\S]*?drawVehiclePins/.test(PAGE),
    'os pins precisam ser um efeito reagindo a shuttle.vehicles',
  );
});

test('a pagina importa a logica pura do pin em vez de repetir o filtro', () => {
  assert.ok(
    /import \{[^}]*visibleVehicles[^}]*\} from '\.\/logic'/.test(PAGE),
    'app/cliente/page.jsx precisa importar visibleVehicles de ./logic',
  );
});

test('todo L.marker de veiculo passa pelo html ja escapado', () => {
  const blocoVeiculos = PAGE.slice(PAGE.indexOf('function drawVehiclePins'));
  const trecho = blocoVeiculos.slice(0, blocoVeiculos.indexOf('\n  }'));
  assert.ok(/vehicleMarkerHtml\(/.test(trecho), 'o marcador tem que vir de vehicleMarkerHtml (que escapa)');
  assert.ok(/bindPopup\(vehiclePopupHtml\(/.test(trecho), 'o popup tem que vir de vehiclePopupHtml (que escapa)');
});

// ------------------------------------------------------- Auto-transmissao

test('o intervalo de auto-transmissao e de 30s', () => {
  assert.strictEqual(ML.AUTO_POSITION_MS, 30000,
    '30s de headroom sobre a janela de 5 min do list_live_vehicles');
});

test('so envia sozinho quem esta aprovado', () => {
  // canDrive e o mesmo portao do botao manual: 'pending' e 'rejected' entram no
  // app mas nao ficam na frota, e nao aparecem em list_live_vehicles.
  assert.strictEqual(ML.shouldAutoSend({ enabled: true, status: 'approved' }), true);
  for (const status of ['pending', 'rejected', 'suspended', '', null, undefined]) {
    assert.strictEqual(ML.shouldAutoSend({ enabled: true, status }), false,
      `status ${JSON.stringify(status)} nao pode transmitir sozinho`);
  }
});

test('desligado nao transmite, mesmo aprovado', () => {
  assert.strictEqual(ML.shouldAutoSend({ enabled: false, status: 'approved' }), false);
});

test('com a aba em segundo plano a transmissoes para', () => {
  // GPS aceso com a aba fechada consome bateria sem ninguem ver o resultado.
  // `visible` indefinido conta como visivel, para o efeito nao depender de a
  // pagina ter lido document.visibilityState.
  assert.strictEqual(ML.shouldAutoSend({ enabled: true, status: 'approved', visible: false }), false);
  assert.strictEqual(ML.shouldAutoSend({ enabled: true, status: 'approved', visible: true }), true);
  assert.strictEqual(ML.shouldAutoSend({ enabled: true, status: 'approved' }), true);
});

test('o estado inicial da auto-transmissao e desligado', () => {
  // Ligar sozinho no primeiro render comeca a gastar GPS sem o motorista ter
  // pedido nada.
  assert.ok(
    /useState\(false\)/.test(MOTORISTA),
    'o auto-envio precisa comecar desligado',
  );
  assert.ok(
    /AUTO_POSITION_MS/.test(MOTORISTA),
    'a pagina precisa usar o intervalo da logica pura, nao um numero solto',
  );
});

test('o botao de pausa existe e alterna o estado', () => {
  assert.ok(
    /toggleAutoPosition|setAutoOn\(/.test(MOTORISTA),
    'falta o controle que liga e pausa a transmissao automatica',
  );
});

test('o efeito do auto-envio tem limpeza, senao vaza timer a cada montagem', () => {
  const bloco = MOTORISTA.slice(MOTORISTA.indexOf('AUTO_POSITION_MS'));
  assert.ok(/setInterval/.test(bloco), 'a transmissao periodica precisa usar setInterval');
  assert.ok(/clearInterval/.test(bloco), 'sem clearInterval o timer sobrevive a montagem');
});

test('falha do auto-envio nao enche a tela de aviso de erro', () => {
  // O envio automatico repete a cada 30s. Se cada falha setasse erro visivel, o
  // motorista deixaria a tela coberta de aviso vermelho sem poder agir — e o
  // unico motivo real de falhar (permissao de localizacao negada) ja e
  // avisado pelo botao manual.
  assert.ok(
    /autoErrRef/.test(MOTORISTA),
    'o auto-envio precisa de um contador de falhas, e nao de setErro a cada ciclo',
  );
});