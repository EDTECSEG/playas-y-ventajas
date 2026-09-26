// Servidor estatico minimo para o out/ do export estatico. Existe para
// reproduzir em local a condicao que derrubava /cliente: o endpoint de
// ofertas responde com erro, e a pagina precisa mostrar a mensagem em vez de
// quebrar. Nao e parte da suite; e ferramenta de verificacao.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const root = join(process.cwd(), 'out');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const port = Number(process.argv[2] || 8099);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const base = join(root, rel);
  if (!base.startsWith(root)) {
    res.writeHead(400).end('bad path');
    return;
  }
  const candidates = [base, `${base}.html`, join(base, 'index.html')];
  for (const file of candidates) {
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
      res.end(body);
      return;
    } catch { /* proximo candidato */ }
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'nao encontrado' }));
}).listen(port, () => {
  console.log(`out/ em http://localhost:${port}`);
});
