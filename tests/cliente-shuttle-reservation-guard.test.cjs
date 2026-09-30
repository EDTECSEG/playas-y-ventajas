'use strict';

// /cliente: guarda do card de reservas de translado.
//
// Nao da para renderizar JSX neste runner (sem jsdom, sem testing-library), entao
// estes testes travam o padrao no codigo-fonte, no mesmo estilo de
// cliente-offers-guard.test.cjs.
//
// A tela ja quebrou inteiro uma vez por causa exatamente deste caminho: o
// handler devolve {error: ...} com 4xx/5xx, a pagina fazia setState(await
// res.json()) sem olhar res.ok, o objeto chegava no state e o .map/.filter do
// render estourava — "Application error: a client-side exception has occurred".
// As guardas abaixo sao o que impede a volta.

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'app', 'cliente', 'page.jsx');
const src = readFileSync(PAGE, 'utf8');

function bloco(inicio, fim) {
  const a = src.indexOf(inicio);
  const b = src.indexOf(fim, a + 1);
  assert.ok(a !== -1, `nao encontrei ${inicio} na pagina`);
  assert.ok(b !== -1, `nao encontrei ${fim} depois de ${inicio}`);
  return src.slice(a, b);
}

const loadReservas = bloco('async function loadReservations', 'function openBooking');
const submitBooking = bloco('async function submitBooking', 'async function cancelReservation');
const cancelReserva = bloco('async function cancelReservation', '// Card "Indique um amigo"');

