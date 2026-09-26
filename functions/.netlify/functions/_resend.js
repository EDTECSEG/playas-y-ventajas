// Espelho ESM (Cloudflare Pages Functions) de netlify/functions/_resend.js (CJS canon).
//
// CORRECAO IMPORTANTE: a versao anterior lia process.env no topo do modulo.
// Cloudflare Pages Functions nao expoe process.env — o runtime usa o `env`
// do context. Isso fazia sendEmail() falhar SEMPRE em producao com
// 'RESEND_API_KEY ausente', e nada saia. Agora a chave e lida em tempo de
// chamada a partir do env injetado, com process.env como fallback (Netlify).
// Se a chave faltar, retorna ok:false SEM lancar: o resgate nunca depende
// do email.
export function readEnv(env, name) {
  if (env && env[name]) return env[name];
  if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
  return '';
}

export function getResendFrom(env) {
  return readEnv(env, 'RESEND_FROM') || 'PYV <onboarding@resend.dev>';
}

export async function sendEmail(env, { to, subject, html, text }) {
  const apiKey = readEnv(env, 'RESEND_API_KEY');
  if (!apiKey) return { ok: false, reason: 'RESEND_API_KEY ausente — configure no painel do Cloudflare (Settings > Variables)' };
  const payload = {
    from: getResendFrom(env),
    to: Array.isArray(to) ? to : [to],
    subject,
    html: html || text || '',
  };
  if (text && !html) payload.text = text;
  try {
    const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: (data.message || `HTTP ${res.status}`) };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
