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
  PENDING_APPROVAL: 'Seu cadastro ainda nao foi aprovado pela empresa.',
  REGISTRATION_REJECTED: 'Seu cadastro foi recusado. Envie o documento corrigido para nova analise.',
  ACCOUNT_SUSPENDED: 'Sua conta esta suspensa. Fale com a empresa.',
  INVALID_CREDENTIALS: 'Telefone ou PIN incorreto.',
  ACCOUNT_LOCKED: 'Muitas tentativas. Aguarde alguns minutos.',
  DOCUMENT_NOT_FOUND: 'Documento nao encontrado.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde alguns minutos.',
  FILE_UNREADABLE: 'Nao foi possivel ler o arquivo.',
  LOGIN_FAILED: 'Nao foi possivel entrar.',
  INVALID_COORDS: 'Informe uma localizacao valida.',
  SHUTTLE_NOT_FOUND: 'Servico de translado nao encontrado.',
  RESERVATION_NOT_FOUND: 'Corrida nao encontrada na sua frota.',
  INVALID_STATUS_TRANSITION: 'Esta corrida nao pode mudar de situacao agora.',
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

// O login e simples e nao depende de aprovacao: driver_login emite sessao para
// 'pending', 'approved' e 'rejected', e devolve {error: 'ACCOUNT_SUSPENDED'}
// com HTTP 403 para o suspenso.
//
// Ler o status HTTP nao basta, e continua valendo: um {error: ...} no corpo com
// HTTP 200 nao e sucesso. O unico sucesso de verdade e o sessionToken, porque
// e ele que autoriza os demais endpoints. Um login nao aprovado que "entrou"
// apareceria na tela como logado e so falharia depois, no envio do documento.
export function interpretLogin(data) {
  if (data && data.sessionToken) return { ok: true, session: data, error: null };
  if (data && data.error) return { ok: false, session: null, error: friendlyMessage(data.error) };
  return { ok: false, session: null, error: friendlyMessage('LOGIN_FAILED') };
}

