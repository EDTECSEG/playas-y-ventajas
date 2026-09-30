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

// Endereco do site para as mensagens. NEXT_PUBLIC_SITE_URL quando existir
// (Netlify), com o endereco de producao como reserva: um cupom entregue sem
// link nenhum e o cliente sem volta ao site.
const SITE_FALLBACK = 'https://playas-y-ventajas.pages.dev';
function siteUrl() {
  const configured = String(process.env.NEXT_PUBLIC_SITE_URL || '').trim();
  const base = configured || SITE_FALLBACK;
  return base.replace(/\/+$/, '');
}

// Mensagem que o cliente manda para o ESTABELECIMENTO.
//
// Texto definido pelo dono (setembro/2026): a saudacao "Ola! Vim pelo..." e a
// pergunta final "Podem me informar como utilizo?" sairam. A mensagem comeca no
// nome da marca e nao faz pergunta nenhuma: quem esta do outro lado e o caixa
// do estabelecimento, nao um atendente de telemarketing. Link do site e link
// de indicacao (quando o cliente tambem e afiliado) foram acrescentados.
//
// O "Codigo curto" foi REMOVIDO daqui (decisao do dono, setembro/2026). Ele
// nasceu como fallback manual do balcao, mas ninguem consegue usar: a tela da
// empresa (/empresa, aba "Validar cupom") nao tem campo para digitar e a RPC
// validate_and_redeem_coupon exige o public_id de qualquer jeito - sem token
// ela ja autoriza pelo codigo longo sozinho. Mostrar um numero que ninguem
// pode aplicar so gerava confusao no caixa.
//
// O backend continua ACEITANDO p_short_code: quem ja tinha print/link antigo
// com o par codigo+curto continua validando normalmente. So o texto mudou.
function buildCouponMessage({ publicId, businessName, title, site, referralCode }) {
  const base = String(site || siteUrl());
  const linhas = [];
  linhas.push('*Playas y Ventajas*');
  if (title) linhas.push('*Cupom:* ' + title);
  if (businessName) linhas.push('*Estabelecimento:* ' + businessName);
  if (publicId) linhas.push('*Codigo:* ' + publicId);
  linhas.push('*Site:* ' + base);
  if (referralCode) linhas.push('*Link de indicacao:* ' + base + '/?ref=' + encodeURIComponent(referralCode));
  return linhas.join('\n');
}

function buildWaLink({ phone, message, fallbackPhone, fallbackMessage }) {
  const target = normalizePhone(phone) || normalizePhone(fallbackPhone);
  const text = message || fallbackMessage || 'Ola!';
  if (!target) return 'https://wa.me/?text=' + encodeURIComponent(text);
  return 'https://wa.me/' + target + '?text=' + encodeURIComponent(text);
}

module.exports = { normalizePhone, buildCouponMessage, buildWaLink, siteUrl };
