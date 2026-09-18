'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { makeFakeSupabase, makeEvent, loadFunction, parseBody, PNG_BYTES } = require('./helpers.cjs');

const SESSION_TOKEN = 'valid-session-token';
const ACTOR = { userId: 'u1', tenantId: 't1', role: 'MERCHANT', businessId: 'b1' };

function b64(buf) { return Buffer.from(buf).toString('base64'); }

// fake supabase onde resolveSession (auth_verify_session) sempre valida.
function authFake({ rpc, upload } = {}) {
  return makeFakeSupabase({
    rpc: async (name, args) => {
      if (name === 'auth_verify_session') {
        assert.strictEqual(args.p_session_token, SESSION_TOKEN);
        return { data: ACTOR, error: null };
      }
      if (typeof rpc === 'function') return rpc(name, args);
      return { data: null, error: { message: 'unexpected rpc' } };
    },
    upload,
  });
}

function uploadEvent(base64, contentType, folder, token = SESSION_TOKEN) {
  return makeEvent({
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { base64, contentType, folder },
  });
}

test('upload sem sessao retorna 401 SESSION_REQUIRED', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_verify_session') return { data: ACTOR, error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);

  const res = await handler(makeEvent({ method: 'POST', body: { base64: b64(PNG_BYTES), contentType: 'image/png', folder: 'misc' } }));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'SESSION_REQUIRED');
  assert.strictEqual(fake.calls.uploads.length, 0);
});

test('upload com sessao invalida retorna 401 SESSION_EXPIRED', async (t) => {
  const fake = makeFakeSupabase({
    rpc: async (name) => {
      if (name === 'auth_verify_session') return { data: null, error: { message: 'expired' } };
      return { data: null, error: { message: 'unexpected' } };
    },
  });
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);
  const res = await handler(uploadEvent(b64(PNG_BYTES), 'image/png', 'misc'));
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(parseBody(res).error, 'SESSION_EXPIRED');
});

test('upload rejeita tipo nao permitido (text/plain)', async (t) => {
  const fake = authFake({});
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);
  const res = await handler(uploadEvent(b64(PNG_BYTES), 'text/plain', 'misc'));
  assert.strictEqual(res.statusCode, 400);
  assert.match(parseBody(res).error, /não permitido/i);
  assert.strictEqual(fake.calls.uploads.length, 0);
});

test('upload rejeita conteudo que nao bate com o tipo (magic bytes)', async (t) => {
  const fake = authFake({});
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);
  const res = await handler(uploadEvent(b64('isso não é um PNG'), 'image/png', 'misc'));
  assert.strictEqual(res.statusCode, 400);
  assert.match(parseBody(res).error, /não corresponde/i);
  assert.strictEqual(fake.calls.uploads.length, 0);
});

test('upload rejeita arquivo acima de 6 MB', async (t) => {
  const fake = authFake({});
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);
  // PNG magico + payload acima do limite (6MB + 100 bytes)
  const big = Buffer.concat([PNG_BYTES, Buffer.alloc(6 * 1024 * 1024 + 100 - PNG_BYTES.length, 0)]);
  const res = await handler(uploadEvent(b64(big), 'image/png', 'misc'));
  assert.strictEqual(res.statusCode, 400);
  assert.match(parseBody(res).error, /6 MB/);
  assert.strictEqual(fake.calls.uploads.length, 0);
});

test('upload valido envia para pasta segura e retorna URL publica', async (t) => {
  let uploadedPath = null;
  const fake = authFake({
    upload: async (filePath) => { uploadedPath = filePath; return { data: null, error: null }; },
  });
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);

  const res = await handler(uploadEvent(b64(PNG_BYTES), 'image/png', 'business-logos'));
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  assert.strictEqual(body.url, `https://cdn.example.test/${uploadedPath}`);
  assert.match(uploadedPath, /^business-logos\/[0-9a-f-]{36}\.png$/, 'extensao definida no servidor, nao no cliente');
  assert.strictEqual(fake.calls.uploads[0].opts.contentType, 'image/png');
});

test('upload com folder desconhecido usa fallback misc', async (t) => {
  const fake = authFake({ upload: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);
  const res = await handler(uploadEvent(b64(PNG_BYTES), 'image/png', '../../escape'));
  assert.strictEqual(res.statusCode, 200);
  assert.match(fake.calls.uploads[0].filePath, /^misc\//);
});

test('upload quando storage falha propaga o erro', async (t) => {
  const fake = authFake({ upload: async () => ({ data: null, error: { message: 'quota' } }) });
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);
  const res = await handler(uploadEvent(b64(PNG_BYTES), 'image/png', 'misc'));
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(parseBody(res).error, 'quota');
});

test('upload de jpeg e webp sao aceitos com extensao correta', async (t) => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10, 0)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(4, 0)]);
  const fake = authFake({ upload: async () => ({ data: null, error: null }) });
  const { handler, restore } = loadFunction('upload-image.js', fake);
  t.after(restore);

  let res = await handler(uploadEvent(b64(jpeg), 'image/jpeg', 'campaign-images'));
  assert.strictEqual(res.statusCode, 200);
  assert.match(fake.calls.uploads[fake.calls.uploads.length - 1].filePath, /\.jpg$/);

  res = await handler(uploadEvent(b64(webp), 'image/webp', 'campaign-images'));
  assert.strictEqual(res.statusCode, 200);
  assert.match(fake.calls.uploads[fake.calls.uploads.length - 1].filePath, /\.webp$/);
});