'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers.cjs');

const CJS_DIR = path.join(ROOT, 'netlify', 'functions');
const ESM_DIR = path.join(ROOT, 'functions', '.netlify', 'functions');
const IGNORE = ['package.json'];

function list(dir) {
  return fs.readdirSync(dir).filter((f) => !IGNORE.includes(f) && f.endsWith('.js')).sort();
}

test('CJS e ESM tem exatamente o mesmo conjunto de functions', () => {
  const normalize = (files) => files
    .map((f) => (f === '_supabaseAdmin.js' || f === '_shared.js' ? '@helper' : f))
    .sort();
  assert.deepStrictEqual(normalize(list(ESM_DIR)), normalize(list(CJS_DIR)));
});

test('toda function CJS exporta handler e toda ESM exporta handlers onRequestGet/onRequestPost', () => {
  for (const file of list(CJS_DIR)) {
    const cjsPath = path.join(CJS_DIR, file);
    const esmPath = path.join(ESM_DIR, file === '_supabaseAdmin.js' ? '_shared.js' : file);
    const cjs = fs.readFileSync(cjsPath, 'utf8');
    const esm = fs.readFileSync(esmPath, 'utf8');
    if (file === '_supabaseAdmin.js') {
      assert.match(cjs, /module\.exports/, `${file} deve exportar helpers via module.exports`);
    } else {
      assert.match(cjs, /exports\.handler/, `${file} (CJS) deve exportar handler`);
      assert.match(esm, /onRequest(?:Get|Post)/, `${file} (ESM) deve exportar onRequestGet/onRequestPost`);
      assert.match(esm, /export (?:async )?function/, `${file} (ESM) deve usar export de function`);
      assert.doesNotMatch(esm, /require\(/, `${file} (ESM) nao deve usar require`);
    }
  }
});

test('helpers CJS e ESM expoem os mesmos nomes', () => {
  const cjs = fs.readFileSync(path.join(CJS_DIR, '_supabaseAdmin.js'), 'utf8');
  const esm = fs.readFileSync(path.join(ESM_DIR, '_shared.js'), 'utf8');
  for (const name of ['getSupabaseAdminClient', 'resolveSession', 'extractSessionToken', 'buildCustomerToken', 'verifyCustomerToken']) {
    assert.match(cjs, new RegExp(name), `_supabaseAdmin.js deve expor ${name}`);
    assert.match(esm, new RegExp(name), `_shared.js deve expor ${name}`);
  }
});

test('nenhum arquivo expoe chave secreta (service role / token em texto)', () => {
  const secrets = ['SUPABASE_SERVICE_ROLE_KEY =', 'service_role', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'];
  for (const file of list(CJS_DIR)) {
    const esmName = file === '_supabaseAdmin.js' ? '_shared.js' : file;
    for (const p of [path.join(CJS_DIR, file), path.join(ESM_DIR, esmName)]) {
      const source = fs.readFileSync(p, 'utf8');
      for (const s of secrets) {
        assert.doesNotMatch(source, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${path.basename(p)} nao deve conter segredo`);
      }
    }
  }
});