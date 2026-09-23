// Envio transacional via Resend (https://resend.com/api-reference/emails/send-email).
// Requer a env var RESEND_API_KEY no painel do Netlify (Site Settings -> Environment).
// Se a chave nao existir, retorna ok:false SEM lancar — o resgate/claim segue normal.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'PYV <onboarding@resend.dev>';

async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) return { ok: false, reason: 'RESEND_API_KEY ausente — configure no painel do Netlify' };
  const body = {
    from: RESEND_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html: html || text || '',
  };
  if (text && !html) body.text = text;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, reason: (data.message || `HTTP ${res.status}`) };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { sendEmail, RESEND_FROM };
