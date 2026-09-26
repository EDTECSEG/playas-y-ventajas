// Apaga os PDFs dos motoristas de teste via Storage API.
// storage.objects recusa DELETE direto por SQL (storage.protect_delete).
// Nao imprime a service role key.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.dev.vars', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = 'pyv-images';
const tenant = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';
const drivers = [
  'e1a3c2f9-a952-41e6-acc4-45f6a0c57bbb',
  'b6fb1459-78f5-47d2-aea3-0510603d1cbb',
];

let total = 0;
for (const d of drivers) {
  const prefix = `driver-documents/${tenant}/${d}/`;
  const r = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 100 }),
  });
  const objs = (await r.json()) ?? [];
  for (const o of objs) {
    // a listagem devolve `name` so com o basename; o caminho completo precisa
    // do prefixo remontado, senao o DELETE responde 404 NoSuchKey
    const caminho = `${prefix}${o.name}`;
    const del = await fetch(`${url}/storage/v1/object/${bucket}/${caminho}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    console.log(`  ${del.status} ${del.ok ? 'removido' : 'FALHOU'}  ${caminho.split('/').slice(-2).join('/')}`);
    if (del.ok) total++;
  }
}
console.log(`  ${total} arquivo(s) removido(s)`);

// confirma que a pasta ficou vazia
const conf = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
  method: 'POST',
  headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ prefix: `driver-documents/${tenant}/`, limit: 100 }),
});
const restantes = (await conf.json()) ?? [];
console.log(`  objetos restantes sob driver-documents/: ${restantes.length}`);
