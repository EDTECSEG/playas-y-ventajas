// Apaga PDFs de motorista via Storage API, para quando um E2E live falha no
// meio e deixa arquivo para tras.
//
// `storage.objects` recusa DELETE direto por SQL (storage.protect_delete), entao
// a limpeza passa pela Storage API. Nao imprime a service role key.
//
// Uso:
//   node scripts/limpar-storage-teste.mjs <driverId> [driverId...]
//   node scripts/limpar-storage-teste.mjs --listar
//
// Sem argumento o script nao faz nada e explica o uso, em vez de varrer o
// bucket: apagar arquivo de motorista real por engano e pior do que deixar
// lixo. Para achar o que sobrou, o proprio script lista o que existe.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const env = Object.fromEntries(
  readFileSync(path.join(process.cwd(), '.dev.vars'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('  NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes em .dev.vars');
  process.exit(1);
}

// Bucket PRIVADO de documento. Antes o upload ia para `pyv-images` (publico),
// com o prefixo `driver-documents/`. Os dois mudaram junto.
const BUCKET = 'driver-documents';
const TENANT = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function listar(prefix) {
  const r = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 200 }),
  });
  if (!r.ok) throw new Error(`listagem falhou: ${r.status}`);
  return (await r.json()) ?? [];
}

async function apagar(prefix) {
  const objs = await listar(prefix);
  let total = 0;
  for (const o of objs) {
    // a listagem devolve `name` so com o basename; o caminho completo precisa
    // do prefixo remontado, senao o DELETE responde 404 NoSuchKey
    const caminho = `${prefix}${o.name}`;
    const del = await fetch(`${url}/storage/v1/object/${BUCKET}/${caminho}`, {
      method: 'DELETE',
      headers,
    });
    console.log(`  ${del.status} ${del.ok ? 'removido' : 'FALHOU'}  ${caminho}`);
    if (del.ok) total++;
  }
  return total;
}

const args = process.argv.slice(2);

if (!args.length) {
  console.log('  uso: node scripts/limpar-storage-teste.mjs <driverId> [driverId...]');
  console.log('       node scripts/limpar-storage-teste.mjs --listar');
  console.log('');
  const existentes = await listar(`${TENANT}/`);
  if (!existentes.length) {
    console.log('  nada sob o prefixo do tenant: nada a fazer');
  } else {
    console.log(`  ${existentes.length} objeto(s) presente(s). Pastas por driver:`);
    const pastas = new Set(existentes.map((o) => o.name.split('/')[0]));
    for (const p of pastas) console.log(`    ${TENANT}/${p}/`);
  }
  process.exit(0);
}

if (args[0] === '--listar') {
  const existentes = await listar(`${TENANT}/`);
  console.log(`  ${existentes.length} objeto(s) sob ${BUCKET}/${TENANT}/`);
  for (const o of existentes) console.log(`    ${o.name}`);
  process.exit(0);
}

let total = 0;
for (const driverId of args) {
  total += await apagar(`${TENANT}/${driverId}/`);
}
console.log(`  ${total} arquivo(s) removido(s)`);

const restantes = await listar(`${TENANT}/`);
console.log(`  objetos restantes sob ${BUCKET}/${TENANT}/: ${restantes.length}`);
