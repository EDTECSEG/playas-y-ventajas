'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody } = require('./helpers.cjs');

const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

test('mode=categories chama list_categories e devolve os chips', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'list_categories') {
        assert.strictEqual(args.p_tenant_id, TENANT);
        return { data: ['restaurante', 'hotel', 'passeio'], error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ query: { tenantId: TENANT, mode: 'categories' } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), ['restaurante', 'hotel', 'passeio']);
});

test('list_offers repassa category, lat/lng e radiusKm e mantem campos de destaque', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'list_offers') {
        assert.strictEqual(args.p_category, 'Restaurante');
        assert.strictEqual(args.p_lat, -13.5);
        assert.strictEqual(args.p_lng, -39.2);
        assert.strictEqual(args.p_radius_km, 16);
        return {
          data: [{ templateId: 'tpl-1', title: 'X', featured: true, featuredUntil: '2026-10-01T00:00:00Z', distanceKm: 2.5, imageUrl: 'img' }],
          error: null,
        };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({
    query: { tenantId: TENANT, category: 'Restaurante', lat: '-13.5', lng: '-39.2', radiusKm: '16' },
  }));
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  assert.strictEqual(body[0].featured, true);
  assert.strictEqual(body[0].featuredUntil, '2026-10-01T00:00:00Z');
  assert.strictEqual(body[0].distanceKm, 2.5);
});

test('list_offers sem radiusKm envia null (nao estoura parseFloat)', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'list_offers') {
        assert.strictEqual(args.p_radius_km, null);
        assert.strictEqual(args.p_lat, null);
        return { data: [], error: null };
      }
      return { data: null, error: { message: 'unexpected rpc ' + name } };
    },
  });
  const { handler, restore } = loadFunction('offers.js', fake);
  t.after(restore);
  const res = await handler(makeEvent({ query: { tenantId: TENANT } }));
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(parseBody(res), []);
});