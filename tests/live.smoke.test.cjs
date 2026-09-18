'use strict';

// Smoke test AO VIVO: valida o site publicado (Cloudflare Pages).
// Desabilitado por padrao. Para rodar:
//   PowerShell:  $env:RUN_LIVE=1; npm test -- tests/live.smoke.test.cjs
// Opcionalmente configure credenciais reais antes de rodar:
//   $env:LIVE_TENANT; $env:LIVE_CODE; $env:LIVE_PIN

const { test } = require('node:test');
const assert = require('node:assert');

const BASE = process.env.LIVE_BASE || 'https://playas-y-ventajas.pages.dev';
const TENANT = process.env.LIVE_TENANT || 'playas-y-ventajas';
const CODE = process.env.LIVE_CODE || 'MERCHANT-001';
const PIN = process.env.LIVE_PIN || '1234';

const enabled = () => process.env.RUN_LIVE === '1'
  ? false
  : 'habilite com RUN_LIVE=1 para rodar contra produção';

async function post(path, body) {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('login correto retorna sessionToken', { skip: enabled() }, async () => {
  const r = await post('.netlify/functions/login', { tenantSlug: TENANT, internalCode: CODE, pin: PIN });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.sessionToken, 'deve vir sessionToken');
});

test('login errado retorna 401', { skip: enabled() }, async () => {
  const r = await post('.netlify/functions/login', { tenantSlug: TENANT, internalCode: CODE, pin: 'senha-errada-definitiva' });
  assert.strictEqual(r.status, 401);
});

test('my-coupons sem token do cliente retorna 401 (anti-IDOR ativo)', { skip: enabled() }, async () => {
  const url = `${BASE}/.netlify/functions/offers?tenantId=0dc57eeb-46c8-47ac-aad4-640d9d59e7b9&mode=my-coupons&customerId=11111111-2222-3333-4444-555555555555`;
  const res = await fetch(url);
  const body = await res.json();
  assert.strictEqual(res.status, 401);
  assert.strictEqual(body.error, 'CUSTOMER_TOKEN_INVALID');
});

test('upload-image sem auth retorna 401', { skip: enabled() }, async () => {
  const r = await post('.netlify/functions/upload-image', { base64: 'aGVsbG8=', contentType: 'text/plain', folder: 'misc' });
  assert.strictEqual(r.status, 401);
});

test('identify exige telefone (400)', { skip: enabled() }, async () => {
  const r = await post('.netlify/functions/identify', {});
  assert.strictEqual(r.status, 400);
});

test('lista publica de ofertas responde 200 com array', { skip: enabled() }, async () => {
  const res = await fetch(`${BASE}/.netlify/functions/offers?tenantId=0dc57eeb-46c8-47ac-aad4-640d9d59e7b9`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(body), 'deve ser uma lista');
});