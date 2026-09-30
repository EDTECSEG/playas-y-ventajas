'use strict';

// E2E AO VIVO do modulo de agendamento (Módulo A): cliente identifica ->
// cria reserva -> empresa ve na fila sem motivo -> recusa sem motivo falha
// (400 REASON_REQUIRED) -> confirma -> cliente cancela. Valida o que a
// suíte offline simula, agora contra producao via Cloudflare Pages.
//
// Desabilitado por padrao. Para rodar:
//   PowerShell:
//     $env:RUN_LIVE='1'
//     $env:LIVE_BUSINESS_CODE='edtecseg'; $env:LIVE_PIN='302311'
//     node --test tests/live.shuttle-reservation.test.cjs
//
// Este teste CRIA e APAGA dados em producao: usuario cliente (identify),
// servico de translado e a reserva. O cleanup roda no `after()` mesmo se
// alguma assercao falhar no meio. A service role e lida de .dev.vars e
// NUNCA e impressa.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.LIVE_BASE || 'https://playas-y-ventajas.pages.dev';
const SLUG = 'playas-y-ventajas';
const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';
const BUSINESS_CODE = process.env.LIVE_BUSINESS_CODE || '';
const COMPANY_PIN = process.env.LIVE_PIN || '4821';

const repoRoot = path.join(__dirname, '..');

const enabled = () => process.env.RUN_LIVE === '1'
  ? false
  : 'habilite com RUN_LIVE=1 para rodar contra producao';

function lerEnv() {
  const arquivo = path.join(repoRoot, '.dev.vars');
  if (!fs.existsSync(arquivo)) return {};
  return Object.fromEntries(
    fs.readFileSync(arquivo, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      })
  );
}

