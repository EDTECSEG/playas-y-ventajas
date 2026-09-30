'use strict';

// Contrato dos handlers em netlify/functions (CJS, canonico).
//
// Este arquivo nasceu como tests/consistency.test.cjs, que comparava cada
// handler CJS com um espelho ESM em functions/.netlify/functions. Esse espelho
// foi removido em 2026-09-30: nao havia consumidor em runtime (o unico alvo de
// deploy e netlify.toml, e scripts/bundle-worker.mjs inlina os handlers CJS),
// nao existe wrangler.toml, e o proprio teste so garantia a FORMA dos dois
// lados -- nunca o comportamento. Resultado: o espelho ficou desatualizado sem
// que nenhum teste reclamasse (a _wa.js do espelho ainda mandava a saudacao
// antiga e o codigo curto, meses depois de o canonico ter mudado).
//
// O que sobrou aqui sao as verificacoes que NAO dependiam do espelho e
// continuam valendo para a fonte unica.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers.cjs');

const CJS_DIR = path.join(ROOT, 'netlify', 'functions');
const IGNORE = ['package.json'];

// Modulos compartilhados: nao sao rotas, entao nao devem exportar handler HTTP.
//
// Declarado explicitamente em vez de inferido do grafo de imports.
// O teste 'helpers declarados batem com o grafo de imports' cruza os dois, para
// um helper recem-criado nao poder ser esquecido aqui em silencio.
const HELPERS = new Set([
  '_supabaseAdmin.js', // cliente admin do Supabase + sessao + token de cliente
  '_shared.js',
  '_mapPlaces.js', // logica Overpass, compartilhada pelos dois handlers de mapa
  '_wa.js',
  '_notify.js', // base de notificacoes (fila/auditoria + adaptador no-op)
]);

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

test('o diretorio canonico e netlify/functions, e ele existe', () => {
  // netlify.toml aponta [functions] directory = "netlify/functions" e
  // scripts/bundle-worker.mjs inlina daqui. Se alguem mover os handlers, este
  // teste avisa antes do deploy quebrar em silencio.
  assert.ok(fs.existsSync(CJS_DIR), `netlify/functions nao existe: ${CJS_DIR}`);
  const netlifyToml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  assert.match(netlifyToml, /directory\s*=\s*"netlify\/functions"/,
    'netlify.toml precisa apontar [functions] para netlify/functions');
});

test('nao sobrou espelho de functions em outro diretorio', () => {
  // Regressao do espelho ESM removido: ele nao voltaria sozinho, mas voltar por
  // copia e barato e silencioso. Se alguem recriar a pasta, este teste falha.
  assert.ok(!fs.existsSync(path.join(ROOT, 'functions')),
    'functions/ reapareceu. O espelho ESM foi removido em 2026-09-30: a fonte '
    + 'unica e netlify/functions (CJS). Editar ou recriar o espelho faz as duas '
    + 'copias divergirem de novo, sem nenhum teste detectar.');
});

test('toda function exporta handler e nenhum helper exporta handler', () => {
  // O file-based routing do Netlify mapeia todo .js do diretorio para uma rota;
  // um helper exportando handler publicaria uma rota que carrega logica de
  // segredo sem servir para nada.
  for (const file of list(CJS_DIR)) {
    const src = fs.readFileSync(path.join(CJS_DIR, file), 'utf8');
    if (isHelper(file)) {
      assert.doesNotMatch(src, /exports\.handler/,
        `${file} e helper e nao deve exportar handler (viraria rota publica)`);
      assert.match(src, /module\.exports/, `${file} (helper) deve exportar via module.exports`);
      continue;
    }
    assert.match(src, /exports\.handler/, `${file} deve exportar handler`);
  }
});

test('helpers declarados batem com o grafo de imports', () => {
  // Nenhum arquivo pode ser helper sem ninguem importar. Se o unico importador
  // sumir, o arquivo vira rota orfa e o teste de handler passa a exigir um
  // handler que ninguem pediu.
  const cjsImports = importedBy(CJS_DIR);
  for (const file of list(CJS_DIR)) {
    if (!isHelper(file)) continue;
    assert.ok(
      cjsImports.has(file),
      `${file} esta em HELPERS mas ninguem importa (dead code ou rota orfa)`,
    );
  }
});

test('todo endpoint importado seria um bug de roteamento', () => {
  // O inverso do anterior: se um NAO-helper e importado por outro arquivo, ele
  // esta sendo usado como modulo e nao como rota - entao deveria estar em HELPERS.
  const cjsImports = importedBy(CJS_DIR);
  for (const file of list(CJS_DIR)) {
    if (isHelper(file)) continue;
    assert.ok(
      !cjsImports.has(file),
      `${file} nao esta em HELPERS mas e importado por ${[...cjsImports].filter((x) => x === file).join(',')} - classifique-o como helper`,
    );
  }
});

test('o helper de admin expoe os nomes canonicos', () => {
  const src = fs.readFileSync(path.join(CJS_DIR, '_supabaseAdmin.js'), 'utf8');
  for (const name of ['getSupabaseAdminClient', 'resolveSession', 'extractSessionToken', 'buildCustomerToken', 'verifyCustomerToken']) {
    assert.match(src, new RegExp(name), `_supabaseAdmin.js deve expor ${name}`);
  }
});

test('nenhum arquivo expoe chave secreta (service role / token em texto)', () => {
  const secrets = ['SUPABASE_SERVICE_ROLE_KEY =', 'service_role', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'];
  for (const file of list(CJS_DIR)) {
    const source = fs.readFileSync(path.join(CJS_DIR, file), 'utf8');
    for (const s of secrets) {
      assert.doesNotMatch(source, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${file} nao deve conter segredo`);
    }
  }
});
