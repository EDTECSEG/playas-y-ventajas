// Envio transacional via Resend (https://resend.com/api-reference/emails/send-email).
//
// CORRECAO IMPORTANTE (setembro/2026): este helper lia process.env no topo do
// modulo. Isso funciona no Netlify, mas NAO existe no Cloudflare Pages
// Functions (o runtime de trabalho e `env` recebido em context.env). Resultado:
// sendEmail() retornava SEMPRE { ok:false, reason:'RESEND_API_KEY ausente' } na
// producao — ou seja, nenhum email saia, e o motivo era invisivel.
//
// Agora a chave e lida em tempo de CHAMADA a partir do `env` injetado, com
// process.env apenas como fallback (para o Netlify). Se a chave nao existir,
// retorna ok:false SEM lancar: o resgate do cupom nunca depende do email.
function readEnv(env, name) {
  if (env && env[name]) return env[name];
  if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
  return '';
}

function getResendFrom(env) {
  return readEnv(env, 'RESEND_FROM') || 'PYV <onboarding@resend.dev>';
}

async function sendEmail(env, { to, subject, html, text }) {
  const apiKey = readEnv(env, 'RESEND_API_KEY');
  if (!apiKey) return { ok: false, reason: 'RESEND_API_KEY ausente — configure no painel do Cloudflare (Settings > Variables)' };
  const body = {
    from: getResendFrom(env),
    to: Array.isArray(to) ? to : [to],
    subject,
    html: html || text || '',
  };
  if (text && !html) body.text = text;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: data.message || `HTTP ${res.status}` };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { sendEmail, getResendFrom, readEnv };