// Entrar no app e dirigir sao coisas diferentes. 'pending' e 'rejected' acessam
// o app (para enviar documento e ver a situacao) mas nao ficam na frota:
// quem expose motorista em list_live_vehicles exige 'approved' (modulo 1).
//
// A tela usa isto para nao prometer habilitacao a quem so tem acesso. Retorna
// false para status desconhecido, porque o padrao seguro e nao dirigir.
export function canDrive(status) {
  return String(status || '') === 'approved';
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

// Monta o corpo do reporte de posicao (driver-position).
//
// So motorista aprovado reporta: a RPC no servidor tambem confere, mas sem
// a confirmacao aqui a tela prometeria envio a quem ainda nao esta na frota.
// A credencial e SEMPRE a sessao — driver-position nao aceita uploadToken, e
// mandar as duas juntas e erro.
export function buildPositionRequest({ session, lat, lng, heading, speedKmh, shuttleId } = {}) {
  if (!canDrive(session && session.status)) {
    if (!session || !session.sessionToken) throw new Error(friendlyMessage('AUTH_REQUIRED'));
    throw new Error(friendlyMessage('NOT_APPROVED'));
  }
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (lat === null || lat === undefined || lng === null || lng === undefined
      || !Number.isFinite(nLat) || !Number.isFinite(nLng)
      || nLat < -90 || nLat > 90 || nLng < -180 || nLng > 180) {
    throw new Error(friendlyMessage('INVALID_COORDS'));
  }
  return {
    body: {
      lat: nLat,
      lng: nLng,
      heading: heading === null || heading === undefined || heading === '' ? null : Number(heading),
      speedKmh: speedKmh === null || speedKmh === undefined || speedKmh === '' ? null : Number(speedKmh),
      shuttleId: shuttleId || null,
    },
    headerToken: session.sessionToken,
  };
}

// Rotulo dos dias ativos de um servico de translado (0=domingo).
export function daysLabel(activeDays) {
  const D = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
  if (!Array.isArray(activeDays) || !activeDays.length) return 'todos os dias';
  return activeDays.map((d) => D[d] || d).join(', ');
}

// --- Transmissao automatica de posicao --------------------------------------

// Intervalo do envio automatico.
//
// O numero nao e estetico: list_live_vehicles descarta posicao mais velha que
// p_max_age_s (300 s por padrao). Com o envio so por botao, o motorista
// desaparecia do mapa 5 min depois do clique e a tela nao dizia isso. 30 s de
// headroom mantem a posicao fresca com folga; o upsert e por driver_id, entao
// cada ciclo sobrescreve a linha em vez de acumular.
export const AUTO_POSITION_MS = 30000;

// Se o ciclo automatico pode rodar agora. Tres portoes, todos necessarios:
//   - enabled: o motorista ligou. Comeca desligado: ligar no primeiro render
//     gasta GPS sem ninguem ter pedido.
//   - canDrive(status): o mesmo portao do botao manual. 'pending' e 'rejected'
//     entram no app mas nao ficam na frota, e nao aparecem em list_live_vehicles
//     — transmitiriam de um lugar que ninguem ve.
//   - visible: com a aba em segundo plano o GPS fica ligado sem resultado. O
//     `false` explicito e o unico que corta; indefinido conta como visivel, para
//     a decisao nao depender de a pagina ter lido document.visibilityState.
export function shouldAutoSend({ enabled, status, visible } = {}) {
  if (!enabled) return false;
  if (!canDrive(status)) return false;
  if (visible === false) return false;
  return true;
}

// --- Corridas do dia (driver-shuttle-runs) ---------------------------------

// Situacao da corrida, como a tela mostra. 'confirmed' e a unica em que o
// botao de concluir aparece.
export const RUN_STATUS_LABEL = {
  confirmed: 'Confirmada',
  completed: 'Concluida',
};

// Dia local em YYYY-MM-DD. O endpoint agrupa a agenda por dia no fuso de
// referencia do banco; mandar o dia do navegador evita que a corrida das 22:00
// caia na agenda de amanha. Sem offset, `toISOString()` viraria UTC e no Brasil
// (UTC-3) a virada seria sempre errada.
export function localDateIso(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 'dd/mm as HH:MM' no fuso do navegador. Devolve '' para data ausente, em vez
// de 'Invalid Date' aparecendo na tela. `lang` e o idioma do app ('pt'|'en'|
// 'es'); sem argumento mantem o pt-BR, para os testes antigos continuarem
// fixando o mesmo formato.
export function formatRunWhen(iso, lang) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const bcp = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' }[lang] || 'pt-BR';
  try {
    return d.toLocaleString(bcp, { dateStyle: 'short', timeStyle: 'short' });
  } catch (e) {
    return '';
  }
}

// Agenda por horario. A RPC ja devolve ordenado, mas a tela nao pode depender
// dessa promessa: ordenar aqui custa uma linha e remove a chance de a lista
// aparecer embaralhada se a query mudar.
export function sortRunsByTime(runs) {
  if (!Array.isArray(runs)) return [];
  return [...runs].sort((a, b) => {
    const ta = new Date((a && a.scheduledFor) || 0).getTime();
    const tb = new Date((b && b.scheduledFor) || 0).getTime();
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
}

// Monta a chamada de listagem. Mesma credencial de driver-position (a sessao) e
// o mesmo gate de canDrive: quem nao esta na frota nao recebe agenda, e o
// servidor conferiria o mesmo com NOT_APPROVED.
export function buildRunsRequest({ session, date } = {}) {
  if (!canDrive(session && session.status)) {
    if (!session || !session.sessionToken) throw new Error(friendlyMessage('AUTH_REQUIRED'));
    throw new Error(friendlyMessage('NOT_APPROVED'));
  }
  const day = date || localDateIso();
  return {
    query: `?date=${encodeURIComponent(day)}`,
    headerToken: session.sessionToken,
  };
}

// Concluir corrida. So 'confirmed' chega aqui: a transicao e do servidor
// (INVALID_STATUS_TRANSITION), mas esconder o botao evita o erro previsivel.
export function buildCompleteRunRequest({ session, reservationId, status } = {}) {
  if (!canDrive(session && session.status)) {
    if (!session || !session.sessionToken) throw new Error(friendlyMessage('AUTH_REQUIRED'));
    throw new Error(friendlyMessage('NOT_APPROVED'));
  }
  if (!reservationId) throw new Error(friendlyMessage('RESERVATION_NOT_FOUND'));
  if (status && status !== 'confirmed') throw new Error(friendlyMessage('INVALID_STATUS_TRANSITION'));
  return {
    body: { reservationId: String(reservationId) },
    headerToken: session.sessionToken,
  };
}