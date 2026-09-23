// POST { email, name? } -> envia OTP de 6 digitos por email (Resend).
// O codigo NUNCA sai na resposta — quem confirma digita o codigo que recebeu.
// Auditavel: 401/400 com mensagens claras, sem expor segredo.
const { sendOtp } = require('./_otp');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { email, name } = JSON.parse(event.body || '{}');
    const result = await sendOtp({ email, name });
    if (!result.ok) return { statusCode: 400, body: JSON.stringify({ error: result.reason }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
