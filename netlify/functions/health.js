const { getSupabaseAdminClient } = require('./_supabaseAdmin');

// Diagnostico de operacao: o site esta de pe e as dependencias externas
// respondem?
//
// POR QUE ISTO EXISTE
// O worker loga erro no tail, que e privado e exige abrir o dashboard do
// Cloudflare. Nao ha alerta. O sintoma de um erro em producao hoje e um
// cliente reclamando -- o 500 chega para ele como "erro interno" e para
// ninguem mais. Este endpoint da um lugar de olhar.
//
// O QUE ELE NAO FAZ
// Nao devolve valor de variavel, nao devolve linha de banco, nao diz se o
// Supabase "esta bem" em sentido abstrato. Devolve presente/ausente e
// um teste minimo de alcance. Um health que mente e pior do que nenhum:
// e o que faz alguem desligar o alerta depois de dois falsos positivos.
//
// O QUE ELE DEVE FAZER
// Dizer, em um olhar, qual das dependencias quebrou. Por isso cada check
// e independente: o Resend cair nao pode impedir o diagnostico do Supabase.
//
// SEM AUTENTICACAO, DE PROPONITO
// Nao exige token: um health check que precisa de login nao pode ser usado
// por uptime monitor externo nem por quem estiver com o navegador travado.
// O custo e uma superficie publica que revela quais integracoes existem --
// o que o worker/main.js ja revela de qualquer jeito, porque a resposta 404
// de rota desconhecida lista o que NAO esta ali e o bundle e publico.
//
// Por isso a resposta e deliberadamente pobre: um nome de integracao e
// "ok"/"ausente"/"erro". Nenhum valor, nenhuma contagem, nenhuma URL interna.

const DEPENDENCIAS = [
  { nome: 'supabase', env: ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] },
  { nome: 'resend', env: ['RESEND_API_KEY'] },
  { nome: 'geoapify', env: ['GEOAPIFY_API_KEY'] },
  { nome: 'mercadopago', env: ['MP_ACCESS_TOKEN'] },
  // Estas duas nao tem valor de verdade: o sistema funciona sem elas (o
  // _wa.js tem pages.dev como reserva), mas sem elas o link de retorno do
  // Mercado Pago e a assinatura de assinatura nao funcionam. Aparecem para
  // que "ausente" aqui signifique "modulo inoperante", e nao "algo errado".
  { nome: 'mercadopago_webhook', env: ['MP_WEBHOOK_SECRET'], opcional: true },
  { nome: 'mercadopago_notify_url', env: ['MP_NOTIFICATION_URL'], opcional: true },
];

async function testarSupabase() {
  const supabase = getSupabaseAdminClient();
  // Qualquer coisa que renda: existe alguma RPC app, e o exercicio dela e o
  // caminho real do codigo. Uma query direto em uma tabela seria mais
  // simples, mas "a tabela responde" e nao "a logica de negocio
  // responde", e a segunda e a que o cliente sente.
  const { error } = await supabase.rpc('list_cities', { p_tenant_id: '00000000-0000-0000-0000-000000000000' });
  // list_cities com tenant inexistente devolve vazio, e nao erro: o que
  // testamos aqui e se o RPC existe e se a conexao passou, nao o conteudo.
  if (error) throw new Error(error.code || 'rpc indisponivel');
  return { ok: true };
}

const TESTADORES = {
  supabase: testarSupabase,
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: '{}' };

  const integracoes = [];

  for (const dep of DEPENDENCIAS) {
    const faltando = dep.env.filter((nome) => !String(process.env[nome] || '').trim());

    if (faltando.length > 0) {
      integracoes.push({
        nome: dep.nome,
        status: 'ausente',
        // Lista o NOME da variavel, nunca o valor. Um health check que
        // ecoa segredo em resposta HTTP publica e o incidente inteiro de
        // novo.
        variaveis: faltando,
        opcional: !!dep.opcional,
      });
      continue;
    }

    // Com a variavel presente, ainda falta saber se o servico responde.
    // Para o Supabase isso e um teste de verdade; para os outros, a
    // presenca do valor e o que se pode verificar sem consumir cota da
    // API nem disparar envio de email -- nenhum dos dois deve sair de um
    // GET de health.
    const testador = TESTADORES[dep.nome];
    if (!testador) {
      integracoes.push({ nome: dep.nome, status: 'ok', testar: 'presenca' });
      continue;
    }

    try {
      await testador();
      integracoes.push({ nome: dep.nome, status: 'ok', testar: 'rpc' });
    } catch (e) {
      integracoes.push({ nome: dep.nome, status: 'erro', detalhe: (e && e.message) || 'indisponivel' });
    }
  }

  // 503 quando alguma dependencia NAO OPCIONAL falha ou falta. O painel
  // do uptime usa este codigo para notificar; o 200 seria lido como
  // "tudo bem" e o alerta jamais dispararia.
  const quebrado = integracoes.filter(
    (i) => (i.status !== 'ok' && !i.opcional) || i.status === 'erro'
  );
  const status = quebrado.length > 0 ? 503 : 200;

  return {
    statusCode: status,
    body: JSON.stringify({
      status: status === 200 ? 'ok' : 'degradado',
      integracoes,
      // O nome das quebradas primeiro: quem le o 503 quer saber o que
      // caiu, nao percorrer a lista.
      quebradas: quebrado.map((i) => i.nome),
    }),
  };
};