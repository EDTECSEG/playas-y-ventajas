// Limite de requisicoes por IP, em memoria do processo.
//
// POR QUE CONTA REQUISICOES E NAO FALHAS (o login.js faz o contrario, e ali
// a diferenca e justificavel: credencial errada e o ataque). Aqui seria um
// erro de projeto. O objetivo de quem abusa destes endpoints e ter SUCESSO --
// emitir cupom, criar usuario, registrar afiliado. Um contador que zera a cada
// sucesso e zerado pelo proprio ataque: a protecao se desmancha sozinha. Por
// isso aqui toda requisicao conta, bem-sucedida ou nao.
//
// LIMITE REAL: este contador vive na memoria de uma instancia de funcao. O
// Netlify escala horizontalmente e cada instancia nasce com o mapa vazio, entao
// um robo que espalha as requisicoes entre instancias le o limite N vezes. E um
// freio, nao uma muralha. Para o caminho do dinheiro (claim_coupon) o limite
// que fecha de verdade mora no banco, no padrao de REGISTRATION_RATE_LIMITED
// de modulo4-motoristas.sql.

const buckets = new Map();

// Varredura periodica e teto de tamanho. Sem os dois, o mapa vira o proprio
// vetor de negacao de servico: cada IP distinto cria uma entrada e ninguem sai.
const SWEEP_EVERY_MS = 60 * 1000;
const MAX_BUCKETS = 20000;
let lastSweepAt = 0;

function sweep(now) {
  for (const [key, b] of buckets) {
    if (now >= b.resetAt) buckets.delete(key);
  }
  // Ainda acima do teto (IPs rodando, nao expirados): descarta o excedente.
  if (buckets.size > MAX_BUCKETS) {
    const overflow = buckets.size - MAX_BUCKETS;
    let i = 0;
    for (const key of buckets.keys()) {
      if (i++ >= overflow) break;
      buckets.delete(key);
    }
  }
}

// Janela fixa, nao deslizante. Aceita a rajada de fronteira (o dobro do teto
// atravessando a virada da janela) em troca de O(1) de memoria por IP, o que
// importa mais aqui: o alvo e conter robo, nao contabilizar com precisao.
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  if (now - lastSweepAt > SWEEP_EVERY_MS) {
    sweep(now);
    lastSweepAt = now;
  }

  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;

  const allowed = b.count <= max;
  return {
    allowed,
    remaining: Math.max(0, max - b.count),
    retryInMs: allowed ? 0 : b.resetAt - now,
  };
}

// O IP do primeiro salto do X-Forwarded-For e o cliente. Atras do proxy e do
// CDN esse e o unico campo que nao pode ser forjado pelo proprio navegador:
// os headers sao reescritos a cada salto, o primeiro e o unico que o proxy
// assinou.
function clientIp(event) {
  const headers = (event && event.headers) || {};
  const fwd = headers['x-forwarded-for'] || '';
  return (fwd.split(',')[0] || headers['cf-connecting-ip'] || headers['client-ip'] || 'unknown').trim();
}

// Resposta 429 no mesmo formato nos quatro endpoints, para o cliente ter um
// unico contrato de "deu errado, tenta mais tarde".
function tooManyAttempts(retryInMs) {
  return {
    statusCode: 429,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryInMs / 1000))) },
    body: JSON.stringify({ error: 'TOO_MANY_ATTEMPTS' }),
  };
}

module.exports = { rateLimit, clientIp, tooManyAttempts };