async function post(nome, body, token) {
  const res = await fetch(`${BASE}/.netlify/functions/${nome}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(nome, query, token) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${BASE}/.netlify/functions/${nome}${qs}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Amanha, meio-dia, fuso America/Sao_Paulo (Brazil sem DST => fixed -03:00).
// a RPC valida o dia da semana e a janela opens_at..closes_at em horario
// LOCAL, entao a data e montada no fuso do tenant.
function scheduledForISO() {
  const amanha = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(amanha).map((p) => [p.type, p.value])
  );
  return new Date(`${partes.year}-${partes.month}-${partes.day}T12:00:00-03:00`).toISOString();
}

const ctx = {};

describe('agendamento ao vivo', { skip: enabled() }, () => {
  before(() => {
    const env = lerEnv();
    if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_URL) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY/NEXT_PUBLIC_SUPABASE_URL ausentes em .dev.vars (usado no cleanup)');
    }
    ctx.env = env;
    if (!BUSINESS_CODE) {
      throw new Error('LIVE_BUSINESS_CODE ausente: defina o codigo interno da empresa de teste');
    }
    ctx.fone = `55119${Date.now().toString().slice(-9)}`;
    ctx.scheduledFor = scheduledForISO();
  });

  test('empresa autentica por codigo e senha', async () => {
    const r = await post('login', { tenantSlug: SLUG, internalCode: BUSINESS_CODE, pin: COMPANY_PIN });
    assert.strictEqual(r.status, 200, `login: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.sessionToken, 'deve vir sessionToken');
    ctx.sessaoEmpresa = r.body.sessionToken;
    ctx.businessId = r.body.businessId;
    ctx.tenantId = r.body.tenantId;
    assert.strictEqual(ctx.tenantId, TENANT_ID, 'tenant da empresa de teste');
  });

  test('empresa cria servico de translado de teste', async () => {
    const r = await post('empresa', {
      action: 'save_shuttle_service',
      name: 'Teste Reserva QAT (apagar)',
      description: 'Servico temporario do teste ao vivo de agendamento.',
      serviceType: 'shuttle',
      originLat: -34.9420, originLng: -54.9350,
      destLat: -34.9330, destLng: -54.9550,
      stops: [],
      priceCents: 50000,
      opensAt: '08:00', closesAt: '20:00',
      activeDays: [0, 1, 2, 3, 4, 5, 6],
    }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200, `save_shuttle_service: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.shuttleId, 'deve vir shuttleId');
    ctx.shuttleId = r.body.shuttleId;
  });

  test('cliente identifica por telefone e ganha customerToken', async () => {
    const r = await post('identify', { phone: ctx.fone, name: 'QA Live Reserva' });
    assert.strictEqual(r.status, 200, `identify: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.customerId, 'deve vir customerId');
    assert.ok(r.body.customerToken, 'deve vir customerToken');
    ctx.customerId = r.body.customerId;
    ctx.customerToken = r.body.customerToken;
  });

  test('cliente cria reserva (pending)', async () => {
    const r = await post('shuttle-reservation', {
      tenantId: ctx.tenantId,
      customerId: ctx.customerId,
      customerToken: ctx.customerToken,
      shuttleId: ctx.shuttleId,
      scheduledFor: ctx.scheduledFor,
      passengers: 2,
      notes: 'E2E ao vivo',
      contactPhone: ctx.fone,
    });
    assert.strictEqual(r.status, 200, `create: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, 'pending', `status: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.reservationId, 'deve vir reservationId');
    ctx.reservationId = r.body.reservationId;
  });

  test('token errado nao lista reserva do outro (anti-IDOR ativo)', async () => {
    const r = await get('shuttle-reservation', {
      tenantId: ctx.tenantId, customerId: ctx.customerId, customerToken: 'token-invalido',
    });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.error, 'CUSTOMER_TOKEN_INVALID');
  });

  test('cliente ve a propria reserva na lista', async () => {
    const r = await get('shuttle-reservation', {
      tenantId: ctx.tenantId, customerId: ctx.customerId, customerToken: ctx.customerToken,
    });
    assert.strictEqual(r.status, 200, `minhas reservas: ${JSON.stringify(r.body)}`);
    const minha = (r.body.reservations || []).find((x) => x.reservationId === ctx.reservationId);
    assert.ok(minha, 'a reserva recém-criada deve aparecer');
    assert.strictEqual(minha.status, 'pending');
    assert.ok(minha.serviceName, 'deve trazer nome do servico');
  });

  test('empresa ve a reserva na fila', async () => {
    const r = await get('empresa', { mode: 'reservations' }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200, `fila da empresa: ${JSON.stringify(r.body)}`);
    const fila = r.body.reservations || r.body;
    const minha = fila.find((x) => x.reservationId === ctx.reservationId);
    assert.ok(minha, 'a reserva deve aparecer na fila da empresa');
    assert.strictEqual(minha.status, 'pending');
  });

  test('recusa sem motivo e 400 REASON_REQUIRED', async () => {
    const r = await post('empresa', {
      action: 'review_reservation', reservationId: ctx.reservationId, decision: 'reject',
    }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 400, `reject sem motivo: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error, 'REASON_REQUIRED');
  });

  test('empresa confirma a reserva', async () => {
    const r = await post('empresa', {
      action: 'review_reservation', reservationId: ctx.reservationId, decision: 'confirm',
    }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200, `confirm: ${JSON.stringify(r.body)}`);
    ctx.confirmado = r.body;
  });

  test('cliente cancela a reserva confirmada', async () => {
    const r = await post('shuttle-reservation', {
      action: 'cancel',
      tenantId: ctx.tenantId,
      customerId: ctx.customerId,
      customerToken: ctx.customerToken,
      reservationId: ctx.reservationId,
      reason: 'mudanca de planos',
    });
    assert.strictEqual(r.status, 200, `cancel: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, 'cancelled');
  });

  // cleanup: roda mesmo com falha acima, para nao deixar cliente, servico nem
  // reserva em producao. Ordem respeita as FKs: reservas (shuttle_id RESTRICT)
  // -> servico -> usuario do cliente (customer_id CASCADE).
  after(async () => {
    if (!ctx.env) return;
    const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = ctx.env;
    const h = { apikey: key, Authorization: `Bearer ${key}` };

    const del = async (tabela, filtro) => {
      const res = await fetch(`${url}/rest/v1/${tabela}?${filtro}`, { method: 'DELETE', headers: h });
      return res.ok ? 'ok' : `nao (${res.status})`;
    };

    if (ctx.reservationId) {
      console.log(`    cleanup: reserva -> ${await del('shuttle_reservations', `id=eq.${ctx.reservationId}`)}`);
    }
    if (ctx.shuttleId) {
      console.log(`    cleanup: servico -> ${await del('shuttle_services', `id=eq.${ctx.shuttleId}`)}`);
    }
    if (ctx.customerId) {
      console.log(`    cleanup: cliente -> ${await del('users', `id=eq.${ctx.customerId}`)}`);
    }
  });
});