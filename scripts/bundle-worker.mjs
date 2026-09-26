// Gera out/_worker.js: um unico arquivo autocontido com o adaptador
// (worker/main.js) e os 20 handlers CJS de netlify/functions/ inlineados.
//
// Por que isso existe: o runtime dos Workers nao tem sistema de arquivos, o
// worker nao consegue require() os handlers em runtime. Static imports + bundle
// resolvem: o esbuild ve os imports literais de worker/main.js e cola tudo em
// um arquivo so, que o Pages executa como Advanced Mode a partir da raiz de
// publicacao (out/).
//
// process.env -> globalThis.__PYV_ENV: os handlers leem process.env.*, mas
// escrever em process.env no Workers nao e portavel. O define troca a
// expressao por um objeto que o worker popula com as env vars do Pages a cada
// request.
//
// Rode via `npm run postbuild` (o npm chama postbuild depois de build).

import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENTRY = 'worker/main.js';
const OUT = 'out/_worker.js';
const CRYPTO_SHIM = fileURLToPath(new URL('../worker/shims/crypto.js', import.meta.url));

await build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  // neutral: nao assume browser nem node, nao injeta polyfill de process.
  platform: 'neutral',
  // neutral ignora o campo "main" por padrao, e os pacotes do Supabase
  // (functions-js, realtime-js) so declaram "main". Sem isto o bundle quebra
  // com "Could not resolve @supabase/functions-js".
  mainFields: ['module', 'main'],
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  // Built-ins resolvidos pelo runtime via nodejs_compat, nao bundled.
  external: ['node:*', 'crypto', 'fs', 'path', 'buffer', 'stream', 'util', 'os', 'url'],
  // process.env NAO e substituido aqui de proposito: com nodejs_compat o
  // runtime o popula com as env vars e secrets do Pages. Ver worker/main.js.
  plugins: [{
    // require('crypto') nos handlers CJS -> shim que reexporta node:crypto por
    // import estatico. Sem isto o esbuild gera o stub de require dinamico, que
    // lanca em runtime.
    name: 'crypto-shim',
    setup(build) {
      build.onResolve({ filter: /^crypto$/ }, () => ({ path: CRYPTO_SHIM }));
    },
  }],
  logLevel: 'warning',
});

// Falha cedo e com mensagem clara: um bundle que nao saiu e um deploy que sobe
// sem backend nenhum, silenciosamente.
const bytes = statSync(OUT).size;
if (bytes < 1000) {
  throw new Error(`bundle suspeito: ${OUT} tem apenas ${bytes} bytes`);
}
console.log(`worker: ${OUT} (${(bytes / 1024).toFixed(1)} kB, autocontido)`);
