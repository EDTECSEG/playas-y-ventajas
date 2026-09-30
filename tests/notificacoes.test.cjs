'use strict';

// Fase 1 das notificacoes: a base (fila/auditoria) nunca pode mudar o contrato
// do resgate. Estes testes existem para travar exatamente isso:
//   - env ausente => 1 outbound_enqueue com provider='none'/status='noop';
//   - falha da RPC de auditoria nao altera o 200 nem o corpo;
//   - com provedor fake, sent/failed marcam certo e sem vazar segredo;
//   - dedupe, telefone normalizado e ausencia de contato sao nao-excepcional.
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const {
  ROOT, clearRequireCache, installSupabaseMock, makeFakeSupabase, makeEvent, parseBody, customerTokenFor,
} = require('./helpers.cjs');

const CLAIM = {
  publicId: 'PUB-1',
  customerId: 'c-1',
  couponId: '11111111-1111-4111-8111-111111111111',
  shortCode: 'ABC',
};

const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const WA_TOKEN = 'tok-fake-de-teste-nao-e-segredo-real';
const WA_PHONE_ID = '9999999999';

const TEMPLATE_ROW = {
  id: 'tmpl-1',
  title: 'Cafe 20% off',
  business_id: 'b-1',
  businesses: [{ name: 'Cafe Central', phone: '11988887777' }],
};

const NOTIFY_ENV_KEYS = [
  'WHATSAPP_PROVIDER', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
  'EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_PORT', 'MAIL_FROM',
];

// ---------------------------------------------------------------------------
// Infra de teste
// ---------------------------------------------------------------------------

// Envolve a execucao sem as env de provedor: e' o default de fabrica, e o
// comportamento que precisa ser o mais silencioso possivel.
async function withoutNotifyEnv(fn) {
  const saved = {};
  for (const key of NOTIFY_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of NOTIFY_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function withNotifyEnv(env, fn) {
  return withoutNotifyEnv(async () => {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return fn();
  });
}

// Captura o console para contar linhas de log e garantir que nenhum segredo
// aparece no que vai para o observavel.
async function withConsole(fn) {
  const logs = [];
  const orig = { info: console.info, warn: console.warn, error: console.error };
  const spy = (level) => (...args) => { logs.push({ level, line: args.map(String).join(' ') }); };
  console.info = spy('info');
  console.warn = spy('warn');
  console.error = spy('error');
  try {
    const value = await fn();
    return { value, logs };
  } finally {
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

// fetch injetado: o adaptador usa o global, entao o teste o troca e devolve.
async function withFetch(fakeFetch, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

function notifyFake({ enqueue, throwEnqueue, errorEnqueue, customer } = {}) {
  const marks = [];
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'outbound_enqueue') {
        if (throwEnqueue) throw new Error('auditoria fora do ar');
        if (errorEnqueue) return { data: null, error: { message: errorEnqueue } };
        return { data: enqueue === undefined ? { inserted: true, id: MESSAGE_ID } : enqueue, error: null };
      }
      if (name === 'outbound_mark_sent' || name === 'outbound_mark_failed') {
        marks.push({ name, args });
        return { data: true, error: null };
      }
      return { data: null, error: null };
    },
    from: async (table) => (table === 'users'
      ? { data: customer === undefined ? null : customer, error: null }
      : { data: null, error: null }),
  });
  fake.marks = marks;
  return fake;
}

function enqueueCalls(fake) {
  return fake.calls.rpc.filter((c) => c.name === 'outbound_enqueue');
}

// Carrega o claim-coupon. Com { notify }, troca o _notify por uma versao
// controlada — e assim que se obtem a LINHA DE BASE da resposta, byte a byte,
// sem duplicar a montagem do corpo no teste.
function loadClaim(fake, { notify } = {}) {
  const restoreSupabase = installSupabaseMock(fake);
  const origLoad = Module._load;
  if (notify) {
    Module._load = function (request, parent) {
      if (request === './_notify' && parent && /claim-coupon\.js$/.test(parent.filename || '')) {
        return { notifyOutbound: notify };
      }
      return origLoad.apply(this, arguments);
    };
  }
  try {
    clearRequireCache(path.join(ROOT, 'netlify', 'functions', 'claim-coupon.js'));
    const mod = require(path.join(ROOT, 'netlify', 'functions', 'claim-coupon.js'));
    return {
      handler: mod.handler,
      restore() {
        Module._load = origLoad;
        restoreSupabase();
      },
    };
  } catch (err) {
    Module._load = origLoad;
    restoreSupabase();
    throw err;
  }
}

function claimFake({ onEnqueue } = {}) {
  return makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'claim_coupon') return { data: CLAIM, error: null };
      if (name === 'outbound_enqueue') {
        if (onEnqueue === 'throw') throw new Error('auditoria fora do ar');
        if (onEnqueue === 'error') return { data: null, error: { message: 'OUTBOUND_FORBIDDEN: tenant' } };
        return { data: { inserted: true, id: MESSAGE_ID }, error: null };
      }
      return { data: null, error: null };
    },
    from: async (table) => (table === 'coupon_templates'
      ? { data: TEMPLATE_ROW, error: null }
      : { data: null, error: null }),
  });
}

