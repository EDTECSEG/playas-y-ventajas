const { getSupabaseAdminClient, extractSessionToken, rpcErrorCode, rpcErrorStatus } = require('./_supabaseAdmin');

// Canon CJS. Espelho ESM: functions/.netlify/functions/driver-add-document.js
//
// Anexa documento de motorista. Aceita DOIS caminhos de autenticacao, e nunca
// os dois ao mesmo tempo:
//
//   1. driverSessionToken — motorista ja logado (reenvio de documento rejeitado)
//   2. uploadToken        — montagem do cadastro, antes do login
//
// A versão anterior aceitava p_session_token NULO e passava direto: qualquer
// um podia anexar documento em qualquer driver_id, e ainda rebaixava um
// motorista aprovado de volta para pending. A RPC agora exige sessao OU token
// de upload.
//
// Regra "exatamente um" aplicada AQUI, na borda, alem da RPC: se vierem os
// dois, rejeitamos com 400 em vez de escolher um. Escolher o primeiro que
// apareceu seria comportamento dependente de ordem e esconderia erro do cliente.
//
// SEGURANCA DO doc_url: a RPC so checa tamanho e nao-vazio. A garantia de que
// a URL aponta para um PDF/JPG de verdade, dentro do Storage, fica no
// upload-image.js. Este endpoint nao deve passar URL arbitraria: o path tem
// que vir do upload, e nao digitado pelo usuario. (Pendencia: amarrar os
// dois; ate la, manter o upload como unica origem de doc_url.)

const DOC_TYPES = ['cnh', 'rg', 'crv'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'INVALID_JSON' }) };
  }

  const { tenantId, driverId, docType, docUrl, docNumber, docExpiresAt } = body || {};
  const sessionToken = body.driverSessionToken || extractSessionToken(event, body);
  const uploadToken = body.uploadToken;

  if (!tenantId) return { statusCode: 400, body: JSON.stringify({ error: 'TENANT_REQUIRED' }) };
  if (!driverId) return { statusCode: 400, body: JSON.stringify({ error: 'DRIVER_ID_REQUIRED' }) };
  if (!DOC_TYPES.includes(String(docType || '').toLowerCase())) {
    return { statusCode: 400, body: JSON.stringify({ error: 'DOC_TYPE_INVALID' }) };
  }
  if (!docUrl || !String(docUrl).trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'DOC_URL_REQUIRED' }) };
  }

  // Exatamente um credencial. Zero = o ataque antigo. Dois = cliente bugado,
  // e escolher um deles as vezes seria aceitar a autenticacao mais fraca.
  const temSessao = Boolean(sessionToken);
  const temUpload = Boolean(uploadToken && String(uploadToken).trim());
  if (temSessao === temUpload) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: temSessao ? 'MULTIPLE_CREDENTIALS' : 'AUTH_REQUIRED' }),
    };
  }  try {
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase.rpc('driver_add_document', {
      p_tenant_id: tenantId,
      p_driver_id: driverId,
      p_doc_type: String(docType).toLowerCase(),
      p_doc_url: String(docUrl).trim(),
      p_doc_number: docNumber || null,
      p_doc_expires_at: docExpiresAt || null,
      // Passa SO o credencial informado, nunca os dois.
      p_session_token: temSessao ? sessionToken : null,
      p_upload_token: temUpload ? String(uploadToken).trim() : null,
    });

    if (error) {
      return {
        statusCode: rpcErrorStatus(error),
        body: JSON.stringify({ error: rpcErrorCode(error) }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ documentId: data.documentId, status: data.status }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
