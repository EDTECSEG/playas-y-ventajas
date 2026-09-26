// POST { email, name? } -> envia OTP de 6 digitos por email (Resend).
// O codigo NUNCA sai na resposta — quem confirma digita o codigo que recebeu.
// Auditavel: 401/400 com mensagens claras, sem expor segredo.
const { sendOtp } = require('./_otp');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '{}' };
  try {
    const { email, name } = JSON.parse(event.body || '{}');
    // `context.env` no primeiro argumento: e o que o sendOtp/_resend esperam.
    // readEnv cai para process.env se vier vazio, entao se comporta igual em
    // Netlify e em Pages.
    const result = await sendOtp((context && context.env) || {}, { email, name });
    if (!result.ok) return { statusCode: 400, body: JSON.stringify({ error: result.reason }) };
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    // Mesmo contrato do caminho de cima: o motivo vai para o log do servidor e
    // nao para o corpo. `err.message` aqui carregaria, por exemplo, o erro de
    // parse do proprio body ("Unexpected token ... is not valid JSON").
    console.error('[send-otp] excecao no handler', { motivo: err && err.message });
    return { statusCode: 500, body: JSON.stringify({ error: 'Não foi possível enviar o código. Tente novamente.' }) };
  }
};
