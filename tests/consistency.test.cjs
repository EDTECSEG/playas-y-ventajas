'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers.cjs');

const CJS_DIR = path.join(ROOT, 'netlify', 'functions');
const ESM_DIR = path.join(ROOT, 'functions', '.netlify', 'functions');
const IGNORE = ['package.json'];

// Modulos compartilhados: nao sao rotas, entao nao devem exportar handler HTTP.
//
// Declarado explicitamente em vez de inferido do grafo de imports, porque o
// grafo diverge entre os dois dialetos: o CJS `_otp.js` faz require('./_resend'),
// mas o ESM `_otp.js` tem sendEmail inline e nao importa nada. Inferindo, o
// `_resend.js` ESM pareceria um endpoint.
//
// Este conjunto e a unica fonte de verdade sobre o que e helper. O teste
// 'helpers declarados batem com o grafo de imports'cruza os dois, para um
// helper recem-criado nao poder ser esquecido aqui em silencio.
const HELPERS = new Set([
  '_supabaseAdmin.js', // canonico; par no ESM e _shared.js
  '_shared.js',
  '_otp.js',
  '_resend.js',
  '_wa.js',
]);

// O par do helper de admin tem nomes diferentes nos dois dialetos.
const ESM_NAME_OF = (cjsName) => (cjsName === '_supabaseAdmin.js' ? '_shared.js' : cjsName);

const isHelper = (name) => HELPERS.has(name);

function list(dir) {
  return fs.readdirSync(dir).filter((f) => !IGNORE.includes(f) && f.endsWith('.js')).sort();
}

// Nomes de modulos importados por algum arquivo do diretorio.
function importedBy(dir) {
  const imported = new Set();
  for (const file of list(dir)) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/require\('\.\/([^']+)'\)/g)) imported.add(`${m[1]}.js`);
    for (const m of src.matchAll(/from\s+'\.\/([^']+)\.js'/g)) imported.add(m[1]);
  }
  return imported;
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
    const esmPath = path.join(ESM_DIR, ESM_NAME_OF(file));
    const cjs = fs.readFileSync(cjsPath, 'utf8');
    const esm = fs.readFileSync(esmPath, 'utf8');

    if (isHelper(file)) {
      // Um helper NAO deve virar rota. O file-based routing do Cloudflare Pages
      // (e do Netlify) mapeia todo .js do diretorio para uma rota; um handler
      // no-op em `_resend.js` publicaria uma rota que carrega a logica da chave
      // da Resend sem servir para nada. Helper nao aceita handler HTTP.
      assert.doesNotMatch(cjs, /exports\.handler/, `${file} e helper e nao deve exportar handler (viraria rota publica)`);
      assert.doesNotMatch(esm, /onRequest(?:Get|Post)/, `${file} e helper e nao deve exportar onRequest (viraria rota publica)`);
      assert.match(cjs, /module\.exports/, `${file} (CJS) deve exportar helpers via module.exports`);
      assert.match(esm, /export (?:async )?function/, `${file} (ESM) deve usar export de function`);
      assert.doesNotMatch(esm, /require\(/, `${file} (ESM) nao deve usar require`);
      continue;
    }

    assert.match(cjs, /exports\.handler/, `${file} (CJS) deve exportar handler`);
    assert.match(esm, /onRequest(?:Get|Post)/, `${file} (ESM) deve exportar onRequestGet/onRequestPost`);
    assert.match(esm, /export (?:async )?function/, `${file} (ESM) deve usar export de function`);
    assert.doesNotMatch(esm, /require\(/, `${file} (ESM) nao deve usar require`);
  }
});

test('helpers declarados batem com o grafo de imports', () => {
  // Nenhum arquivo pode ser helper sem ninguem importar. Se o unico importador
  // sumir, o arquivo vira rota orfa e o teste de handler passa a exigir um
  // handler que ninguem pediu.
  const cjsImports = importedBy(CJS_DIR);
  const esmImports = importedBy(ESM_DIR);
  for (const file of list(CJS_DIR)) {
    if (!isHelper(file)) continue;
    const esmName = ESM_NAME_OF(file);
    assert.ok(
      cjsImports.has(file) || esmImports.has(esmName),
      `${file} esta em HELPERS mas ninguem o importa em nenhum dos dialetos (dead code ou rota_orfa)`,
    );
  }
});

test('todo endpoint importado seria um bug de roteamento', () => {
  // O inverso do anterior: se um NAO-helper e importado por outro arquivo, ele
  // esta sendo usado como modulo e nao como rota — entao deveria estar em HELPERS.
  const cjsImports = importedBy(CJS_DIR);
  for (const file of list(CJS_DIR)) {
    if (isHelper(file)) continue;
    assert.ok(
      !cjsImports.has(file),
      `${file} nao esta em HELPERS mas e importado por ${[...cjsImports].filter((x) => x === file).join(',')} — classifique-o como helper`,
    );
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