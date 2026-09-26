// OTP de 6 digitos por email (Resend), STATELESS: nenhum estado.
// Codigo derivado por HMAC-SHA256(email + bucket de 5min) usando a service-role
// key como segredo -> expira sozinho quando o bucket muda; funciona em cold-start
// e multiplas instancias (serverless). Sem tabela, sem arquivo, sem memoria.
const { createHmac, timingSafeEqual } = require('crypto');
const { sendEmail } = require('./_resend');

const BUCKET_SECONDS = 300; // 5 min
const SUPPORT_EMAIL = 'atendimento@pyv.com.br';

function bucketOf(epochSec) {
  return Math.floor(epochSec / BUCKET_SECONDS);
}

function otpSecret() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || 'pyv-dev-otp-key';
}

function buildOtpCode(email, bucket) {
  const norm = String(email || '').trim().toLowerCase();
  const hex = createHmac('sha256', otpSecret())
    .update(`${norm}|${bucket}`)
    .digest('hex');
  const n = parseInt(hex.slice(0, 8), 16);
  return String(n % 1000000).padStart(6, '0');
}

// O `env` e o primeiro parametro para bater com o espelho ESM
// (`sendOtp(env, { email, name })`). Sem ele, o `sendEmail` daqui recebia o
// payload no lugar do env e o segundo argumento chegava `undefined`, o que
// estourava em `Cannot destructure property 'to' of 'undefined'` — ou seja,
// NENHUM email de OTP saia, em producao, e o erro so aparecia no log.
async function sendOtp(env, { email, name }) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm || norm.length > 254) return { ok: false, reason: 'Email inválido' };
  const nowSec = Math.floor(Date.now() / 1000);
  const code = buildOtpCode(norm, bucketOf(nowSec));
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:430px;margin:0 auto;padding:24px;border:1px solid #E5E5E5;border-radius:12px;text-align:center">
      <h2 style="margin:0 0 8px;color:#0B6E4F">Teu código de confirmação</h2>
      <p style="margin:0 0 18px;color:#555;font-size:14px">${name ? `Oi, ${name}! ` : ''}Usa este código para confirmar teu cadastro no PYV:</p>
      <div style="background:#FDF3D7;border:1px dashed #E8C46A;border-radius:8;padding:14px;font-family:monospace;font-size:26px;font-weight:800;letter-spacing:8px;color:#0B6E4F">${code}</div>
      <p style="margin:16px 0 0;font-size:12px;color:#999">O código expira em 5&nbsp;minutos. Se não foi você, pode ignorar — alguém pode ter digitado teu email por engano.</p>
      <p style="margin:10px 0 0;font-size:11px;color:#BBB">Suporte: ${SUPPORT_EMAIL}</p>
    </div>`;
  const result = await sendEmail(env, { to: norm, subject: 'Código de confirmação PYV', html });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true };
}

function isValidOtp(email, code) {
  const cand = String(code || '').trim();
  const norm = String(email || '').trim().toLowerCase();
  if (!norm || !/^\d{6}$/.test(cand)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  const cur = bucketOf(nowSec);
  const a = Buffer.from(cand);
  for (const bucket of [cur, cur - 1]) {
    const expected = Buffer.from(buildOtpCode(norm, bucket));
    if (a.length === expected.length && timingSafeEqual(a, expected)) return true;
  }
  return false;
}

module.exports = { sendOtp, isValidOtp, buildOtpCode };