function makeClaim() {
  return makeEvent({ method: 'POST', body: { tenantId: 't-1', templateId: 'tmpl-1', phone: '5511999999999' } });
}

// Linha de base: mesmo handler, hook neutralizado. Serve de referencia para
// provar que a resposta nao mudou.
async function baselineBody() {
  const fake = claimFake();
  const { handler, restore } = loadClaim(fake, { notify: async () => ({ status: 'skipped' }) });
  try {
    const res = await withoutNotifyEnv(() => handler(makeClaim()));
    return res.body;
  } finally {
    restore();
  }
}

function loadNotify() {
  clearRequireCache(path.join(ROOT, 'netlify', 'functions', '_notify.js'));
  return require(path.join(ROOT, 'netlify', 'functions', '_notify.js'));
}

function notifyOpts(extra = {}) {
  return Object.assign({
    event: 'coupon_claimed',
    channel: 'WHATSAPP',
    customerId: CLAIM.customerId,
    couponId: CLAIM.couponId,
    vars: { tenantId: 't-1', title: 'Cafe 20% off', businessName: 'Cafe Central', publicId: 'PUB-1', shortCode: 'ABC' },
  }, extra);
}

// ---------------------------------------------------------------------------
// (a) env ausente: 1 outbound_enqueue como noop e resposta inalterada
// ---------------------------------------------------------------------------

test('notificacoes: env ausente enfileira 1 aviso noop e nao muda a resposta do resgate', async () => {
  const fake = claimFake();
  const { handler, restore } = loadClaim(fake);
  const { value: res, logs } = await withConsole(() => withoutNotifyEnv(() => handler(makeClaim())));
  restore();

  assert.strictEqual(res.statusCode, 200);

  const calls = enqueueCalls(fake);
  assert.strictEqual(calls.length, 1, 'exatamente uma chamada a outbound_enqueue');
  assert.strictEqual(calls[0].args.p_event, 'coupon_claimed');
  assert.strictEqual(calls[0].args.p_channel, 'WHATSAPP');
  assert.strictEqual(calls[0].args.p_tenant_id, 't-1');
  assert.strictEqual(calls[0].args.p_customer_id, CLAIM.customerId);
  assert.strictEqual(calls[0].args.p_coupon_id, CLAIM.couponId);
  assert.strictEqual(calls[0].args.p_booking_ref, null);
  assert.strictEqual(calls[0].args.p_provider, 'none');
  assert.strictEqual(calls[0].args.p_status, 'noop');

  // Um unico console.info, no formato da spec, sem PII e sem segredo.
  const info = logs.filter((l) => l.level === 'info');
  assert.strictEqual(info.length, 1, 'exatamente uma linha de log no caminho noop');
  assert.match(info[0].line, /^notificacoes: noop WHATSAPP coupon_claimed \S+$/);
  assert.doesNotMatch(info[0].line, /5511999999999|Cafe Central|Cafe 20%/);

  // Nenhuma chamada de rede: sem provedor nao ha o que enviar.
  assert.ok(!fake.calls.rpc.some((c) => c.name.startsWith('outbound_mark_')));

  // Resposta byte-a-byte igual a linha de base (mesmo handler, sem hook).
  assert.strictEqual(res.body, await baselineBody());
});

