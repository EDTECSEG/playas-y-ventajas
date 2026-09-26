// Cloudflare Pages - Advanced Mode (fonte do bundle que vira out/_worker.js)
//
// Roteia /.netlify/functions/<nome> para os handlers Netlify REAIS em
// netlify/functions/<nome>.js. Nenhuma logica de negocio e duplicada aqui:
// este arquivo e so o adaptador de protocolo Netlify -> Workers.
//
// Por que os handlers sao import ESTATICO e nao carregados por require():
// o runtime dos Workers nao tem sistema de arquivos. A versao anterior
// fazia createRequire(import.meta.url) + require('./netlify/functions/x.js')
// e falhava em producao com
//   "falha ao carregar handler: The argument 'path' ... Received 'undefined'"
// porque import.meta.url e undefined e nao existe caminho de arquivo para
// resolver. Aqui cada handler entra por import literal, o esbuild inlina
// todos em um unico out/_worker.js no build (scripts/bundle-worker.mjs), e o
// worker so precisa chamar a funcao.
//
// Requer compatibility_flags = ["nodejs_compat"] no Pages, porque os handlers
// usam node:crypto.
// ----------------------------------------------------------------------------
// ESTA LISTA E A WHITELIST DE ROTAS. Em Advanced Mode o file-based routing do
// Cloudflare NAO se aplica: o que nao estiver no mapa ROUTES retorna 404.
// Endpoint novo em netlify/functions/ que nao for adicionado aqui
// simplesmente nao existe em producao.
// ----------------------------------------------------------------------------
// Helpers (prefixo _) NAO entram aqui, por dois motivos:
//   1) um handler em helper vira rota publica; foi o que mantinha
//      /_supabaseAdmin e /_resend expostas.
//   2) a regex de rota aceita apenas [a-z0-9-], entao um nome com underscore
//      nunca casa. Os helpers ficam inalcancaveis por construcao.
// _verify-email saiu da lista: ele exige fs e path (netlify/functions/
// _verify-email.js), que nao existem no Workers. Nao e um ajuste de
// allowlist, e uma impossibilidade de plataforma.
// ----------------------------------------------------------------------------
// ENV VARS que devem existir no Pages (Settings -> Variables):
//   RESEND_API_KEY, RESEND_FROM, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (build script rewrites process.env para globalThis.__PYV_ENV, preenchido
//  a partir de env em cada request.)

import admin from '../netlify/functions/admin.js';
import claimCoupon from '../netlify/functions/claim-coupon.js';
import empresa from '../netlify/functions/empresa.js';
import identify from '../netlify/functions/identify.js';
import login from '../netlify/functions/login.js';
import offers from '../netlify/functions/offers.js';
import radar from '../netlify/functions/radar.js';
import sendOtp from '../netlify/functions/send-otp.js';
import uploadImage from '../netlify/functions/upload-image.js';
import validateCoupon from '../netlify/functions/validate-coupon.js';
import loginByEmail from '../netlify/functions/login-by-email.js';
import registerBusinessByEmail from '../netlify/functions/register-business-by-email.js';
import driverRegister from '../netlify/functions/driver-register.js';
import driverSetPin from '../netlify/functions/driver-set-pin.js';
import driverLogin from '../netlify/functions/driver-login.js';
import driverLogout from '../netlify/functions/driver-logout.js';
import businessDriverInvite from '../netlify/functions/business-driver-invite.js';
import driverReviewDocument from '../netlify/functions/driver-review-document.js';

// driver-add-document NAO esta aqui de proposito: o doc_url ainda nao e
// amarrado ao resultado do upload, entao aceitaria URL arbitraria. Entra
// junto com o binding do doc_url.

const ROUTES = {
  // Endpoints de negocio.
  admin,
  'claim-coupon': claimCoupon,
  empresa,
  identify,
  login,
  offers,
  radar,
  'send-otp': sendOtp,
  'upload-image': uploadImage,
  'validate-coupon': validateCoupon,
  // Cadastro/autenticacao de empresa por email + OTP.
  'login-by-email': loginByEmail,
  'register-business-by-email': registerBusinessByEmail,
  // Fluxo do motorista: registro, PIN, sessao, aprovacao, convite.
  'driver-register': driverRegister,
  'driver-set-pin': driverSetPin,
  'driver-login': driverLogin,
  'driver-logout': driverLogout,
  'business-driver-invite': businessDriverInvite,
  'driver-review-document': driverReviewDocument,
};

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
  async fetch(request, env) {
    const url = new URL(request.url);

    // Os handlers leem process.env.*. O build troca process.env por
    // globalThis.__PYV_ENV (ver scripts/bundle-worker.mjs), entao popular
    // este objeto com as env vars do Pages e o equivalente correto sem
    // depender da semântica de escrita de process.env no Workers.
    const target = (globalThis.__PYV_ENV = globalThis.__PYV_ENV || {});
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) target[k] = String(v);
    }

    try {
      const path = url.pathname;
      // Sem underscore: e o que mantem os helpers inalcancaveis.
      const m = path.match(/^\/\.netlify\/functions\/([a-z0-9-]+)\/?$/);
      if (!m) return json(404, { error: 'rota desconhecida: ' + path });

      const name = m[1];
      const mod = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
      if (!mod) return json(404, { error: 'funcao desconhecida: ' + name });

      const fn = mod.handler || (mod.default && mod.default.handler);
      if (typeof fn !== 'function') {
        return json(500, { error: 'handler sem exports.handler em ' + name });
      }

      // Monta o event no formato Netlify (handler espera event.httpMethod etc.)
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
