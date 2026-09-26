'use strict';

// Testa o fallback de estatico do adaptador em out/_worker.js.
//
// O postbuild coloca _worker.js dentro de out/, o que joga o projeto no modo
// avancado do Pages. Nesse modo o Worker intercepta toda requisicao, e sem um
// delegate para env.ASSETS nenhuma pagina e servida: o jeito anterior
// respondia "rota desconhecida" para /, /empresa e /motorista, e o site inteiro
// ficava fora do ar enquanto as rotas de funcao continuavam respondendo normal.
//
// O ASSETS e um binding do Cloudflare, entao aqui ele e falso: resolve o
// caminho contra o out/ de verdade, imitando a resolucao de html do Pages. Isso
// deixa o teste provar que /motorista acha o motorista.html de verdade, e nao
// so que o delegate foi chamado.
//
// Depende do bundle, entao roda depois de npm run build. Sem o arquivo, pula.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const BUNDLE = path.join(OUT, '_worker.js');
const SRC = path.join(ROOT, 'worker', 'main.js');

const semBundle = !fs.existsSync(BUNDLE) && 'bundle ainda nao construido (rode npm run build)';

// ASSETS falso: procura no out/ como o Pages procuraria, e devolve 404 do
// proprio Pages quando nao acha.
function assetsFalso(registrar) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (registrar) registrar.push(url.pathname);
      const candidatos = [
        url.pathname.replace(/^\//, ''),
        url.pathname.replace(/^\//, '') + '.html',
        url.pathname.replace(/^\//, '') + '/index.html',
      ];
      for (const c of candidatos) {
        const abs = path.join(OUT, c);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const body = fs.readFileSync(abs);
          const tipo = abs.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : abs.endsWith('.js')
              ? 'application/javascript'
              : 'application/octet-stream';
          return new Response(body, { status: 200, headers: { 'content-type': tipo } });
        }
      }
      return new Response('<h1>404</h1>', { status: 404, headers: { 'content-type': 'text/html' } });
    },
  };
}

function req(pathname, method) {
  return new Request('https://exemplo.pages.dev' + pathname, { method: method || 'GET' });
}

async function worker() {
  const mod = await import(pathToFileURL(BUNDLE).href);
  return mod.default;
}

test('pagina real do build e servida pelo delegate de estatico', { skip: semBundle }, async () => {
  const w = await worker();
  const chamadas = [];
  const env = { ASSETS: assetsFalso(chamadas) };

  for (const rota of ['/', '/motorista', '/empresa']) {
    const res = await w.fetch(req(rota), env);
    assert.strictEqual(res.status, 200, 'rota nao foi servida: ' + rota);
    assert.match(
      res.headers.get('content-type') || '',
      /text\/html/,
      'rota nao devolveu html: ' + rota,
    );
    assert.ok(chamadas.includes(rota), 'o delegate nao foi chamado para ' + rota);
  }
});

test('/motorista acha o motorista.html de verdade, e nao um 404 generico', { skip: semBundle }, async () => {
  const w = await worker();
  const res = await w.fetch(req('/motorista'), { ASSETS: assetsFalso([]) });
  const html = await res.text();
  assert.match(html, /Motorista/i, 'a pagina servida nao e a de motorista');
  assert.ok(!html.includes('rota desconhecida'), 'veio o json de rota desconhecida em vez da pagina');
});

test('o pedido delegado preserva metodo e caminho', { skip: semBundle }, async () => {
  const w = await worker();
  const vistas = [];
  const env = {
    ASSETS: {
      async fetch(r) {
        vistas.push({ method: r.method, path: new URL(r.url).pathname });
        return new Response('ok', { status: 200 });
      },
    },
  };
  await w.fetch(req('/_next/static/chunks/app.js'), env);
  await w.fetch(req('/api-qualquer', 'POST'), env);

  assert.strictEqual(vistas[0].method, 'GET');
  assert.strictEqual(vistas[0].path, '/_next/static/chunks/app.js');
  assert.strictEqual(vistas[1].method, 'POST', 'metodo se perde na delegacao');
  assert.strictEqual(vistas[1].path, '/api-qualquer');
});

