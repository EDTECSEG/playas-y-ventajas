// Link de WhatsApp GRATUITO (sem API do WhatsApp Business, sem custo).
// Canon CJS. Espelho ESM: functions/.netlify/functions/_wa.js
//
// wa.me apenas ABRE o app/WhatsApp Web com destinatario e mensagem ja
// preenchidos. Nao ha envio automatico nem custo: o usuario toca em "Enviar".
//
// No resgate do cupom:
//   1) Empresa tem telefone -> conversa com a EMPRESA e o codigo ja escrito.
//   2) Sem telefone -> cai no atendimento do PYV com o contexto do cupom.

// "1198765-4321" -> 5511987654321 (wa.me exige so digitos, com pais).
function normalizePhone(raw, defaultCountry) {
  const country = defaultCountry || '55';
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  while (digits.length > 2 && digits.charAt(0) === '0') digits = digits.slice(1);
  if (digits.indexOf(country) === 0 && digits.length >= 12) return digits;
  if (digits.length <= 11) return country + digits;
  return digits;
}

function buildCouponMessage({ publicId, businessName, title, shortCode }) {
  const linhas = [];
  linhas.push('Ola! Vim pelo Playas y Ventajas e quero usar meu cupom.');
  if (title) linhas.push('*Cupom:* ' + title);
  if (businessName) linhas.push('*Estabelecimento:* ' + businessName);
  if (publicId) linhas.push('*Codigo:* ' + publicId);
  if (shortCode) linhas.push('*Codigo curto:* ' + shortCode);
  linhas.push('');
  linhas.push('Podem me informar como utilizo?');
  return linhas.join('\n');
}

function buildWaLink({ phone, message, fallbackPhone, fallbackMessage }) {
  const target = normalizePhone(phone) || normalizePhone(fallbackPhone);
  const text = message || fallbackMessage || 'Ola!';
  if (!target) return 'https://wa.me/?text=' + encodeURIComponent(text);
  return 'https://wa.me/' + target + '?text=' + encodeURIComponent(text);
}

module.exports = { normalizePhone, buildCouponMessage, buildWaLink };
