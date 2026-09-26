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
// ENV: com nodejs_compat, o runtime popula process.env sozinho
// (nodejs_compat_populate_process_env, padrao para compatibility_date >=
// 2025-04-01) com as env vars e secrets configurados no Pages. Os handlers
// leem process.env.* direto, sem adaptor.
//
// Nao substituir process.env por outro objeto aqui: a versao anterior usava
// define process.env -> globalThis.__PYV_ENV, populado a partir do 2o
// argumento do fetch. Em Pages esse argumento nao traz as env vars do projeto,
// entao admin e empresa respondiam 500 "Env vars ausentes" mesmo com as
// variaveis configuradas no painel.
// VARS esperadas: RESEND_API_KEY, RESEND_FROM, NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY

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

// ----------------------------------------------------------------------------
// DIAGNOSTICO TEMPORARIO de env vars. REMOVER assim que a causa do
// admin/empresa 500 "Env vars ausentes" estiver corrigida.
// ----------------------------------------------------------------------------
// Responde em /.netlify/functions/__envdiag mostrando por onde as env vars
// chegam (process.env ou os bindings do 2o argumento do fetch) e se cada
// uma esta preenchida. NUNCA devolve valor: apenas nome da variavel, se
// existe, se esta vazia e um booleano de formato. Nao ha como reconstruir
// um segredo a partir disso, mas mesmo assim o endpoint e temporario.
//
// Esta rota e tratada ANTES da regex [a-z0-9-]+ de proposito: o nome contem
// underscore, que a regex nao casa. E o mesmo mecanismo que mantem os
// helpers inalcancaveis, entao sem esse caso explicito ela seria 404.
const ENV_DIAG_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'RESEND_FROM',
];

const SUPAHOST_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/;

function envDiagReport(env) {
  const pe = typeof globalThis.process !== 'undefined' && globalThis.process.env
    ? globalThis.process.env
    : null;
  const bindings = env && typeof env === 'object' ? env : null;

  const describe = (bag) => {
    const out = {};
    for (const k of ENV_DIAG_VARS) {
      const v = bag ? bag[k] : undefined;
      out[k] = {
        presente: v !== undefined && v !== null,
        preenchida: typeof v === 'string' && v.length > 0,
      };
    }
    return out;
  };

  const urlLooksRight = (bag) => {
    const v = bag ? bag.NEXT_PUBLIC_SUPABASE_URL : undefined;
    return typeof v === 'string' && SUPAHOST_RE.test(v);
  };

  return {
    aviso: 'endpoint temporario de diagnostico, remover apos o uso',
    runtime: {
      typeofProcessGlobal: typeof globalThis.process,
      processTemEnv: !!(globalThis.process && globalThis.process.env),
      legadoPyvEnvPresente: '__PYV_ENV' in globalThis,
    },
    processEnv: {
      tipo: typeof pe,
      totalChaves: pe ? Object.keys(pe).length : 0,
      nomes: pe ? Object.keys(pe).sort() : [],
      vars: describe(pe),
      urlSupabaseHostValido: urlLooksRight(pe),
    },
    bindingsFetch: {
      tipo: typeof env,
      totalChaves: bindings ? Object.keys(bindings).length : 0,
      nomes: bindings ? Object.keys(bindings).sort() : [],
      vars: describe(bindings),
      urlSupabaseHostValido: urlLooksRight(bindings),
    },
  };
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/.netlify/functions/__envdiag') {
      return json(200, envDiagReport(env));
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
