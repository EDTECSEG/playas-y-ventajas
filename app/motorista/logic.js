// Logica pura do modulo do motorista.
//
// Tudo aqui e funcao sem efeito colateral, sem React, sem rede e sem nenhum
// import, para poder ser testado com node --test direto nos .cjs, sem DOM e
// sem transformador de JSX. O componente app/motorista/page.jsx so orquestra
// estado e render.
//
// O que mora aqui e a parte que silenciosamente quebra: qual credencial vai
// em cada chamada, e como se le a resposta de login. O que e apresentacao
// (rotulo, cor, formulario) fica no componente, junto com o theme.

export const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

// Mesmo teto do servidor, para avisar antes de enviar 8 MB de base64.
export const MAX_BYTES = 6 * 1024 * 1024;

export const DOC_TYPES = [
  { value: 'cnh', label: 'CNH (carteira de motorista)' },
  { value: 'rg', label: 'RG (identidade)' },
  { value: 'crv', label: 'CRV (registro de veiculo)' },
];

const FRIENDLY = {
  TENANT_REQUIRED: 'Nao foi possivel identificar a empresa. Recarregue a pagina.',
  NAME_REQUIRED: 'Informe seu nome.',
  PHONE_INVALID: 'Informe um telefone valido.',
  EMAIL_INVALID: 'Informe um email valido.',
  PIN_INVALID: 'Informe um PIN valido.',
  PIN_MISMATCH: 'Os PINs nao batem.',
  PIN_TOO_SHORT: 'O PIN precisa ter pelo menos 4 digitos.',
  DRIVER_ID_REQUIRED: 'Cadastro nao encontrado. Faca o cadastro de novo.',
  DOC_TYPE_INVALID: 'Escolha o tipo de documento.',
  FILE_REQUIRED: 'Escolha um arquivo.',
  FILE_TOO_LARGE: 'O arquivo passa de 6 MB.',
  DOC_URL_NOT_ACCEPTED: 'Este modulo envia o arquivo, nao um link. Escolha o arquivo.',
  AUTH_REQUIRED: 'Faca login para enviar o documento.',
  MULTIPLE_CREDENTIALS: 'Sessao e token de cadastro nao podem ser enviados juntos.',
  INVALID_JSON: 'Nao foi possivel ler o pedido. Tente de novo.',
  METHOD_NOT_ALLOWED: 'Operacao nao permitida.',
  SESSION_REQUIRED: 'Faca login para continuar.',
  SESSION_EXPIRED: 'Sua sessao expirou. Entre de novo.',
  NOT_APPROVED: 'Seu cadastro ainda nao foi aprovado pela empresa.',
  ACCOUNT_SUSPENDED: 'Sua conta esta suspensa. Fale com a empresa.',
  DOCUMENT_NOT_FOUND: 'Documento nao encontrado.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde alguns minutos.',
  FILE_UNREADABLE: 'Nao foi possivel ler o arquivo.',
  LOGIN_FAILED: 'Nao foi possivel entrar.',
  'arquivo excede o limite de 6 MB': 'O arquivo passa de 6 MB.',
  'tipo de documento nao permitido (use PDF, JPEG ou PNG)': 'Use PDF, JPEG ou PNG.',
  'conteudo nao corresponde ao tipo informado': 'O conteudo do arquivo nao bate com o tipo escolhido.',
  'falha ao armazenar o documento': 'Nao foi possivel salvar o arquivo. Tente de novo.',
  'falha ao montar a URL do documento': 'Nao foi possivel salvar o arquivo. Tente de novo.',
  'erro interno': 'Erro no servidor. Tente de novo.',
};

// Codigo de erro do servidor -> texto. Sem isto a tela mostraria
// DOCUMENT_NOT_FOUND, que e util para quem develope e nada para o motorista.
export function friendlyMessage(code) {
  if (!code) return '';
  return FRIENDLY[String(code)] || String(code);
}

