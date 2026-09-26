const BUCKET_SECONDS = 300;

function bucketOf(epochSec) {
  return Math.floor(epochSec / BUCKET_SECONDS);
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildOtpCode(env, email, bucket) {
  const secret = env.SUPABASE_SERVICE_ROLE_KEY || 'pyv-dev-otp-key';
  const norm = String(email || '').trim().toLowerCase();
  const hex = await hmacHex(secret, `${norm}|${bucket}`);
  const n = parseInt(hex.slice(0, 8), 16);
  return String(n % 1000000).padStart(6, '0');
}

export async function isValidOtp(env, email, code) {
  const cand = String(code || '').trim();
  const norm = String(email || '').trim().toLowerCase();
  if (!norm || !/^\d{6}$/.test(cand)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  const cur = bucketOf(nowSec);
  for (const bucket of [cur, cur - 1]) {
    if (cand === (await buildOtpCode(env, norm, bucket))) return true;
  }
  return false;
}

async function sendEmail(env, { to, subject, html, text }) {
  const key = env.RESEND_API_KEY || '';
  if (!key) return { ok: false, reason: 'RESEND_API_KEY ausente' };
  const body = {
    from: env.RESEND_FROM || 'PYV <onboarding@resend.dev>',
    to: Array.isArray(to) ? to : [to],
    subject,
    html: html || text || '',
  };
  if (text && !html) body.text = text;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, reason: data.message || `HTTP ${res.status}` };
  return { ok: true, id: data.id };
}

export async function sendOtp(env, { email, name }) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm || norm.length > 254) return { ok: false, reason: 'Email inválido' };
  const code = await buildOtpCode(env, norm, bucketOf(Math.floor(Date.now() / 1000)));
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:430px;margin:0 auto;padding:24px;border:1px solid #E5E5E5;border-radius:12px;text-align:center">
      <h2 style="margin:0 0 8px;color:#0B6E4F">Teu código de confirmação</h2>
      <p style="margin:0 0 18px;color:#555;font-size:14px">${name ? `Oi, ${name}! ` : ''}Usa este código para confirmar teu cadastro no PYV:</p>
      <div style="background:#FDF3D7;border:1px dashed #E8C46A;border-radius:8;padding:14px;font-family:monospace;font-size:26px;font-weight:800;letter-spacing:8px;color:#0B6E4F">${code}</div>
      <p style="margin:16px 0 0;font-size:12px;color:#999">O código expira em 5&nbsp;minutos. Se não foi você, pode ignorar — alguém pode ter digitado teu email por engano.</p>
      <p style="margin:10px 0 0;font-size:11px;color:#BBB">Suporte: atendimento@pyv.com.br</p>
    </div>`;
  const result = await sendEmail(env, { to: norm, subject: 'Código de confirmação PYV', html });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true };
}