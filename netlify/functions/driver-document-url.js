const { getSupabaseAdminClient, resolveSession, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canon CJS. Espelho ESM: functions/.netlify/functions/driver-document-url.js
//
// Troca uma sessao de empresa por uma URL assinada de 5 minutos para UM
// documento. E o unico caminho pelo qual o arquivo de um motorista sai do
// bucket.
//
// O que motivou: CNH, RG e CRV estavam num bucket publico, entao a URL valia para
// qualquer um que a tivesse, para sempre, sem sessao e sem expiracao. A URL
// vivia no banco, aparecia em qualquer resposta que copiasse doc_url, e ia para
// o historico do navegador. Agora doc_url guarda o path, a constraint
// driver_documents_doc_url_no_http proibe URL de entrar, e este endpoint emite a
// URL sob demanda.
//
// A ordem importa e e o que fecha o ataque: resolve a sessao, pede o path a RPC
// que checa papel e escopo, e SÓ ENTÃO assina. Se a RPC recusar, nenhuma
// assinatura e criada, entao o erro da RPC nao pode virar 500 generico de
// storage — a empresa recebe 403, nao um vago "erro ao gerar URL".
//
// 5 minutos e o prazo certo porque o caso de uso e abrir o documento para
// revisar, nao embutir o PDF em uma pagina. Para o Proprio motorista ver o
// cadastro dele ainda falta o caminho de sessao de driver (que vive em
// driver_sessions, nao em sessions); hoje nao ha tela que faca isso.
//
// O documentId NUNCA vem de uma URL construida a mao sem checagem: vem da
// query, e a RPC decide. Trocar o id na URL nao ajuda ninguem.

const EXPIRES_IN = 300; // segundos

// Bucket fixo no codigo, e nao lido do doc_url. A constraint no banco so proibe
// http(s), entao ela sozinha nao impede um path nomeando outro bucket. Se este
// endpoint assinasse o bucket que o dado pedisse, um `pyv-images/logo.png`
// gravado por engano viraria uma URL "assinada" de arquivo publico. Fixar aqui
// fecha a classe inteira: so o bucket de documento sai deste endpoint.
const BUCKET = 'driver-documents';

// Separa `driver-documents/<tenant>/<driver>/<uuid>.pdf` em bucket e path,
// recusando se o bucket nao for o esperado. Retorna null quando o valor nao
// tem a forma esperada, e a chamada responde 500 sem chegar a assinar.
//
// O path tambem e rejeitado se tiver segmento `.`/`..`, barra invertida ou
// `//`. `driver-add-document` monta o path com safeSegment, que ja remove `/`
// e `..`, entao um path legitimo nunca traz nada disso: encontrar significa que
// o valor foi escrito fora do endpoint. Um `driver-documents/../../pyv-images/
// logo.png` passaria no teste de bucket (o primeiro segmento e o certo) e
// assinaria um path que sai da pasta do bucket.
function splitRef(storedRef) {
  const value = String(storedRef || '');
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  if (value.slice(0, slash) !== BUCKET) return null;

  const path = value.slice(slash + 1);
  if (path.includes('\\') || path.includes('//')) return null;
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  return { bucket: BUCKET, path };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }) };
  }

  const qs = event.queryStringParameters || {};
  const documentId = qs.documentId ? String(qs.documentId).trim() : null;

  if (!documentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'DOCUMENT_ID_REQUIRED' }) };
  }

  try {
    const supabase = getSupabaseAdminClient();

    const sessionToken = extractSessionToken(event, {});
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'AUTH_REQUIRED' }) };

    let session;
    try {
      session = await resolveSession(supabase, sessionToken);
    } catch (e) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: e.message === 'SESSION_REQUIRED' ? 'AUTH_REQUIRED' : 'SESSION_EXPIRED' }),
      };
    }

    // Recusa aqui nao vira 500: e a checagem de papel e escopo, e precisa
    // chegar como 403 para a tela Differenciar "sem permissao" de "problema".
    const { data, error } = await supabase.rpc('driver_get_document_path', {
      p_tenant_id: session.tenantId,   // <- da sessao
      p_actor_user_id: session.userId, // <- da sessao
      p_document_id: documentId,
    });

    if (error) return { statusCode: rpcErrorStatus(error), body: JSON.stringify({ error: rpcErrorCode(error) }) };

    const ref = splitRef(data && data.docPath);
    if (!ref) {
      return { statusCode: 500, body: JSON.stringify({ error: 'caminho do documento invalido' }) };
    }

    const { data: signed, error: signErr } = await supabase.storage
      .from(ref.bucket)
      .createSignedUrl(ref.path, EXPIRES_IN);

    if (signErr || !signed || !signed.signedUrl) {
      return { statusCode: 500, body: JSON.stringify({ error: 'falha ao gerar a URL do documento' }) };
    }

    return {
      statusCode: 200,
      // no-store: a resposta carrega uma credencial temporaria. Em cache
      // compartilhado, um proxy poderia reentregar a MESMA URL assinada para
      // quem nao tem sessao, dentro da janela de 5 minutos.
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        documentId: data.documentId,
        docType: data.docType,
        status: data.status,
        docNumber: data.docNumber,
        driverId: data.driverId,
        driverName: data.driverName,
        url: signed.signedUrl,
        expiresIn: EXPIRES_IN,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'erro interno' }) };
  }
};
