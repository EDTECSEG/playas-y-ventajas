'use strict';

// E2E AO VIVO do reporte de posicao (driver-position / driver_report_position):
// empresa loga -> cria servico de translado -> cadastra motorista -> PIN ->
// documento -> aprovacao -> login do motorista -> reporta posicao vinculada ao
// servico -> mapa publico (/shuttle) reflete o veiculo.
//
// Desabilitado por padrao. Para rodar:
//   PowerShell:
//     $env:RUN_LIVE='1'
//     $env:LIVE_BUSINESS_CODE='edtecseg'; $env:LIVE_PIN='302311'
//     node --test tests/live.driver-position.test.cjs
//
// Este teste CRIA e APAGA dados em producao: servico de translado, cadastro de
// motorista, documento no storage e posicao. O cleanup roda no `after()` mesmo
// se alguma assercao falhar no meio.
//
// A service role e lida de .dev.vars e NUNCA e impressa.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.LIVE_BASE || 'https://playas-y-ventajas.pages.dev';
const SLUG = 'playas-y-ventajas';
const BUSINESS_CODE = process.env.LIVE_BUSINESS_CODE || '';
const COMPANY_PIN = process.env.LIVE_PIN || '4821';
const DRIVER_PIN = '2468';

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

const ctx = {};