test('a pagina nao passa a resposta de reservas direto para o state', () => {
  assert.ok(
    !/setReservations\(\s*await\s+\w+\.json\(\)/.test(src),
    'voltou setReservations(await res.json()): um objeto de erro no state quebra o render em reservations.filter',
  );
});

test('loadReservations checa res.ok antes de usar o corpo', () => {
  assert.ok(
    /if \(!res\.ok\)/.test(loadReservas),
    'loadReservations precisa rejeitar resposta nao-2xx antes de setar o state',
  );
});

test('loadReservations so aceita array e descarta o resto', () => {
  assert.ok(
    /!Array\.isArray\(data\.reservations\)/.test(loadReservas),
    'sem guarda de tipo, qualquer objeto inesperado volta a derrubar reservations.filter',
  );
});

test('falha ao carregar reservas limpa a lista e registra o erro no mesmo passo', () => {
  // setReservations([]) junto do setReservationsErro evita deixar a lista velha
  // na tela quando um filtro posterior falha.
  assert.ok(
    /setReservations\(\[\]\);\s*\n\s*setReservationsErro\(/.test(loadReservas),
    'no caminho de erro, limpa a lista e registra o erro no mesmo passo',
  );
  assert.ok(src.includes('reservationsErro'), 'falta o estado reservationsErro');
});

test('o erro de reservas tem lugar proprio no render, sem passar por "nenhuma reserva"', () => {
  // Se reservationsErro nao for a primeira opcao do ternario, o cliente ve
  // "voce ainda nao tem reservas" quando o servidor esta quebrado, e conclui
  // que o agendamento sumiu.
  assert.ok(
    /reservationsErro\s*\?\s*\(/.test(src),
    'o render precisa testar reservationsErro antes da lista',
  );
  const card = bloco('t.myReservations ??', 't.myCoupons');
  const erroEm = card.indexOf('reservationsErro');
  const nenhumaEm = card.indexOf('reserveNone');
  assert.ok(erroEm !== -1 && nenhumaEm !== -1 && erroEm < nenhumaEm,
    'reservationsErro precisa vir antes do "nenhuma reserva" no mesmo card');
});

test('toda chamada nova de reservas usa fetchComTimeout', () => {
  // Requisicao travada nao rejeita: sem timeout o fetch fica pendurado e a tela
  // mostra "nenhuma reserva" como se nao houvesse nenhuma.
  assert.ok(
    /await fetchComTimeout\(`\/\.netlify\/functions\/shuttle-reservation\?/.test(loadReservas),
    'loadReservations precisa passar pelo fetch com timeout',
  );
  assert.ok(
    /await fetchComTimeout\('\/\.netlify\/functions\/shuttle-reservation'/.test(submitBooking),
    'submitBooking precisa passar pelo fetch com timeout',
  );
  assert.ok(
    /await fetchComTimeout\('\/\.netlify\/functions\/shuttle-reservation'/.test(cancelReserva),
    'cancelReservation precisa passar pelo fetch com timeout',
  );
  assert.ok(
    !/await fetch\('\/.netlify\/functions\/shuttle-reservation/.test(src),
    'voltou fetch cru em uma das chamadas de reserva',
  );
});

test('as tres chamadas novas de reserva sao async e nao rejeitam sem catch', () => {
  for (const nome of ['async function loadReservations', 'async function submitBooking', 'async function cancelReservation']) {
    assert.ok(src.includes(nome), `falta ${nome}`);
  }
  assert.ok(loadReservas.includes('catch'), 'loadReservations precisa tratar erro de rede');
  assert.ok(submitBooking.includes('catch'), 'submitBooking precisa tratar erro de rede');
  assert.ok(cancelReserva.includes('catch'), 'cancelReservation precisa tratar erro de rede');
});

test('o par customerId/customerToken vai no pedido, e o customerToken vem do cadastro', () => {
  // O endpoint exige os dois: sem o token o POST volta 401 CUSTOMER_TOKEN_INVALID.
  assert.ok(
    /customerToken,\s*\n\s*action: 'create'/.test(submitBooking),
    'submitBooking precisa mandar customerToken junto do customerId',
  );
  assert.ok(
    /customerToken,\s*action: 'cancel'/.test(cancelReserva),
    'cancelReservation precisa mandar customerToken junto do customerId',
  );
  assert.ok(
    /setCustomerToken\(s\.customerToken \|\| null\)/.test(src),
    'a hidratacao precisa guardar o customerToken do localStorage',
  );
  assert.ok(
    /setCustomerToken\(data\.customerToken\)/.test(src),
    'o cadastro precisa guardar o customerToken que veio do identify',
  );
});

test('o painel inline so envia com horario escolhido dentro dos slots', () => {
  // Sem esta checagem o banco responderia OUTSIDE_HOURS depois de a tela deixar
  // o cliente escolher qualquer coisa.
  assert.ok(
    /if \(!book\.time \|\| !slots\.includes\(book\.time\)\)/.test(submitBooking),
    'submitBooking precisa conferir que o horario escolhido esta na lista de slots',
  );
  assert.ok(
    /const slots = bookingSlots\(book\.service, book\.date,/.test(submitBooking),
    'submitBooking precisa montar os slots do servico antes de enviar',
  );
});

test('sem identificacao o painel oferece identificar agora, em vez de falhar no POST', () => {
  assert.ok(
    /if \(!customerId \|\| !customerToken\)[\s\S]{0,200}?reserveIdentifyFirst/.test(submitBooking),
    'submitBooking precisa recusar antes da rede quando nao ha identificacao',
  );
  assert.ok(
    /onClick=\{finalizeRegistration\}/.test(src),
    'o painel precisa oferecer identificar agora (reaproveitando finalizeRegistration)',
  );
});

test('o cancelamento recarrega a lista em vez de remendar o state', () => {
  // Se o banco recusar o cancelamento e a tela tirar o item na mesma hora, o
  // status exibido mente.
  assert.ok(
    /loadReservations\(\)/.test(cancelReserva),
    'cancelReservation precisa recarregar a lista depois da decisao',
  );
});

test('o link de WhatsApp usa o businessPhone que veio da RPC', () => {
  // O telefone nunca pode ser digitado no browser: o texto do link vem do banco.
  assert.ok(
    /buildWaLink\(\{ phone: justBooked\.businessPhone/.test(src),
    'o botao de WhatsApp precisa usar o businessPhone devolvido pela RPC',
  );
  assert.ok(
    /businessPhone: o\.businessPhone \|\| null/.test(
      readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'shuttle-reservation.js'), 'utf8'),
    ),
    'o handler precisa repassar businessPhone da RPC',
  );
});
