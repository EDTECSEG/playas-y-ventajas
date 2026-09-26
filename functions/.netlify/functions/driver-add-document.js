import { getSupabaseAdminClient, extractSessionToken, rpcErrorCode, rpcErrorStatus, json } from './_shared.js';
import { randomUUID } from 'node:crypto';

// Espelho ESM. Canon CJS: netlify/functions/driver-add-document.js
//
// Anexa documento de motorista. Aceita DOIS caminhos de autenticacao, e nunca
// os dois ao mesmo tempo:
//
//   1. driverSessionToken — motorista ja logado (reenvio de documento rejeitado)
//   2. uploadToken        — montagem do cadastro, antes do login
//
// A versao anterior aceitava p_session_token NULO e passava direto: qualquer
// um podia anexar documento em qualquer driver_id, e ainda rebaixava um
// motorista aprovado de volta para pending. A RPC agora exige sessao OU token
// de upload.
//
// Regra "exatamente um" aplicada AQUI, na borda, alem da RPC: se vierem os
// dois, rejeitamos com 400 em vez de escolher um. Escolher o primeiro que
// apareceu seria comportamento dependente de ordem e esconderia erro do cliente.
//
// SEGURANCA DO doc_url: o endpoint NAO aceita mais docUrl do cliente. A versão
// anterior recebia a URL pronta e a RPC so checava tamanho e nao-vazio, o que
// deixava passar qualquer URL: um invasor apontava doc_url para um PDF que ele
// nao controlava, ou para um objeto publico do bucket, e a empresa aprovava um
// documento que nunca foi enviado por aqui. O arquivo agora chega como
// base64 + contentType, e o path no Storage e montado AQUI, derivado de
// tenantId/driverId ja filtrados e de um UUID do servidor. A extensao vem da
// tabela abaixo, nunca do nome do arquivo enviado.
//
// Se a RPC recusar depois do upload, o arquivo fica orfao no bucket, entao o
// erro apaga o que foi gravado. Sem isso, qualquer tentativa com credencial
// invalida enche o Storage de lixo.

const DOC_TYPES = ['cnh', 'rg', 'crv'];

const BUCKET = 'pyv-images';
const FOLDER = 'driver-documents';
const MAX_BYTES = 6 * 1024 * 1024; // 6 MB, o mesmo teto do upload-image

// Tipos permitidos e extensao derivada SERVIDOR. Documento aceita PDF alem de
// imagem, diferente de upload-image (que e so logo/marketing). WEBP nao entra:
// nao serve para documento e nao tem valor legal util aqui.
const ALLOWED_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

function matchesMagic(type, buf) {
  if (buf.length < 5) return false;
  if (type === 'application/pdf') {
    return buf.toString('latin1', 0, 5) === '%PDF-';
  }
  if (type === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (type === 'image/png') {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  }
  return false;
}

// tenantId/driverId entram no path do Storage. Vem do cliente, entao nao pode
// conter ".." nem "/": sem isto um driverId de "../../admin" gravaria o
// documento fora da pasta de documentos.
function safeSegment(value) {
  const s = String(value).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return s || 'x';
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const { tenantId, driverId, docType, fileBase64, contentType, docNumber, docExpiresAt } = body || {};
  const sessionToken = body.driverSessionToken || extractSessionToken(request, body);
  const uploadToken = body.uploadToken;

  if (!tenantId) return json({ error: 'TENANT_REQUIRED' }, 400);
  if (!driverId) return json({ error: 'DRIVER_ID_REQUIRED' }, 400);
  if (!DOC_TYPES.includes(String(docType || '').toLowerCase())) {
    return json({ error: 'DOC_TYPE_INVALID' }, 400);
  }

  // docUrl agora e um erro explicito, em vez de ser aceito em silencio. Sem
  // isso, um cliente antigo continuaria mandando URL e receberia 200 sem
  // arquivo nenhum anexado.
  if (body && body.docUrl) {
    return json({ error: 'DOC_URL_NOT_ACCEPTED' }, 400);
  }

  if (!fileBase64 || !contentType) return json({ error: 'FILE_REQUIRED' }, 400);

  // Barra o base64 pelo tamanho ENCODED antes de decodificar, para nao alocar
  // um buffer grande a partir de uma string enorme.
  const maxEncoded = Math.ceil(MAX_BYTES / 3) * 4 + 4;
  if (String(fileBase64).length > maxEncoded) {
    return json({ error: 'arquivo excede o limite de 6 MB' }, 400);
  }

  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    return json({ error: 'tipo de documento não permitido (use PDF, JPEG ou PNG)' }, 400);
  }

  const buffer = Buffer.from(String(fileBase64), 'base64');
  if (buffer.length === 0) return json({ error: 'arquivo vazio' }, 400);
  if (buffer.length > MAX_BYTES) return json({ error: 'arquivo excede o limite de 6 MB' }, 400);
  if (!matchesMagic(contentType, buffer)) {
    return json({ error: 'conteúdo não corresponde ao tipo informado' }, 400);
  }

  // Exatamente um credencial. Zero = o ataque antigo. Dois = cliente bugado,
  // e escolher um deles as vezes seria aceitar a autenticacao mais fraca.
  const temSessao = Boolean(sessionToken);
  const temUpload = Boolean(uploadToken && String(uploadToken).trim());
  if (temSessao === temUpload) {
    return json({ error: temSessao ? 'MULTIPLE_CREDENTIALS' : 'AUTH_REQUIRED' }, 400);
  }

  let uploadedPath = null;

  try {
    const supabase = getSupabaseAdminClient(env);

    uploadedPath = `${FOLDER}/${safeSegment(tenantId)}/${safeSegment(driverId)}/${randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(uploadedPath, buffer, { contentType, upsert: false });
    if (upErr) {
      return json({ error: 'falha ao armazenar o documento' }, 400);
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(uploadedPath);
    const storedUrl = pub && pub.publicUrl;
    if (!storedUrl) {
      await supabase.storage.from(BUCKET).remove([uploadedPath]);
      return json({ error: 'falha ao montar a URL do documento' }, 500);
    }

    const { data, error } = await supabase.rpc('driver_add_document', {
      p_tenant_id: tenantId,
      p_driver_id: driverId,
      p_doc_type: String(docType).toLowerCase(),
      p_doc_url: storedUrl,
      p_doc_number: docNumber || null,
      p_doc_expires_at: docExpiresAt || null,
      // Passa SO o credencial informado, nunca os dois.
      p_session_token: temSessao ? sessionToken : null,
      p_upload_token: temUpload ? String(uploadToken).trim() : null,
    });

    if (error) {
      // Credencial invalida, driver de outro tenant, tipo duplicado: o arquivo
      // ja estava no Storage e nao tem documento associated, entao apaga.
      await supabase.storage.from(BUCKET).remove([uploadedPath]);
      return json({ error: rpcErrorCode(error) }, rpcErrorStatus(error));
    }

    return json({ documentId: data.documentId, status: data.status }, 200);
  } catch (err) {
    if (uploadedPath) {
      try {
        const supabase = getSupabaseAdminClient(env);
        await supabase.storage.from(BUCKET).remove([uploadedPath]);
      } catch (e) {
        // Nada a fazer: o arquivo orfao pode ficar, e melhor do que mascarar o
        // erro original.
      }
    }
    const code = err.message === 'SESSION_REQUIRED' || err.message === 'SESSION_EXPIRED' ? 401 : 500;
    return json({ error: code === 401 ? err.message : 'erro interno' }, code);
  }
}