// ---------------------------------------------------------------------------
// (b) falha da RPC de auditoria nao derruba o resgate
// ---------------------------------------------------------------------------

test('notificacoes: falha da RPC de auditoria nao altera status nem corpo', async () => {
  const base = await baselineBody();
  for (const onEnqueue of ['throw', 'error']) {
    const fake = claimFake({ onEnqueue });
    const { handler, restore } = loadClaim(fake);
    try {
      const { value: res } = await withConsole(() => withoutNotifyEnv(() => handler(makeClaim())));
      assert.strictEqual(res.statusCode, 200, `onEnqueue=${onEnqueue}`);
      assert.strictEqual(res.body, base, `onEnqueue=${onEnqueue}`);
      const body = parseBody(res);
      assert.strictEqual(body.couponId, CLAIM.couponId);
      assert.strictEqual(body.customerToken, customerTokenFor(CLAIM.customerId));
      assert.ok(body.whatsappUrl && body.whatsappUrl.includes('wa.me/5511988887777'), 'wa.me intacto');
    } finally {
      restore();
    }
  }
});

// ---------------------------------------------------------------------------
// (c) provedor fake: sent carrega provider_message_id; erro vira error_code
// ---------------------------------------------------------------------------

test('notificacoes: com provedor fake o envio marca sent com provider_message_id', async () => {
  const { notifyOutbound } = loadNotify();
  const fake = notifyFake();
  const fetched = [];
  const fakeFetch = async (url, init) => {
    fetched.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.RESULTADO-1' }] }),
    };
  };

  const env = { WHATSAPP_PROVIDER: 'cloud', WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID };
  const { value, logs } = await withConsole(() => withNotifyEnv(env, () => withFetch(fakeFetch, () => (
    notifyOutbound(fake, notifyOpts({ vars: Object.assign(notifyOpts().vars, { phone: '5511998888777' }) }))
  ))));

  assert.strictEqual(value.status, 'sent');
  assert.strictEqual(value.provider, 'whatsapp_cloud_api');

  const enq = enqueueCalls(fake)[0];
  assert.strictEqual(enq.args.p_status, 'queued');
  assert.strictEqual(enq.args.p_provider, 'whatsapp_cloud_api');
  assert.strictEqual(enq.args.p_destination, '5511998888777');

  assert.strictEqual(fetched.length, 1, 'uma unica tentativa no caminho feliz');
  assert.match(fetched[0].url, /graph\.facebook\.com/);
  assert.strictEqual(fetched[0].init.headers.authorization, 'Bearer ' + WA_TOKEN);
  const sent = JSON.parse(fetched[0].init.body);
  assert.strictEqual(sent.to, '5511998888777');
  assert.ok(sent.text.body.indexOf('PUB-1') > -1, 'mensagem montada com dado do banco');

  assert.strictEqual(fake.marks.length, 1);
  assert.strictEqual(fake.marks[0].name, 'outbound_mark_sent');
  assert.strictEqual(fake.marks[0].args.p_message_id, MESSAGE_ID);
  assert.strictEqual(fake.marks[0].args.p_provider_message_id, 'wamid.RESULTADO-1');

  // O log nao pode carregar o token nem o conteudo da mensagem.
  const info = logs.filter((l) => l.level === 'info');
  assert.strictEqual(info.length, 1);
  assert.match(info[0].line, /^notificacoes: sent WHATSAPP coupon_claimed \S+$/);
  assert.doesNotMatch(info[0].line, new RegExp(WA_TOKEN));
});

