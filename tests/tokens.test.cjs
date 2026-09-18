'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeEvent, customerTokenFor } = require('./helpers.cjs');

// Testa helpers puros sem precisar de banco.
const { extractSessionToken, buildCustomerToken, verifyCustomerToken } = require('../netlify/functions/_supabaseAdmin.js');

test('extractSessionToken: header Authorization tem prioridade', () => {
  const body = { sessionToken: 'do-body' };
  const event = {
    headers: { authorization: 'Bearer do-header' },
    queryStringParameters: { sessionToken: 'do-query' },
  };
  assert.strictEqual(extractSessionToken(event, body), 'do-header');
});

test('extractSessionToken: faz fallback para query e depois body', () => {
  const e1 = { headers: {}, queryStringParameters: { sessionToken: 'do-query' }, body: { sessionToken: 'do-body' } };
  assert.strictEqual(extractSessionToken(e1), 'do-query');
  const e2 = { headers: {}, queryStringParameters: {}, body: { sessionToken: 'do-body' } };
  assert.strictEqual(extractSessionToken(e2, e2.body), 'do-body');
});

test('extractSessionToken: ignora header sem prefixo Bearer', () => {
  const event = { headers: { authorization: 'Bearer' }, queryStringParameters: {}, body: {} };
  assert.strictEqual(extractSessionToken(event, event.body), null);
});

test('extractSessionToken: caso sem token retorna null', () => {
  const event = { headers: {}, queryStringParameters: {}, body: {} };
  assert.strictEqual(extractSessionToken(event, event.body), null);
});

test('buildCustomerToken gera token estavel e verify valida', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const t1 = buildCustomerToken(id);
  const t2 = buildCustomerToken(id);
  assert.strictEqual(t1, t2, 'deve ser determinístico');
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.strictEqual(verifyCustomerToken(id, t1), true);
});

test('verifyCustomerToken rejeita token de outro id, adulterado, curto/unmatched', () => {
  const a = '11111111-2222-3333-4444-555555555555';
  const b = '99999999-0000-0000-0000-000000000000';
  const tokenA = buildCustomerToken(a);

  assert.strictEqual(verifyCustomerToken(b, tokenA), false, 'token do A nao vale para B');
  assert.strictEqual(verifyCustomerToken(a, tokenA.slice(0, -2) + 'ff'), false, 'token adulterado');
  assert.strictEqual(verifyCustomerToken(a, ''), false, 'token vazio');
  assert.strictEqual(verifyCustomerToken(a, null), false);
  assert.strictEqual(verifyCustomerToken(null, tokenA), false);
  assert.strictEqual(verifyCustomerToken(a, 'curto'), false);
});

test('customerTokenFor (test helper) gera o mesmo token que a producao', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  assert.strictEqual(customerTokenFor(id), buildCustomerToken(id));
});