'use strict';

// E2E AO VIVO do caminho feliz da aprovacao de motorista:
// empresa loga -> cadastro do motorista -> PIN -> documento ->
// login bloqueado -> empresa aprova -> login liberado.
//
// Desabilitado por padrao. Para rodar:
//   PowerShell:  $env:RUN_LIVE=1; npm run test:live:approval
//
// Este teste CRIA e APAGA dados em producao: um cadastro de motorista, um
// documento no storage e uma sessao. O cleanup roda no `after()` mesmo se
// alguma assercao falhar no meio.
//
// O OTP de empresa e STATELESS (netlify/functions/_otp.js): e
// HMAC-SHA256("email|janela de 5min") usando a SUPABASE_SERVICE_ROLE_KEY como
// segredo, sem tabela. Por isso calculamos o codigo localmente em vez de ler o
// email. `login-by-email` so VALIDA o codigo, nao envia nada, entao nenhum
// email sai daqui. E o dominio do Resend ainda nao esta verificado, o que
// impediria o login por email mesmo.
//
// A service role e lida de .dev.vars e NUNCA e impressa.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { createHmac } = require('node:crypto');

const BASE = process.env.LIVE_BASE || 'https://playas-y-ventajas.pages.dev';
const SLUG = 'playas-y-ventajas';
const BUSINESS_EMAIL = process.env.LIVE_BUSINESS_EMAIL || 'edtecseglagos@gmail.com';
const PIN = '4821';

// `path.join(__dirname, '..')` e nao '.dev.vars': assim funciona independente
// de onde o comando for executado.
const repoRoot = path.join(__dirname, '..');

const enabled = () => process.env.RUN_LIVE === '1'
  ? false
  : 'habilite com RUN_LIVE=1 para rodar contra producao';

function lerEnv() {
  const arquivo = path.join(repoRoot, '.dev.vars');
  if (!fs.existsSync(arquivo)) return {};
  return Object.fromEntries(
    fs.readFileSync(arquivo, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      })
  );
}

// mesmo algoritmo de netlify/functions/_otp.js
function buildOtpCode(secret, email, bucket) {
  const hex = createHmac('sha256', secret)
    .update(`${String(email).trim().toLowerCase()}|${bucket}`)
    .digest('hex');
  return String(parseInt(hex.slice(0, 8), 16) % 1000000).padStart(6, '0');
}