test('notificacoes: erro do provedor marca failed com error_code e sem mensagem crua', async () => {
  const { notifyOutbound } = loadNotify();
  const fake = notifyFake();
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'invalid token ' + WA_TOKEN + (WA_TOKEN + WA_TOKEN) } }),
    };
  };

  const env = { WHATSAPP_PROVIDER: 'cloud', WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID };
  const { value } = await withConsole(() => withNotifyEnv(env, () => withFetch(fakeFetch, () => (
    notifyOutbound(fake, notifyOpts({ vars: Object.assign(notifyOpts().vars, { phone: '5511998888777' }) }))
  ))));

  assert.strictEqual(value.status, 'failed');
  assert.strictEqual(calls, 2, 'no maximo 2 tentativas');
  assert.strictEqual(fake.marks.length, 1);
  assert.strictEqual(fake.marks[0].name, 'outbound_mark_failed');
  assert.strictEqual(fake.marks[0].args.p_message_id, MESSAGE_ID);
  assert.strictEqual(fake.marks[0].args.p_error_code, 'HTTP_500');
  // O codigo nao carrega o texto do terceiro nem o token.
  assert.doesNotMatch(String(fake.marks[0].args.p_error_code), new RegExp(WA_TOKEN));
  assert.doesNotMatch(String(fake.marks[0].args.p_error_code), /invalid/i);
});

// ---------------------------------------------------------------------------
// (d) dedupe: ja registrado => nao envia
// ---------------------------------------------------------------------------

test('notificacoes: dedupe (inserted=false) nao gera envio', async () => {
  const { notifyOutbound } = loadNotify();
  // A RPC pode responder { inserted, id } (contrato novo) ou o boolean puro
  // (contrato antigo da spec). As duas formas precisam barrar o envio.
  for (const dedupe of [{ inserted: false, id: null }, false]) {
    const fake = notifyFake({ enqueue: dedupe });
    let calls = 0;
    const fakeFetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; };

    const env = { WHATSAPP_PROVIDER: 'cloud', WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID };
    const { value, logs } = await withConsole(() => withNotifyEnv(env, () => withFetch(fakeFetch, () => (
      notifyOutbound(fake, notifyOpts({ vars: Object.assign(notifyOpts().vars, { phone: '5511998888777' }) }))
    ))));

    assert.strictEqual(value.status, 'duplicate', JSON.stringify(dedupe));
    assert.strictEqual(calls, 0, 'nenhuma chamada de rede quando ja existe aviso do mesmo evento/canal');
    assert.strictEqual(fake.marks.length, 0, 'nada a marcar');
    assert.strictEqual(logs.length, 0, 'nada a logar: o aviso ja foi registrado antes');
  }
});

// ---------------------------------------------------------------------------
// (e) telefone normalizado / contato ausente
// ---------------------------------------------------------------------------

test('notificacoes: telefone com +, espacos e zero a esquerda vira digitos com DDI', async () => {
  const { notifyOutbound } = loadNotify();
  const fake = notifyFake();
  await withoutNotifyEnv(() => notifyOutbound(fake, notifyOpts({
    vars: Object.assign(notifyOpts().vars, { phone: '+55 (11) 98765-4321' }),
  })));
  assert.strictEqual(enqueueCalls(fake)[0].args.p_destination, '5511987654321');
  assert.strictEqual(enqueueCalls(fake)[0].args.p_status, 'noop');
});

test('notificacoes: sem telefone no contexto, busca o contato do cliente no banco', async () => {
  const { notifyOutbound } = loadNotify();
  const fake = notifyFake({ customer: { id: CLAIM.customerId, phone: '(11) 91234-5678', email: null } });
  await withoutNotifyEnv(() => notifyOutbound(fake, notifyOpts()));
  assert.ok(fake.calls.from.includes('users'), 'o contato vem do banco, nunca do request');
  assert.strictEqual(enqueueCalls(fake)[0].args.p_destination, '5511912345678');
});

