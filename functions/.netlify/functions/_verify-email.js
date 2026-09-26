// Espelho ESM (Cloudflare Pages Functions) de netlify/functions/_verify-email.js (CJS canon).
// Validacao interna: existe token OTP pendente para o email? (pre-requisito do fluxo de cadastro).
import { json } from './_shared.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  return onRequestPost(context);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const email = String((body.email || body.token) || '').trim().toLowerCase();
  if (!email) return json({ error: 'email obrigatório' }, 400);
  if (email.length > 254) return json({ error: 'email inválido' }, 400);
  const tokenStore = env.OTP_TOKEN_STORE || '{}';
  let stored = {};
  try { stored = JSON.parse(tokenStore); } catch (e) { stored = {}; }
  if (!stored[email]) return json({ error: 'token não encontrado para este email. Inicie o cadastro novamente.' }, 400);
  return json({ ok: true });
}