// Qual credencial vai na chamada. EXATAMENTE UMA por request: o endpoint
// recusa as duas juntas, e mandar a errada e falha silenciosa.
export function resolveCredential({ session, pending } = {}) {
  if (session && session.sessionToken) {
    return { mode: 'session', headerToken: session.sessionToken, bodyToken: null };
  }
  if (pending && pending.uploadToken) {
    return { mode: 'upload', headerToken: null, bodyToken: pending.uploadToken };
  }
  throw new Error(friendlyMessage('AUTH_REQUIRED'));
}

export function driverIdFor({ session, pending } = {}) {
  const id = (session && session.driverId) || (pending && pending.driverId);
  if (!id) throw new Error(friendlyMessage('DRIVER_ID_REQUIRED'));
  return id;
}

// driver_login devolve {error: 'NOT_APPROVED'} com HTTP 200 quando o cadastro
// existe mas nao esta aprovado. Ler o status HTTP e o jeito classico de deixar
// o motorista nao aprovado entrar como se tivesse logado. So sessionToken e
// sucesso de verdade.
export function interpretLogin(data) {
  if (data && data.sessionToken) return { ok: true, session: data, error: null };
  if (data && data.error) return { ok: false, session: null, error: friendlyMessage(data.error) };
  return { ok: false, session: null, error: friendlyMessage('LOGIN_FAILED') };
}

export function checkPin(pin, pin2) {
  if (String(pin || '') !== String(pin2 || '')) throw new Error(friendlyMessage('PIN_MISMATCH'));
  if (String(pin || '').length < 4) throw new Error(friendlyMessage('PIN_TOO_SHORT'));
  return true;
}

// Definir o PIN consome o pinToken: ele vale uma vez. O uploadToken continua
// valido, porque ainda nao ha sessao e ele e o que autoriza o documento.
export function pinConsumed(pending) {
  if (!pending) return pending;
  const p = { ...pending };
  delete p.pinToken;
  return p;
}

// Monta o corpo do upload de documento e o token do header, sem nunca repetir a
// credencial. O doc_url nao entra: o endpoint monta o path e rejeita URL.
export function buildDocumentRequest({
  session,
  pending,
  docType,
  fileBase64,
  contentType,
  docNumber,
  docExpiresAt,
  tenantId = TENANT_ID,
} = {}) {
  if (!DOC_TYPES.some((d) => d.value === String(docType || ''))) {
    throw new Error(friendlyMessage('DOC_TYPE_INVALID'));
  }
  if (!fileBase64) throw new Error(friendlyMessage('FILE_REQUIRED'));
  if (!contentType) throw new Error(friendlyMessage('FILE_REQUIRED'));

  const credential = resolveCredential({ session, pending });
  const body = {
    tenantId,
    driverId: driverIdFor({ session, pending }),
    docType: String(docType),
    contentType,
    fileBase64,
    docNumber: docNumber && docNumber.trim() ? docNumber.trim() : null,
    docExpiresAt: docExpiresAt || null,
  };

  if (credential.mode === 'upload') body.uploadToken = credential.bodyToken;

  return { body, headerToken: credential.headerToken };
}

// Qual situacao o cadastro esta. A sessao manda quando existe, porque e mais
// nova que o registro do cadastro pela metade.
export function situationFor({ session, pending } = {}) {
  return (session && session.status) || (pending && pending.status) || null;
}

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// O que a tela reidrata do navegador.
//
// A sessao precisa de sessionToken.
//
// O cadastro pela metade precisa de uploadToken, e NAO de pinToken. O pinToken
// e consumido assim que o PIN e definido, entao quem so procurasse pinToken
// perderia o cadastro pela metade no primeiro recarregamento depois do PIN e o
// motorista ficaria sem bloco de documentos, sem caminho para se habilitar.
// localStorage corrompido nao pode impedir a tela de abrir, entao string
// invalida vira null em vez de excecao.
export function sessionFromStorage(raw) {
  const s = parseJson(raw);
  return s && s.sessionToken ? s : null;
}

export function pendingFromStorage(raw) {
  const p = parseJson(raw);
  return p && p.uploadToken ? p : null;
}