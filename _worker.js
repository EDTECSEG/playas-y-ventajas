// Cloudflare Pages - Advanced Mode (_worker.js)
// Roteia /.netlify/functions/<nome> para os handlers Netlify REAIS em
// netlify/functions/<nome>.js. Injeta process.env a partir de context.env
// (env vars do Pages) ANTES de dar require no handler. Converte o contrato
// Netlify ({ statusCode, body }) em um Response (Workers). Nenhuma logica
// duplicada: somente um adaptador de protocolo. Requer
// compatibility_flags = ["nodejs_compat"] no painel.
// ----------------------------------------------------------------------------
// ESTA LISTA E A WHITELIST DE ROTAS. Em Advanced Mode o file-based routing do
// Cloudflare NAO se aplica: o que nao estiver aqui retorna 404. Endpoint novo
// em netlify/functions/ que nao for adicionado aqui simplesmente nao existe
// em producao — foi o caso dos 7 endpoints de motorista ate esta leva.
//
// Helpers (prefixo _) NAO devem entrar aqui. Um handler em helper vira rota
// publica; foi o que mantinha /_supabaseAdmin e /_resend exposte. Eles saem
// desta lista de proposito: sao modulos, nao endpoints.
// ----------------------------------------------------------------------------
// ENV VARS que devem existir no Pages (Settings -> Variables):
//   RESEND_API_KEY, RESEND_FROM, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ----------------------------------------------------------------------------

const HANDLER_NAMES = [
  // Endpoints de negocio.
  'admin', 'claim-coupon', 'empresa', 'identify', 'login', 'offers', 'radar',
  'send-otp', 'upload-image', 'validate-coupon', '_verify-email',
  // Cadastro/autenticacao de empresa por email + OTP.
  'login-by-email', 'register-business-by-email',
  // Fluxo do motorista: registro, PIN, sessao, documento, aprovacao, convite.
  'driver-register', 'driver-set-pin', 'driver-login', 'driver-logout',
  'business-driver-invite', 'driver-review-document',
  // 'driver-add-document' NAO esta de proposito: o doc_url ainda nao e
  // amarrado ao resultado do upload, entao aceitaria URL arbitraria.
  // Entra na allowlist no mesmo commit que fizer o binding.
];
const AVAILABLE = new Set(HANDLER_NAMES);

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // 1) Injeta env vars do Pages em process.env (os helpers leem process.env.*)
      if (env && typeof env === 'object') {
        for (const [k, v] of Object.entries(env)) {
          if (process.env[k] === undefined) process.env[k] = String(v);
        }
      }

      const path = url.pathname;
      const m = path.match(/^\/\.netlify\/functions\/([a-z0-9-]+)\/?$/);
      if (!m) return json(404, { error: 'rota desconhecida: ' + path });

      const name = m[1];
      if (!AVAILABLE.has(name)) return json(404, { error: 'funcao desconhecida: ' + name });

      // 2) Monta o event no formato Netlify (handler espera event.httpMethod, etc.)
      const headers = {};
      request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const event = {
        httpMethod: request.method,
        body: '',
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers,
      };
      if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
        event.body = await request.text();
      }

      // 3) Carrega o MODULO REAL (handlers de raiz: netlify/functions/<name>.js)
      let mod;
      try {
        const { createRequire } = await import('node:module');
        const require = createRequire(import.meta.url);
        const base = './netlify/functions/' + name + '.js';
        mod = require(base);
      } catch (err) {
        return json(500, { error: 'falha ao carregar handler: ' + err.message });
      }

      const fn = mod && (mod.handler || (mod.default && mod.default.handler));
      if (typeof fn !== 'function') {
        return json(500, { error: 'handler sem exports.handler em ' + name });
      }

      // 4) Executa e converte a resposta Netlify -> Response
      const netlifyRes = await fn(event, {});
      const status = (netlifyRes && netlifyRes.statusCode) || 200;
      let body = netlifyRes && netlifyRes.body;
      if (body && typeof body === 'object') body = JSON.stringify(body);
      return new Response(body || '', {
        status,
        headers: { 'content-type': 'application/json', ...CORS_HEADERS },
      });
    } catch (err) {
      return json(500, { error: err.message });
    }
  },
};