test('notificacoes: telefone ausente nao lanca: registra noop sem destino e sem envio', async () => {
  const { notifyOutbound } = loadNotify();
  const fake = notifyFake({ customer: { id: CLAIM.customerId, phone: null, email: null } });
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; };

  const env = { WHATSAPP_PROVIDER: 'cloud', WHATSAPP_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID };
  const { value, logs } = await withConsole(() => withNotifyEnv(env, () => withFetch(fakeFetch, () => (
    notifyOutbound(fake, notifyOpts())
  ))));

  assert.strictEqual(value.status, 'noop');
  assert.strictEqual(calls, 0, 'sem contato valido nao ha envio');
  const enq = enqueueCalls(fake)[0];
  assert.strictEqual(enq.args.p_destination, null);
  assert.strictEqual(enq.args.p_provider, 'none');
  assert.strictEqual(enq.args.p_status, 'noop');
  assert.strictEqual(logs.filter((l) => l.level === 'info').length, 1);
});

test('notificacoes: canal EMAIL usa o email do cliente (email segue canal nao verificado)', async () => {
  const { notifyOutbound } = loadNotify();
  const fake = notifyFake({ customer: { id: CLAIM.customerId, phone: null, email: 'Cliente@Exemplo.COM ' } });
  await withoutNotifyEnv(() => notifyOutbound(fake, notifyOpts({ channel: 'EMAIL' })));
  const enq = enqueueCalls(fake)[0];
  assert.strictEqual(enq.args.p_channel, 'EMAIL');
  assert.strictEqual(enq.args.p_destination, 'cliente@exemplo.com');
  assert.strictEqual(enq.args.p_status, 'noop');
});

test('notificacoes: entrada incompleta e canal invalido nao lanca e nao escreve', async () => {
  const { notifyOutbound } = loadNotify();
  for (const opts of [
    notifyOpts({ channel: 'SMS' }),
    notifyOpts({ event: '' }),
    notifyOpts({ vars: { title: 'sem tenant' } }),
  ]) {
    const fake = notifyFake();
    const value = await withoutNotifyEnv(() => notifyOutbound(fake, opts));
    assert.strictEqual(value.status, 'skipped', JSON.stringify(opts.channel) + '/' + opts.event);
    assert.strictEqual(enqueueCalls(fake).length, 0);
  }
});

// ---------------------------------------------------------------------------
// (f) saneamento: nenhum segredo novo na resposta nem na auditoria
// ---------------------------------------------------------------------------

test('notificacoes: nem resposta nem outbound_enqueue carregam segredo', async () => {
  const { notifyOutbound } = loadNotify();
  const fake = notifyFake();
  let calls = 0;
  const fakeFetch = async () => { calls += 1; return { ok: false, status: 401, json: async () => ({}) }; };

  const env = {
    WHATSAPP_PROVIDER: 'cloud',
    WHATSAPP_TOKEN: WA_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: WA_PHONE_ID,
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.exemplo.test',
    SMTP_USER: 'usuario-exemplo',
    SMTP_PASSWORD: 'senha-exemplo-fake',
  };
  await withConsole(() => withNotifyEnv(env, () => withFetch(fakeFetch, () => (
    notifyOutbound(fake, notifyOpts({ vars: Object.assign(notifyOpts().vars, { phone: '5511998888777' }) }))
  ))));

  const audit = JSON.stringify(enqueueCalls(fake)[0].args) + JSON.stringify(fake.marks);
  for (const secret of [WA_TOKEN, 'senha-exemplo-fake', 'smtp.exemplo.test', 'usuario-exemplo']) {
    assert.doesNotMatch(audit, new RegExp(secret), 'auditoria nao guarda credencial');
  }

  // E a resposta do resgate, pelo caminho real do handler, tambem nao.
  const claimSupabase = claimFake();
  const { handler, restore } = loadClaim(claimSupabase);
  try {
    const { value: res, logs } = await withConsole(() => withNotifyEnv(env, () => handler(makeClaim())));
    const everything = res.body + JSON.stringify(logs);
    assert.strictEqual(res.statusCode, 200);
    for (const secret of [WA_TOKEN, 'senha-exemplo-fake', 'SMTP_PASSWORD', 'WHATSAPP_TOKEN', 'service_role']) {
      assert.doesNotMatch(everything, new RegExp(secret), 'resposta/log do resgate nao carrega segredo');
    }
  } finally {
    restore();
  }
});
