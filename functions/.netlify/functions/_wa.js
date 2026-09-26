// Link de WhatsApp GRATUITO (sem API do WhatsApp Business, sem custo).
//
// Como funciona: wa.me apenas ABRE o app/WhatsApp Web ja com o destinatario e a
// mensagem preenchidos. Nao há envio automatico, nao há template aprovado pela
// Meta e nao há custo. O usuario so precisa tocar no botao "Enviar".
//
// Duas situacoes no resgate do cupom:
//   1) A empresa tem telefone -> abro conversa com a EMPRESA, com o codigo do
//      cupom ja escrito. E o caso util: o cliente manda o codigo no chat.
//   2) A empresa nao tem telefone -> caio no atendimento do PYV, com uma
//      mensagem explicando o contexto do cupom.

// Normaliza telefone brasileiro para o formato que o wa.me exige (so digitos,
// com codigo do pais). "1198765-4321" -> 5511987654321.
export function normalizePhone(raw, defaultCountry = '55') {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  // 0 na frente e o prefixo de longa distancia nacional: some com ele.
  while (digits.length > 2 && digits.startsWith('0')) digits = digits.slice(1);
  // Ja tem codigo do pais? Brasil comeca com 55 e tem 12/13 digitos.
  if (digits.startsWith(defaultCountry) && digits.length >= 12) return digits;
  if (digits.length <= 11) return defaultCountry + digits;
  return digits;
}

// Mensagem que o cliente envia para a empresa com o cupom em maos.
export function buildCouponMessage({ publicId, businessName, title, shortCode }) {
  const linhas = [];
  linhas.push('Ola! Vim pelo Playas y Ventajas e quero usar meu cupom.');
  if (title) linhas.push(`*Cupom:* ${title}`);
  if (businessName) linhas.push(`*Estabelecimento:* ${businessName}`);
  if (publicId) linhas.push(`*Codigo:* ${publicId}`);
  if (shortCode) linhas.push(`*Codigo curto:* ${shortCode}`);
  linhas.push('');
  linhas.push('Podem me informar como utilizo?');
  return linhas.join('\n');
}

// Monta o link wa.me. `phone` pode ser vazio: nesse caso usamos o fallback
// (atendimento) para nunca devolver um link quebrado.
export function buildWaLink({ phone, message, fallbackPhone, fallbackMessage }) {
  const target = normalizePhone(phone) || normalizePhone(fallbackPhone);
  const text = message || fallbackMessage || 'Ola!';
  // Sem nenhum telefone configurado: ainda devolvemos o wa.me sem
  // destinatario, que abre o WhatsApp para o usuario escolher o contato.
  if (!target) return `https://wa.me/?text=${encodeURIComponent(text)}`;
  return `https://wa.me/${target}?text=${encodeURIComponent(text)}`;
}
