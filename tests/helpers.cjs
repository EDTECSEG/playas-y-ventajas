'use strict';

const Module = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

// Sessao "de banco" que o fake devolve no resolveSession.
const VALID_ACTORS = {
  merchant: { userId: 'u-merchant-1', tenantId: 't-1', role: 'MERCHANT', businessId: 'b-1' },
  admin: { userId: 'u-admin-1', tenantId: 't-1', role: 'ADMIN', businessId: null },
};

function clearRequireCache(moduleId) {
  const key = require.resolve(moduleId);
  delete require.cache[key];
}

// Intercepta a require de '@supabase/supabase-js' para injetar um client fake.
function installSupabaseMock(fakeClient) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@supabase/supabase-js') return { createClient: () => fakeClient };
    return orig.apply(this, arguments);
  };
  return function restore() { Module._load = orig; };
}

// Fake client com RPC/storage/from configuraveis por teste.
function makeFakeSupabase({ rpc, upload, from } = {}) {
  const calls = { rpc: [], uploads: [], removals: [], from: [], eq: [], order: [] };
  return {
    calls,
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      if (typeof rpc === 'function') return rpc(name, args);
      return { data: null, error: null };
    },
    // Cadeia minima de .from().select().eq().in()/.order()/.limit()/.maybeSingle()
    // para handlers que leem tabela alem de rpc (ex.: withOfferImages em
    // offers.js, get-or-create em affiliates.js). Se um hook `from` for
    // passado, o terminal (.in/.maybeSingle) resolve por ele, senao devolve
    // data:null.
    from: (table) => {
      calls.from.push(table);
      const resolve = async () => {
        if (typeof from === 'function') return from(table);
        return { data: null, error: null };
      };
      const chain = {
        select: () => ({ ...chain }),
        eq: (column, value) => { calls.eq.push({ table, column, value }); return { ...chain }; },
        in: () => resolve(),
        order: (column, opts) => { calls.order.push({ table, column, opts }); return { ...chain }; },
        limit: () => ({ ...chain }),
        maybeSingle: () => resolve(),
      };
      Object.defineProperty(chain, 'then', { value: undefined });
      return chain;
    },
    storage: {
      from: () => ({
        upload: async (filePath, body, opts) => {
          calls.uploads.push({ filePath, body, opts });
          if (typeof upload === 'function') return upload(filePath, body, opts);
          return { data: null, error: null };
        },
        getPublicUrl: (filePath) => ({ data: { publicUrl: `https://cdn.example.test/${filePath}` } }),
        // Chamado quando o handler apaga um arquivo que sobrou, para nao
        // deixar orfao no bucket quando a RPC recusa.
        remove: async (paths) => {
          calls.removals.push(paths);
          return { data: null, error: null };
        },
      }),
    },
  };
}

// Construtor de eventos Netlify (CJS).
function makeEvent({ method = 'GET', query = {}, headers = {}, body } = {}) {
  const event = {
    httpMethod: method,
    queryStringParameters: query,
    headers: { 'x-forwarded-for': '203.0.113.9', ...headers },
  };
  if (body !== undefined) event.body = typeof body === 'string' ? body : JSON.stringify(body);
  return event;
}

// Requer uma function do backend CJS com o client fake instalado.
function loadFunction(fileName, fakeClient) {
  const restore = installSupabaseMock(fakeClient);
  clearRequireCache(path.join(ROOT, 'netlify', 'functions', '_supabaseAdmin.js'));
  clearRequireCache(path.join(ROOT, 'netlify', 'functions', fileName));
  const fn = require(path.join(ROOT, 'netlify', 'functions', fileName));
  return { handler: fn.handler, restore };
}

function parseBody(result) {
  if (typeof result.body === 'string' && result.body) return JSON.parse(result.body);
  return result.body || null;
}

// Gera um customerToken valido para um customerId (mesmo algoritmo das functions).
const { createHmac } = require('crypto');
function customerTokenFor(customerId) {
  return createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY)
    .update(String(customerId)).digest('hex');
}

// Bytes validos de PNG (magic bytes + padding).
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3, 4]);

// Bytes validos de PDF (magic %PDF- + corpo).
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7', 'latin1'), Buffer.from('\n%%EOF')]);

module.exports = {
  ROOT,
  VALID_ACTORS,
  clearRequireCache,
  installSupabaseMock,
  makeFakeSupabase,
  makeEvent,
  loadFunction,
  parseBody,
  customerTokenFor,
  PNG_BYTES,
  PDF_BYTES,
};