async function post(nome, body, token) {
  const res = await fetch(`${BASE}/.netlify/functions/${nome}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function get(nome, query, token) {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${BASE}/.netlify/functions/${nome}${qs}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// estado compartilhado entre os passos, que sao estritamente sequenciais.
// Tudo fica dentro de um `describe` de proposito: no Node 22 um `before` na
// raiz do arquivo NAO roda antes de `test` na raiz — so ancora dentro de uma
// suite. Sem o describe, o `before` nao executa e `ctx.otp` chega undefined.
const ctx = {};

// `describe` nao aceita `skip`, entao o guard fica em cada `test` e no
// `before`. `enabled()` reavaliado a cada passo, sem estado global.
describe('aprovacao de motorista: caminho feliz', { skip: enabled() }, () => {
  before(() => {
    const env = lerEnv();
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY ausente em .dev.vars');
    }
    ctx.env = env;
    ctx.otp = buildOtpCode(
      env.SUPABASE_SERVICE_ROLE_KEY,
      BUSINESS_EMAIL,
      Math.floor(Date.now() / 1000 / 300)
    );
    // telefone e email ineditos: o banco rejeita telefone e email repetidos
    // por tenant, entao um valor fixo so funcionaria na primeira execucao
    const sufixo = Date.now().toString().slice(-9);
    ctx.fone = `55119${sufixo}`;
    ctx.emailMotorista = `qa.aprovacao.${sufixo}@exemplo.com`;
    ctx.pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
      'latin1'
    ).toString('base64');
  });

  test('empresa autentica por OTP', async () => {
    const r = await post('login-by-email', {
      tenantSlug: SLUG, email: BUSINESS_EMAIL, emailOtp: ctx.otp,
    });
    assert.strictEqual(r.status, 200, `login-by-email: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.sessionToken, 'deve vir sessionToken');
    assert.ok(r.body.businessId, 'deve vir businessId');
    assert.ok(r.body.tenantId, 'deve vir tenantId');
    ctx.sessaoEmpresa = r.body.sessionToken;
    ctx.businessId = r.body.businessId;
    ctx.tenantId = r.body.tenantId;
  });

  test('sessao da empresa e aceita no painel e negada sem token', async () => {
    const com = await fetch(`${BASE}/.netlify/functions/empresa?mode=stats`, {
      headers: { Authorization: `Bearer ${ctx.sessaoEmpresa}` },
    });
    assert.strictEqual(com.status, 200, 'painel deve aceitar a sessao');
    const sem = await fetch(`${BASE}/.netlify/functions/empresa?mode=stats`);
    assert.strictEqual(sem.status, 401, 'painel sem sessao deve negar');
  });

  test('motorista se cadastra vinculado a empresa', async () => {
    const r = await post('driver-register', {
      tenantId: ctx.tenantId,
      name: 'Teste Aprovacao Live',
      phone: ctx.fone,
      email: ctx.emailMotorista,
      businessId: ctx.businessId,
    });
    assert.strictEqual(r.status, 200, `driver-register: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.driverId, 'deve vir driverId');
    assert.ok(r.body.pinToken, 'deve vir pinToken');
    assert.ok(r.body.uploadToken, 'deve vir uploadToken');
    ctx.driverId = r.body.driverId;
    ctx.pinToken = r.body.pinToken;
    ctx.uploadToken = r.body.uploadToken;
  });

  test('pinToken e de uso unico', async () => {
    const ok = await post('driver-set-pin', {
      tenantId: ctx.tenantId, phone: ctx.fone, pin: PIN, pinToken: ctx.pinToken,
    });
    assert.strictEqual(ok.status, 200, `driver-set-pin: ${JSON.stringify(ok.body)}`);

    // replay do mesmo token tem de falhar
    const replay = await post('driver-set-pin', {
      tenantId: ctx.tenantId, phone: ctx.fone, pin: '9999', pinToken: ctx.pinToken,
    });
    assert.strictEqual(replay.status, 401, 'pinToken nao pode ser reusado');
    assert.strictEqual(replay.body.error, 'TOKEN_INVALID');
  });

  test('documento e aceito e enviado ao bucket', async () => {
    const r = await post('driver-add-document', {
      tenantId: ctx.tenantId,
      driverId: ctx.driverId,
      docType: 'cnh',
      fileBase64: ctx.pdf,
      contentType: 'application/pdf',
      docNumber: '98765432100',
      uploadToken: ctx.uploadToken,
    });
    assert.strictEqual(r.status, 200, `driver-add-document: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.documentId, 'deve vir documentId');
    ctx.documentId = r.body.documentId;
  });

  test('login e recusado antes da aprovacao', async () => {
    const r = await post('driver-login', { tenantId: ctx.tenantId, phone: ctx.fone, pin: PIN });
    assert.strictEqual(r.status, 403, 'pendente nao pode entrar');
    assert.strictEqual(r.body.error, 'PENDING_APPROVAL');
  });

  // --- a parte que faltava: a empresa precisa poder VER o que tem para aprovar.

  test('empresa ve o motorista pendente na listagem', async () => {
    const r = await get('driver-list-for-business', { status: 'pending' }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200, `driver-list-for-business: ${JSON.stringify(r.body)}`);

    const meu = r.body.drivers.find((d) => d.driverId === ctx.driverId);
    assert.ok(meu, 'o cadastro pendente deve aparecer para a empresa dona');
    assert.strictEqual(meu.status, 'pending');

    const doc = meu.documents.find((d) => d.id === ctx.documentId);
    assert.ok(doc, 'o documento enviado deve aparecer na pendencia');
    assert.strictEqual(doc.docType, 'cnh');
    assert.strictEqual(doc.status, 'pending');
  });

  test('a listagem nao entrega caminho nem URL do arquivo', async () => {
    const r = await get('driver-list-for-business', {}, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200);
    const bruto = JSON.stringify(r.body);
    assert.ok(!bruto.includes('docPath'), 'listagem nao pode conter docPath');
    assert.ok(!bruto.includes('doc_url'), 'listagem nao pode conter doc_url');
    assert.ok(!/https?:\/\//.test(bruto), 'listagem nao pode conter URL de arquivo');
  });

  test('listagem sem sessao nao devolve nada', async () => {
    const sem = await get('driver-list-for-business', {});
    assert.strictEqual(sem.status, 401, 'listagem sem token precisa negar');
  });

  test('documento sai como URL assinada que entrega o PDF', async () => {
    const r = await get('driver-document-url', { documentId: ctx.documentId }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200, `driver-document-url: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.expiresIn, 300, 'validade deve ser 5 minutos');
    assert.ok(r.body.url, 'deve vir uma URL assinada');
    assert.ok(!r.body.url.includes('token=') === false, 'URL assinada carrega token');
    ctx.urlAssinada = r.body.url;

    // a URL precisa realmente servir o PDF, e nao um 200 de pagina de erro
    const arquivo = await fetch(r.body.url);
    assert.strictEqual(arquivo.status, 200, 'a URL assinada deve entregar o arquivo');
    const bytes = Buffer.from(await arquivo.arrayBuffer());
    assert.strictEqual(bytes.toString('latin1', 0, 5), '%PDF-', 'o conteudo deve ser o PDF enviado');
  });

  test('documento exige sessao: sem token e com token invalido, nada de URL', async () => {
    const sem = await get('driver-document-url', { documentId: ctx.documentId });
    assert.strictEqual(sem.status, 401, 'sem sessao precisa negar');
    assert.ok(!JSON.stringify(sem.body).includes('http'), 'recusa nao pode conter URL');

    const invalido = await get('driver-document-url', { documentId: ctx.documentId }, 'token-que-nao-existe');
    assert.strictEqual(invalido.status, 401, 'token invalido precisa negar');
    assert.ok(!JSON.stringify(invalido.body).includes('http'), 'recusa nao pode conter URL');
  });

  test('o banco guarda o path do documento, nao uma URL publica', async () => {
    const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = ctx.env;
    const res = await fetch(
      `${url}/rest/v1/driver_documents?id=eq.${ctx.documentId}&select=doc_url`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const linhas = await res.json();
    assert.strictEqual(linhas.length, 1, 'o documento deveria existir');
    const guardado = linhas[0].doc_url;
    assert.ok(!/^https?:\/\//.test(guardado), `doc_url nao pode ser URL: ${guardado}`);
    assert.ok(guardado.startsWith('driver-documents/'), `doc_url deveria ser path do bucket: ${guardado}`);
  });

  test('empresa aprova o documento', async () => {
    const r = await post('driver-review-document', {
      documentId: ctx.documentId, action: 'approve',
    }, ctx.sessaoEmpresa);
    assert.strictEqual(r.status, 200, `driver-review-document: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.documentStatus, 'approved');
    assert.strictEqual(r.body.driverStatus, 'approved');
  });

  test('login do motorista e aceito depois da aprovacao', async () => {
    const r = await post('driver-login', { tenantId: ctx.tenantId, phone: ctx.fone, pin: PIN });
    assert.strictEqual(r.status, 200, `driver-login: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, 'approved');
    // a chave e `sessionToken`, devolvida pela RPC driver_login. O comentario no
    // topo de driver-login.js falava `driverSessionToken`, que nao existe.
    assert.ok(r.body.sessionToken, 'deve vir sessionToken');
    ctx.sessaoMotorista = r.body.sessionToken;
  });

  test('sessao do motorista e credencial real e nao adulteravel', async () => {
    const valida = await post('driver-add-document', {
      tenantId: ctx.tenantId,
      driverId: ctx.driverId,
      docType: 'rg',
      fileBase64: ctx.pdf,
      contentType: 'application/pdf',
      docNumber: '55544433322',
    }, ctx.sessaoMotorista);
    assert.strictEqual(valida.status, 200, `sessao valida: ${JSON.stringify(valida.body)}`);

    const ultimo = ctx.sessaoMotorista.slice(-1);
    const adulterado = ctx.sessaoMotorista.slice(0, -1) + (ultimo === 'a' ? 'b' : 'a');
    const falsa = await post('driver-add-document', {
      tenantId: ctx.tenantId,
      driverId: ctx.driverId,
      docType: 'crv',
      fileBase64: ctx.pdf,
      contentType: 'application/pdf',
    }, adulterado);
    assert.notStrictEqual(falsa.status, 200, 'sessao adulterada nao pode passar');
  });

  // cleanup: roda mesmo com falha acima, para nao deixar cadastro nem PDF em
  // producao. `storage.objects` recusa DELETE direto por SQL
  // (storage.protect_delete), entao os arquivos saem pela Storage API.
  after(async () => {
    if (!ctx.driverId || !ctx.env) return;

    const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key } = ctx.env;
    const bucket = 'driver-documents';
    const prefix = `${ctx.tenantId}/${ctx.driverId}/`;

    try {
      const lista = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix, limit: 100 }),
      });
      const objetos = (await lista.json()) ?? [];
      for (const o of objetos) {
        // a listagem devolve `name` so com o basename; sem remontar o prefixo o
        // DELETE responde 404 NoSuchKey
        await fetch(`${url}/storage/v1/object/${bucket}/${prefix}${o.name}`, {
          method: 'DELETE',
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
      }
      console.log(`    cleanup: ${objetos.length} arquivo(s) removido(s) do storage`);
    } catch (e) {
      console.error(`    cleanup do storage falhou: ${e.message}`);
    }

    const del = await fetch(`${url}/rest/v1/drivers?id=eq.${ctx.driverId}`, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    console.log(
      `    cleanup: cadastro ${del.ok ? 'removido' : `NAO removido (${del.status})`}` +
      (del.ok ? '' : ` — remover ${ctx.driverId} (telefone ${ctx.fone})`)
    );
  });
});