describe('reporte de posicao ao vivo', { skip: enabled() }, () => {
  before(() => {
    const env = lerEnv();
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY ausente em .dev.vars (usado no cleanup)');
    }
    ctx.env = env;
    ctx.internalCode = BUSINESS_CODE;
    if (!BUSINESS_CODE) {
      throw new Error('LIVE_BUSINESS_CODE ausente: defina o codigo interno da empresa de teste');
    }
    const sufixo = Date.now().toString().slice(-9);
    ctx.fone = `55119${sufixo}`;
    ctx.emailMotorista = `qa.posicao.${sufixo}@exemplo.com`;
    ctx.pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
      'latin1'
    ).toString('base64');
  });

  test('empresa autentica por codigo e senha', async () => {
    const r = await post('login', {
      tenantSlug: SLUG, internalCode: ctx.internalCode, pin: COMPANY_PIN,
    });
    assert.strictEqual(r.status, 200, `login: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.sessionToken, 'deve vir sessionToken');
    ctx.sessaoEmpresa = r.body.sessionToken;
    ctx.businessId = r.body.businessId;
    ctx.tenantId = r.body.tenantId;
  });

  test('empresa cria servico de translado de teste', async () => {
    const r = await post('empresa', {
      action: 'save_shuttle_service',
      name: 'Teste Posicao QAT (apagar)',
      description: 'Servico temporario do teste ao vivo de posicao.',
      serviceType: 'shuttle',
      originLat: -34.9420, originLng: -54.9350,
      destLat: -34.9330, destLng: -54.9550,
      stops: [],
      priceCents: 50000,
      opensAt: '08:00', closesAt: '20:00',
      activeDays: [1, 2, 3, 4, 5, 6],
    }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200, `save_shuttle_service: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.shuttleId, 'deve vir shuttleId');
    ctx.shuttleId = r.body.shuttleId;
  });

  test('motorista se cadastra vinculado a empresa', async () => {
    const r = await post('driver-register', {
      tenantId: ctx.tenantId,
      name: 'Teste Posicao Live',
      phone: ctx.fone,
      email: ctx.emailMotorista,
      businessId: ctx.businessId,
    });
    assert.strictEqual(r.status, 200, `driver-register: ${JSON.stringify(r.body)}`);
    ctx.driverId = r.body.driverId;
    ctx.pinToken = r.body.pinToken;
    ctx.uploadToken = r.body.uploadToken;
  });

  test('motorista define o PIN', async () => {
    const ok = await post('driver-set-pin', {
      tenantId: ctx.tenantId, phone: ctx.fone, pin: DRIVER_PIN, pinToken: ctx.pinToken,
    });
    assert.strictEqual(ok.status, 200, `driver-set-pin: ${JSON.stringify(ok.body)}`);
  });

  test('motorista envia CNH para a empresa', async () => {
    const r = await post('driver-add-document', {
      tenantId: ctx.tenantId,
      driverId: ctx.driverId,
      docType: 'cnh',
      fileBase64: ctx.pdf,
      contentType: 'application/pdf',
      docNumber: '12345678900',
      uploadToken: ctx.uploadToken,
    });
    assert.strictEqual(r.status, 200, `driver-add-document: ${JSON.stringify(r.body)}`);
    ctx.documentId = r.body.documentId;
  });

  test('empresa aprova o motorista', async () => {
    const lista = await get('driver-list-for-business', { status: 'pending' }, ctx.sessaoEmpresa);
    assert.strictEqual(lista.status, 200, `driver-list-for-business: ${JSON.stringify(lista.body)}`);
    const meu = lista.body.drivers.find((d) => d.driverId === ctx.driverId);
    assert.ok(meu, 'o pendente deve aparecer na listagem');

    const r = await post('driver-review-document', {
      documentId: ctx.documentId, action: 'approve',
    }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200, `driver-review-document: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.documentStatus, 'approved');
    assert.strictEqual(r.body.driverStatus, 'approved');
  });

  test('motorista aprovado loga e reporta posicao vinculada ao servico', async () => {
    const lr = await post('driver-login', { tenantId: ctx.tenantId, phone: ctx.fone, pin: DRIVER_PIN });
    assert.strictEqual(lr.status, 200, `driver-login: ${JSON.stringify(lr.body)}`);
    assert.strictEqual(lr.body.status, 'approved');
    assert.ok(lr.body.sessionToken, 'deve vir sessionToken');
    ctx.sessaoMotorista = lr.body.sessionToken;

    const r = await post('driver-position', {
      lat: -34.9420, lng: -54.9350, heading: 90, speedKmh: 42.5, shuttleId: ctx.shuttleId,
    }, ctx.sessaoMotorista);
    assert.strictEqual(r.status, 200, `driver-position: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.driverId, ctx.driverId, 'devolve o driverId da sessao');
    assert.ok(r.body.recordedAt, 'deve vir recordedAt');
  });

  test('mapa publico reflete o veiculo com o servico vinculado', async () => {
    const pub = await get('shuttle', { tenantId: ctx.tenantId });
    assert.strictEqual(pub.status, 200, `shuttle publico: ${JSON.stringify(pub.body)}`);
    const v = pub.body.vehicles.find((x) => x.driverId === ctx.driverId);
    assert.ok(v, `o veiculo deve aparecer em vehicles: ${JSON.stringify(pub.body.vehicles)}`);
    assert.strictEqual(v.shuttleId, ctx.shuttleId, 'posicao vinculada ao servico de teste');
    assert.strictEqual(v.heading, 90, 'rumo persistido');
    assert.strictEqual(v.speedKmh, 42.5, 'velocidade persistida');
    assert.ok(v.recordedAt, 'deve vir recordedAt');
    assert.ok(v.driverName, 'deve vir driverName');
  });

  test('posicao sem sessao continua negada ao vivo', async () => {
    const sem = await get('driver-position');
    assert.strictEqual(sem.status, 405, 'GET driver-position nao existe');
    const postSemToken = await post('driver-position', { lat: -34.9, lng: -54.9 });
    assert.strictEqual(postSemToken.status, 401, 'sem sessao precisa negar');
    assert.strictEqual(postSemToken.body.error, 'AUTH_REQUIRED');
  });

  // cleanup: roda mesmo com falha acima, para nao deixar servico, cadastro,
  // documento nem posicao em producao.
  after(async () => {
    if (ctx.sessaoEmpresa && ctx.shuttleId) {
      const del = await post('empresa', { action: 'delete_shuttle_service', serviceId: ctx.shuttleId }, ctx.sessaoEmpresa);
      console.log(`    cleanup: delete do servico -> ${del.status}`);
    }

    if (!ctx.driverId || !ctx.env) return;

    const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = ctx.env;
    const bucket = 'driver-documents';
    const prefix = `${ctx.tenantId}/${ctx.driverId}/`;

    try {
      const lista = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 100 }),
      });
      const objetos = (await lista.json()) ?? [];
      for (const o of objetos) {
        await fetch(`${url}/storage/v1/object/${bucket}/${prefix}${o.name}`, {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
      }
      console.log(`    cleanup: ${objetos.length} arquivo(s) removido(s) do storage`);
    } catch (e) {
      console.error(`    cleanup do storage falhou: ${e.message}`);
    }

    const del = await fetch(`${url}/rest/v1/drivers?id=eq.${ctx.driverId}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    console.log(
      `    cleanup: cadastro ${del.ok ? 'removido' : `NAO removido (${del.status})`}` +
      (del.ok ? '' : ` — remover ${ctx.driverId} (telefone ${ctx.fone})`)
    );
  });
});