test('rota de funcao ganha do estatico e nunca vira asset', { skip: semBundle }, async () => {
  const w = await worker();
  const chamadas = [];
  const env = { ASSETS: assetsFalso(chamadas) };

  // Allowlist: tem que responder a funcao, mesmo com um arquivo de mesmo nome.
  const ok = await w.fetch(req('/.netlify/functions/__envdiag'), env);
  assert.strictEqual(ok.status, 200);
  assert.ok(!chamadas.includes('/.netlify/functions/__envdiag'), 'envdiag foi delegado por engano');

  // Funcao inexistente tem que continuar 404 em json, nao cair no estatico.
  const inexistente = await w.fetch(req('/.netlify/functions/nao-existe-xyz'), env);
  assert.strictEqual(inexistente.status, 404);
  const body = await inexistente.json();
  assert.strictEqual(body.error, 'funcao desconhecida: nao-existe-xyz');
  assert.ok(!chamadas.includes('/.netlify/functions/nao-existe-xyz'), 'rota de funcao Caiu no estatico');
});

test('caminho com traversal e barrado antes do delegate', { skip: semBundle }, async () => {
  const w = await worker();
  const vistos = [];
  const env = {
    ASSETS: {
      async fetch(r) {
        vistos.push(new URL(r.url).pathname);
        return new Response('ok', { status: 200 });
      },
    },
  };

  // "/../../etc/passwd" e resolvido pelo proprio parsing da URL e chega
  // limpo: nao ha o que barrar, e o Worker nao resolve caminho nem toca em
  // disco, so entrega o pedido para o servidor de asset do Cloudflare.
  await w.fetch(req('/../../etc/passwd'), env);

  // "%2e%2e%2f" sobrevive como texto e chegaria ao delegate. Precisa de 400.
  const ataque = await w.fetch(req('/..%2f..%2fetc/passwd'), env);
  assert.strictEqual(ataque.status, 400, 'traversal em codigo passou pelo delegate');
  assert.deepStrictEqual(await ataque.json(), { error: 'caminho invalido' });

  const duplo = await w.fetch(req('/%2e%2e%2f%2e%2e%2fsecret'), env);
  assert.strictEqual(duplo.status, 400, 'variacao de codigo passou pelo delegate');

  // Percentagem quebrada tambem e 400, e nao 500.
  const quebrado = await w.fetch(req('/%E0%A4%A'), env);
  assert.strictEqual(quebrado.status, 400);

  assert.ok(
    vistos.every((p) => !p.includes('%2e') && !p.includes('%2f')),
    'caminho codificado chegou ao delegate: ' + JSON.stringify(vistos),
  );
});

test('sem o binding ASSETS o worker ainda responde 404 em json', { skip: semBundle }, async () => {
  // Desenvolvimento local e qualquer contexto onde o binding nao existe nao
  // podem estourar TypeError: o fallback tem que degradar, nao quebrar.
  const w = await worker();
  const res = await w.fetch(req('/'), {});
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error, 'rota desconhecida: /');
});

test('o proprio worker declara o fallback de estatico', () => {
  // Trava o bug: sem isso, uma refatoracao que tire o delegate volta a deixar
  // o site inteiro fora do ar sem nenhum teste falhar.
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(
    src.includes('ASSETS'),
    'worker/main.js nao menciona ASSETS: o site fica sem pagina em modo avancado',
  );
  assert.ok(
    /env\.ASSETS\.fetch|env\.ASSETS[\s\S]{0,80}?\.fetch\(request\)/.test(src),
    'worker/main.js nao delega a requisicao para env.ASSETS',
  );
});

test('o bundle construido tambem carrega o fallback', { skip: semBundle }, async () => {
  const src = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(src.includes('ASSETS'), 'o bundle em out/ nao menciona ASSETS');
});
