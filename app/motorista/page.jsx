'use client';

// Modulo do motorista: cadastro, PIN, documentos e situacao da habilitacao.
//
// A parte que decide credencial e resposta esta em ./logic, que e puro e
// testado sem DOM. Este arquivo cuida de estado, fetch e render. Os textos
// de apresentacao usam t.* de lib/i18n, como as demais telas.

import { useEffect, useRef, useState } from 'react';
import Header from '../components/Header';
import PasswordInput from '../components/PasswordInput';
import ModuleSplash from '../components/ModuleSplash';
import { useLanguage } from '../../lib/LanguageContext';
import { theme } from '../../lib/theme';
import {
  TENANT_ID,
  MAX_BYTES,
  DOC_TYPES,
  friendlyMessage,
  interpretLogin,
  canDrive,
  checkPin,
  pinConsumed,
  buildDocumentRequest,
  buildPositionRequest,
  buildRunsRequest,
  buildCompleteRunRequest,
  AUTO_POSITION_MS,
  shouldAutoSend,
  accuracyOk,
  accuracyText,
  positionTransmitStatus,
  localDateIso,
  sortRunsByTime,
  formatRunWhen,
  situationFor,
  sessionFromStorage,
  pendingFromStorage,
  buildRegisterRequest,
  maskCpf,
  maskCnpj,
  digitsOnly,
} from './logic';

// Rotulo e cor da situacao sao apresentacao, e ficam aqui com o theme. A
// logica de credencial, PIN e resposta vive em ./logic. O rotulo traduzido
// vem do dict i18n (driverStatus*), montado dentro do componente por causa
// do hook useLanguage.
const wrap = { maxWidth: 720, margin: '0 auto', padding: '20px 20px 80px', color: theme.text };
const card = { background: theme.card, color: theme.text, borderRadius: 14, padding: 20, marginBottom: 16, border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)' };
const input = { padding: 9, borderRadius: 8, border: `1px solid ${theme.border}`, marginRight: 8, marginBottom: 8, width: '100%', boxSizing: 'border-box' };
const btn = { padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: theme.gold, color: theme.greenDark, fontWeight: 700, marginRight: 8 };
const smallBtn = { ...btn, padding: '5px 12px', fontSize: 12 };
const ghostBtn = { ...smallBtn, background: theme.green, color: '#FFFFFF' };
const label = { display: 'block', fontSize: 13, color: theme.textMuted, marginBottom: 4 };

async function call(name, { body, token, method } = {}) {
  const headers = {};
  // method explicito quando o endpoint so aceita POST, como driver-logout.
  const verb = method || (body ? 'POST' : 'GET');
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/.netlify/functions/${name}`, {
    method: verb,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(friendlyMessage(data.error) || `HTTP ${res.status}`);
  return data;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error(friendlyMessage('FILE_UNREADABLE')));
    r.readAsDataURL(file);
  });
}

export default function MotoristaPage() {
  const { lang, t } = useLanguage();
  const STATUS_LABEL = {
    pending: { text: t.driverStatusPending, color: theme.goldDark, bg: '#FEF6E0' },
    approved: { text: t.driverStatusApproved, color: theme.green, bg: theme.greenLight },
    rejected: { text: t.driverStatusRejected, color: '#B42318', bg: '#FEF3F2' },
    suspended: { text: t.driverStatusSuspended, color: '#B42318', bg: '#FEF3F2' },
  };
  const fmt = (s, params) => s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(params, k) ? params[k] : m));
  const [splashDone, setSplashDone] = useState(false);
  const [session, setSession] = useState(null);
  // Cadastro pela metade: guarda pinToken e uploadToken ate o PIN ser definido.
  const [pending, setPending] = useState(null);
  const [tab, setTab] = useState('entrar');
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [login, setLogin] = useState({ phone: '', pin: '' });
  const [reg, setReg] = useState({ name: '', phone: '', email: '', cpf: '', cnpj: '', legalName: '', inviteCode: '' });
  const [pinForm, setPinForm] = useState({ pin: '', pin2: '' });
  const [doc, setDoc] = useState({ docType: 'cnh', docNumber: '', docExpiresAt: '' });
  const [docEnviado, setDocEnviado] = useState(null);
  const fileRef = useRef(null);
  // Transmissao de posicao (translado ao vivo). `servicos` vem do endpoint
  // publico shuttle (so GET), para o motorista rotular em qual rota esta.
  const [servicos, setServicos] = useState([]);
  const [servicoSel, setServicoSel] = useState('');
  const [ultimaPos, setUltimaPos] = useState(null);
  // Corridas do dia (driver-shuttle-runs). `corridasErro` e separado da lista
  // pelo mesmo motivo do cliente: "nenhuma corrida hoje" e "nao consegui
  // carregar" sao coisas diferentes, e mostrar a primeira com o servidor quebrado
  // faz o motorista achar que foi escalado para outra empresa.
  const [corridas, setCorridas] = useState([]);
  const [corridasErro, setCorridasErro] = useState('');

  // Transmissao automatica de posicao. Comeca desligada: ligar no primeiro
  // render gastaria GPS sem o motorista ter pedido. `abaVisivel` alimenta o
  // portao de visibilidade de shouldAutoSend (GPS aceso com a aba escondida nao
  // serve para ninguem). `autoErrRef` e um contador de falhas silencioso: o
  // ciclo repete a cada 30s e o unico motivo real de falhar (permissao negada)
  // ja e avisado pelo botao manual, entao nao vale cobrir a tela de vermelho.
  const [autoOn, setAutoOn] = useState(false);
  const [abaVisivel, setAbaVisivel] = useState(true);
  // Raio de confianca (m) do ultimo fix lido. Existe para a tela avisar quando o
  // GPS esta fraco — tipicamente um computador, que localiza por Wi-Fi/IP.
  const [precisao, setPrecisao] = useState(null);
  const autoErrRef = useRef(0);
  // Relogio proprio da tela. O status "expirada" depende do tempo que passou,
  // e tempo que passou nao muda nenhum outro estado: sem este tick, a linha
  // ficaria "transmitindo" para sempre apos o pin sumir do mapa do cliente.
  // 10 s e folga suficiente para virar stale logo apos os 300 s do servidor.
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

  // Sessao e cadastro pela metade sao reidratados do navegador. O guarda de
  // cada um esta em ./logic: o cadastro pela metade e conferido por
  // uploadToken, e nao por pinToken, que ja foi consumido quando o PIN foi
  // definido. Errar isso aqui esconde o bloco de documentos depois de um
  // recarregamento e deixa o motorista sem caminho para se habilitar.
  useEffect(() => {
    setSession(sessionFromStorage(localStorage.getItem('pyv_driver')));
    setPending(pendingFromStorage(localStorage.getItem('pyv_driver_pending')));
  }, []);

  // Carrega os servicos de translado do tenant quando o motorista esta
  // habilitado (approved), para o bloco de posicao. Sem isso a lista so se
  // encheria no click, e a tela abriria vazia apos o login.
  useEffect(() => {
    if (canDrive(session && session.status)) carregarServicos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Agenda do dia entra junto com os servicos: quem nao esta na frota (pending/
  // rejected) nao tem corrida nenhuma, e o card nem aparece.
  useEffect(() => {
    if (canDrive(session && session.status)) carregarCorridas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  function limparTudo() {
    setSession(null);
    setPending(null);
    setDocEnviado(null);
    setUltimaPos(null);
    setPrecisao(null);
    setServicos([]);
    setLogin({ phone: '', pin: '' });
    setPinForm({ pin: '', pin2: '' });
    localStorage.removeItem('pyv_driver');
    localStorage.removeItem('pyv_driver_pending');
  }

  // Lista de ofertas de translado (sao publicas no mapa do cliente; aqui
  // servem so para o motorista escolher em qual rota esta).
  async function carregarServicos() {
    try {
      const res = await fetch(`/.netlify/functions/shuttle?tenantId=${TENANT_ID}`);
      const data = await res.json();
      if (res.ok) {
        setServicos(data && data.services ? data.services : []);
        // Se a rota escolhida sumiu (desativada/apagada), volta para "sem rotulo".
        setServicoSel((atual) => {
          const valido = (data.services || []).some((s) => String(s.shuttleId) === String(atual));
          return valido ? atual : '';
        });
      }
    } catch (e) {
      setServicos([]);
    }
  }

  // Corridas de hoje da frota do motorista. A ordem, a formatacao e a credencial
  // sao decididas em ./logic; aqui e so estado, fetch e render. O `call` ja
  // traduz o {error} do servidor em texto e o 401/403 chega como NOT_APPROVED /
  // SESSION_EXPIRED, entao o catch nao precisa adivinhar codigo.
  async function carregarCorridas() {
    try {
      const req = buildRunsRequest({ session });
      const data = await call(`driver-shuttle-runs${req.query}`, { token: req.headerToken });
      setCorridas(sortRunsByTime(Array.isArray(data.runs) ? data.runs : []));
      setCorridasErro('');
    } catch (e) {
      setCorridas([]);
      setCorridasErro(e.message || friendlyMessage('erro interno'));
    }
  }

  async function concluirCorrida(corrida) {
    const req = buildCompleteRunRequest({ session, reservationId: corrida.reservationId, status: corrida.status });
    await run(async () => {
      await call('driver-shuttle-runs', { body: req.body, token: req.headerToken });
      // Recarrega em vez de remendar o array: a empresa ve o 'completed' na
      // fila e o horario do dia continua inteiro.
      await carregarCorridas();
    });
  }

  // Envio cru de posicao, sem tocar em estado de UI (fora da precisao). E o corpo
  // comum do botao manual e do ciclo automatico; o botao envolve em run() para
  // ter "enviado" e erro visivel, e o automatico chama direto para poder falhar
  // em silencio.
  //
  // `requireAccuracy` e a trava contra o palpite por IP: sem GPS proprio (num
  // computador), o navegador devolve accuracy enorme e a posicao aponta para o no
  // da operadora. O envio automatico so passa com accuracyOk; o manual (acao
  // explicita) transmite, mas a tela mostra que a precisao esta ruim.
  async function transmitirPosicao({ requireAccuracy = false } = {}) {
    if (!navigator.geolocation) throw new Error(friendlyMessage('INVALID_COORDS'));
    const pos = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(
        (p) => res(p),
        () => rej(new Error(friendlyMessage('INVALID_COORDS'))),
        { enableHighAccuracy: true, timeout: 12000 },
      );
    });
    const accuracy = pos.coords.accuracy;
    setPrecisao(accuracy);
    if (requireAccuracy && !accuracyOk(accuracy)) {
      const err = new Error(friendlyMessage('INVALID_COORDS'));
      err.weakGps = true;
      throw err;
    }
    const { body, headerToken } = buildPositionRequest({
      session,
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      heading: pos.coords.heading,
      speedKmh: pos.coords.speed,
      shuttleId: servicoSel,
      accuracyM: accuracy,
    });
    return call('driver-position', { body, token: headerToken });
  }

  // So aprovado envia posicao. O telefone/mapa pede permissao de localizacao:
  // recusada diz exatamente isso, e nao "erro interno".
  const enviarPosicao = () => run(async () => {
    const data = await transmitirPosicao();
    setUltimaPos(data.recordedAt);
  }, t.posSentOk);

  // Ciclo automatico. Reage a autoOn/session/servicoSel/abaVisivel: desligar,
  // trocar de rota, sair da frota ou esconder a aba derruba o interval e evita
  // enviar posicao de uma configuracao que ja mudou.
  useEffect(() => {
    if (!shouldAutoSend({ enabled: autoOn, status: session && session.status, visible: abaVisivel })) return;
    const id = setInterval(async () => {
      try {
        const data = await transmitirPosicao({ requireAccuracy: true });
        autoErrRef.current = 0;
        setUltimaPos(data.recordedAt);
      } catch (e) {
        autoErrRef.current += 1;
      }
    }, AUTO_POSITION_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn, session, servicoSel, abaVisivel]);

  // A visibilidade da aba e o portao que evita GPS ligado com a tela escondida.
  useEffect(() => {
    const onVis = () => setAbaVisivel(!document.hidden);
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  function toggleAutoPosition() {
    setAutoOn((v) => !v);
    autoErrRef.current = 0;
  }

  async function run(fn, ok) {
    setOcupado(true);
    setErro('');
    setMsg('');
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (e) {
      setErro(friendlyMessage(e.message));
    } finally {
      setOcupado(false);
    }
  }

  // Faz o login e guarda a sessao. Compartilhado pelo botao Entrar e pelo
  // passo automatico depois de definir o PIN, para os dois nao divergirem.
  //
  // Limpar o cadastro pela metade aqui e obrigatorio: a sessao passa a mandar,
  // e e ela que autoriza o envio dos documentos. Sem isso, a tela continuaria
  // mostrando "defina seu PIN" depois de ja estar logado.
  async function autenticar(phone, pin) {
    const data = await call('driver-login', {
      body: { tenantId: TENANT_ID, phone: phone.trim(), pin },
    });
    // A RPC devolve {error: ...} no corpo quando recusa, com HTTP 403. So o
    // sessionToken e sucesso, e e interpretLogin que decide isso.
    const r = interpretLogin(data);
    if (!r.ok) throw new Error(r.error);
    localStorage.setItem('pyv_driver', JSON.stringify(r.session));
    setSession(r.session);
    localStorage.removeItem('pyv_driver_pending');
    setPending(null);
    return r.session;
  }

  const entrar = () => run(async () => {
    await autenticar(login.phone, login.pin);
    setLogin({ phone: '', pin: '' });
  });

  const cadastrar = () => run(async () => {
    // buildRegisterRequest valida CPF/CNPJ antes da rede. Alem de dar a mensagem
    // em portugues, isso evita consumir a taxa de 20 cadastros/hora do tenant a
    // cada erro de digitacao -- cota que existe para segurar robo, e que um
    // motorista real errando o CPF five vezes pagaria com o proprio cadastro.
    const payload = buildRegisterRequest({
      tenantId: TENANT_ID,
      name: reg.name,
      phone: reg.phone,
      email: reg.email,
      cpf: reg.cpf,
      cnpj: reg.cnpj,
      legalName: reg.legalName,
      inviteCode: reg.inviteCode,
    });

    const data = await call('driver-register', { body: payload });
    // pinToken e uploadToken aparecem so agora. Ficam no navegador porque o
    // cadastro ainda nao tem sessao; o proximo passo e definir o PIN.
    const p = {
      driverId: data.driverId,
      status: data.status,
      phone: reg.phone.trim(),
      pinToken: data.pinToken,
      uploadToken: data.uploadToken,
    };
    localStorage.setItem('pyv_driver_pending', JSON.stringify(p));
    setPending(p);
    setReg({ name: '', phone: '', email: '', cpf: '', cnpj: '', legalName: '', inviteCode: '' });
  }, t.regCreatedOk);

  const definirPin = () => run(async () => {
    checkPin(pinForm.pin, pinForm.pin2);
    await call('driver-set-pin', {
      body: { tenantId: TENANT_ID, phone: pending.phone, pin: pinForm.pin, pinToken: pending.pinToken },
    });
    setPinForm({ pin: '', pin2: '' });
    // O PIN definido consome o pinToken no servidor, entao tira o pinToken do
    // navegador antes de qualquer outra coisa. O uploadToken fica: e ele que
    // ainda autoriza o envio de documento caso o login logo abaixo falhe.
    const p = pinConsumed(pending);
    localStorage.setItem('pyv_driver_pending', JSON.stringify(p));
    setPending(p);
    // O login nao depende mais de aprovacao, entao entra na hora, sem o
    // motorista digitar telefone e PIN de novo.
    await autenticar(p.phone, pinForm.pin);
  }, t.pinDoneOk);

  const enviarDoc = () => run(async () => {
    const file = fileRef.current && fileRef.current.files && fileRef.current.files[0];
    if (!file) throw new Error(friendlyMessage('FILE_REQUIRED'));
    if (file.size > MAX_BYTES) throw new Error(friendlyMessage('FILE_TOO_LARGE'));
    const fileBase64 = await readAsBase64(file);

    // buildDocumentRequest decide a credencial: com sessao vai no header, sem
    // sessao usa uploadToken no corpo, e nunca os dois, que o endpoint recusa.
    const { body, headerToken } = buildDocumentRequest({
      session,
      pending,
      docType: doc.docType,
      fileBase64,
      contentType: file.type,
      docNumber: doc.docNumber,
      docExpiresAt: doc.docExpiresAt,
    });

    const data = await call('driver-add-document', { body, token: headerToken });
    setDocEnviado(data);
    if (fileRef.current) fileRef.current.value = '';
  }, t.docSentOk);

  const sair = () => run(async () => {
    if (session && session.sessionToken) {
      // driver-logout so aceita POST. Sem method explicito o call cairia em GET
      // e o servidor responderia 405, deixando a sessao viva no servidor
      // enquanto a tela ja mostrava o login.
      try { await call('driver-logout', { method: 'POST', body: {}, token: session.sessionToken }); } catch (e) { /* localmente ja saiu */ }
    }
    limparTudo();
  });

  // Saida do estado preso: o cadastro pela metade estava em pending mas o login
  // automatico apos definir o PIN nao completou. As abas Entrar/Cadastrar so
  // aparecem sem pending, entao sem este botao o motorista fica preso na tela de
  // PIN/documentos para sempre, mesmo com o cadastro ja aprovado pela empresa.
  const irParaLogin = () => {
    localStorage.removeItem('pyv_driver_pending');
    setPending(null);
    setTab('entrar');
  };

  const situacao = situationFor({ session, pending });
  const info = situacao ? STATUS_LABEL[situacao] : null;

  return (
    <>
      <ModuleSplash visible={!splashDone} onDone={() => setSplashDone(true)} />
      <Header title={t.motoristaTitle} right={session ? (
        <button style={smallBtn} onClick={sair} disabled={ocupado}>{t.logout}</button>
      ) : null} />

      <div style={wrap}>
        {erro ? (
          <div style={{ ...card, background: '#FEF3F2', borderColor: '#FDA29B', color: '#B42318' }}>{erro}</div>
        ) : null}
        {msg ? (
          <div style={{ ...card, background: theme.greenLight, borderColor: '#A6DFC4', color: theme.greenDark }}>{msg}</div>
        ) : null}

        {info ? (
          <div style={{ ...card, background: info.bg, borderColor: theme.border }}>
            <strong style={{ color: info.color }}>{info.text}</strong>
          </div>
        ) : null}

        {session ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{fmt(t.helloName, { name: session.name })}</h3>
            <p style={{ color: theme.textMuted, marginTop: 0 }}>
              {fmt(t.driverHeaderDoc, { phone: session.phone, status: docEnviado ? t.docSent : t.docPending })}
            </p>
            {/* Entrar no app e dirigir sao coisas separadas. Sem esta frase o
                motorista aprovado em documentos acha que ja esta na frota,
                e o que nao esta aprovado nao entende por que nao aparece. */}
            {!canDrive(session.status) ? (
              <p style={{ color: theme.textMuted, marginBottom: 0 }}>
                {t.notApprovedNote}
              </p>
            ) : null}
          </div>
        ) : null}

        {session && canDrive(session.status) ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.posTitle}</h3>
            <p style={{ color: theme.textMuted, marginTop: 0 }}>
              {t.posHint}
            </p>
            <label style={label} htmlFor="servico">{t.posServiceLabel}</label>
            <select id="servico" style={input} value={servicoSel} onChange={(e) => setServicoSel(e.target.value)}>
              <option value="">{t.posNoLabel}</option>
              {servicos.map((s) => <option key={s.shuttleId} value={s.shuttleId}>{s.name}</option>)}
            </select>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button style={btn} onClick={enviarPosicao} disabled={ocupado}>{t.posSend}</button>
              <button
                style={{ ...btn, background: autoOn ? '#B42318' : theme.green, color: '#FFFFFF' }}
                onClick={toggleAutoPosition}
                aria-pressed={autoOn}
              >
                {autoOn ? t.posAutoStop : t.posAutoStart}
              </button>
              <button style={ghostBtn} onClick={carregarServicos} disabled={ocupado}>{t.posReloadServices}</button>
            </div>
            {(() => {
              const status = positionTransmitStatus({ autoOn, lastSentAt: ultimaPos, nowMs: agora });
              const min = ultimaPos ? Math.max(1, Math.round((agora - Date.parse(ultimaPos)) / 60000)) : 0;
              const linha = {
                off: { cor: '#B42318', txt: t.posStatusOff },
                'off-sent': { cor: '#B42318', txt: t.posStatusOffSent },
                none: { cor: '#B42318', txt: t.posStatusNone },
                stale: { cor: '#B42318', txt: fmt(t.posStatusStale, { min: String(min) }) },
                fresh: { cor: theme.green, txt: t.posStatusFresh },
              }[status];
              return <p style={{ color: linha.cor, marginBottom: 0 }}>{linha.txt}</p>;
            })()}
            {precisao !== null && precisao !== undefined ? (
              <p style={{ color: accuracyOk(precisao) ? theme.textMuted : '#B42318', marginBottom: 0 }}>
                {t.posAccuracy.replace('{value}', accuracyText(precisao))}
                {accuracyOk(precisao) ? '' : ` ${t.posGpsWeak}`}
              </p>
            ) : null}
            {ultimaPos ? (
              <p style={{ color: theme.textMuted, marginBottom: 0 }}>
                {fmt(t.posLast, { time: new Date(ultimaPos).toLocaleTimeString(lang === 'en' ? 'en-US' : lang === 'es' ? 'es-ES' : 'pt-BR') })}
              </p>
            ) : null}
          </div>
        ) : null}

        {session && canDrive(session.status) ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.runsTitle}</h3>
            <p style={{ color: theme.textMuted, marginTop: 0 }}>
              {fmt(t.runsHint, { date: localDateIso() })}
            </p>
            {corridasErro ? (
              <p style={{ color: '#B42318', margin: 0 }}>{corridasErro}</p>
            ) : corridas.length === 0 ? (
              <p style={{ marginBottom: 0 }}>{t.runsEmpty}</p>
            ) : (
              corridas.map((c) => (
                <div key={c.reservationId} style={{
                  border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12,
                  marginTop: 8, background: theme.bg,
                }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ flex: 1, minWidth: 120 }}>{formatRunWhen(c.scheduledFor, lang)}</strong>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                      background: c.status === 'completed' ? theme.greenLight : theme.gold,
                      color: c.status === 'completed' ? theme.green : theme.greenDark,
                    }}>{c.status === 'confirmed' ? t.runStatusConfirmed : c.status === 'completed' ? t.runStatusCompleted : (c.status || '')}</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>{c.serviceName}</div>
                  <div style={{ fontSize: 12, color: theme.textMuted }}>
                    {c.passengers} {t.runPassengers}
                    {c.durationMinutes ? ` · ${c.durationMinutes} min` : ''}
                  </div>
                  {c.status === 'confirmed' ? (
                    <button style={{ ...smallBtn, marginTop: 8 }} onClick={() => concluirCorrida(c)} disabled={ocupado}>
                      {t.completeRun}
                    </button>
                  ) : null}
                </div>
              ))
            )}
            <div style={{ marginTop: 12 }}>
              <button style={ghostBtn} onClick={carregarCorridas} disabled={ocupado}>{t.reloadRuns}</button>
            </div>
          </div>
        ) : null}

        {pending && !session ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.pinTitle}</h3>
            {pending.pinToken ? (
              <>
                <label style={label} htmlFor="pin">{t.pinLabel}</label>
                <PasswordInput id="pin" style={input} inputMode="numeric" value={pinForm.pin}
                  onChange={(e) => setPinForm({ ...pinForm, pin: e.target.value })} />
                <label style={label} htmlFor="pin2">{t.pinConfirm}</label>
                <PasswordInput id="pin2" style={input} inputMode="numeric" value={pinForm.pin2}
                  onChange={(e) => setPinForm({ ...pinForm, pin2: e.target.value })} />
                <button style={btn} onClick={definirPin} disabled={ocupado}>{t.pinSave}</button>
              </>
            ) : (
              /* pinToken ja foi consumido, entao este estado so aparece se o
                 login automatico apos salvar o PIN nao completou. O botao
                 abaixo e a unica saida: sem ele o motorista fica preso aqui,
                 porque as abas Entrar/Cadastrar so aparecem sem pending. */
              <p style={{ color: theme.textMuted, margin: 0 }}>
                {t.pinAlreadySet}
              </p>
            )}
            <div style={{ marginTop: 10 }}>
              <button style={ghostBtn} onClick={irParaLogin}>{t.goToLogin}</button>
            </div>
          </div>
        ) : null}

        {(session || pending) ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.docTitle}</h3>
            {canDrive(session && session.status) ? (
              /* Reenviar documento com cadastro aprovado rebaixa o motorista
                 de novo para pending (driver_add_document). Deixar o botao
                 visivel aqui seria convidar o motorista a desfazer a propria
                 aprovacao; para approved a tela so confirma a situacao. */
              <p style={{ color: theme.textMuted, margin: 0 }}>
                {t.docApprovedNote}
              </p>
            ) : (
            <>
            <label style={label} htmlFor="doctype">{t.docType}</label>
            <select id="doctype" style={input} value={doc.docType} onChange={(e) => setDoc({ ...doc, docType: e.target.value })}>
              {DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{t[d.value === 'cnh' ? 'docCnh' : d.value === 'rg' ? 'docRg' : 'docCrv']}</option>)}
            </select>
            <label style={label} htmlFor="docnum">{t.docNumber}</label>
            <input id="docnum" style={input} value={doc.docNumber}
              onChange={(e) => setDoc({ ...doc, docNumber: e.target.value })} />
            <label style={label} htmlFor="docexp">{t.docExpiry}</label>
            <input id="docexp" style={input} type="date" value={doc.docExpiresAt}
              onChange={(e) => setDoc({ ...doc, docExpiresAt: e.target.value })} />
            <label style={label} htmlFor="docfile">{t.docFile}</label>
            <input id="docfile" ref={fileRef} style={input} type="file" accept="application/pdf,image/jpeg,image/png" />
            <button style={btn} onClick={enviarDoc} disabled={ocupado}>{t.docSend}</button>
            {situacao === 'rejected' ? (
              <p style={{ color: theme.textMuted, marginBottom: 0 }}>
                {t.docRejected}
              </p>
            ) : null}
            </>
            )}
          </div>
        ) : null}

        {!session && !pending ? (
          <div style={card}>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
              <button style={{ ...smallBtn, background: tab === 'entrar' ? theme.green : theme.greenLight, color: tab === 'entrar' ? '#FFF' : theme.greenDark }}
                onClick={() => setTab('entrar')}>{t.driverEnter}</button>
              <button style={{ ...smallBtn, background: tab === 'cadastrar' ? theme.green : theme.greenLight, color: tab === 'cadastrar' ? '#FFF' : theme.greenDark }}
                onClick={() => setTab('cadastrar')}>{t.driverRegisterTab}</button>
            </div>

            {tab === 'entrar' ? (
              <div style={{ marginTop: 16 }}>
                <label style={label} htmlFor="lphone">{t.driverPhoneLabel}</label>
                <input id="lphone" style={input} value={login.phone}
                  onChange={(e) => setLogin({ ...login, phone: e.target.value })} />
                <label style={label} htmlFor="lpin">{t.driverPinLabel}</label>
                <PasswordInput id="lpin" style={input} inputMode="numeric" value={login.pin}
                  onChange={(e) => setLogin({ ...login, pin: e.target.value })} />
                <button style={btn} onClick={entrar} disabled={ocupado}>{t.driverEnter}</button>
              </div>
            ) : (
              <div style={{ marginTop: 16 }}>
                <label style={label} htmlFor="rname">{t.driverFullName}</label>
                <input id="rname" style={input} value={reg.name}
                  onChange={(e) => setReg({ ...reg, name: e.target.value })} />
                <label style={label} htmlFor="rphone">{t.driverPhoneLabel}</label>
                <input id="rphone" style={input} value={reg.phone}
                  onChange={(e) => setReg({ ...reg, phone: e.target.value })} />
                <label style={label} htmlFor="remail">{t.driverEmail}</label>
                <input id="remail" style={input} type="email" value={reg.email}
                  onChange={(e) => setReg({ ...reg, email: e.target.value })} />
                <label style={label} htmlFor="rcpf">{t.driverCpfLabel}</label>
                <input id="rcpf" style={input} inputMode="numeric" value={reg.cpf}
                  onChange={(e) => setReg({ ...reg, cpf: maskCpf(e.target.value) })} />
                <label style={label} htmlFor="rcnpj">{t.driverCnpjLabel}</label>
                <input id="rcnpj" style={input} inputMode="numeric" value={reg.cnpj}
                  onChange={(e) => setReg({ ...reg, cnpj: maskCnpj(e.target.value) })} />
                {/* A razao so aparece quando ha CNPJ. Esconder atrelado ao campo
                    evita a pergunta "para que serve isso?" de quem e autonomo e
                    nao tem empresa. */}
                {digitsOnly(reg.cnpj) && (
                  <>
                    <label style={label} htmlFor="rlegal">{t.driverLegalNameLabel}</label>
                    <input id="rlegal" style={input} value={reg.legalName}
                      onChange={(e) => setReg({ ...reg, legalName: e.target.value })} />
                  </>
                )}
                <label style={label} htmlFor="rcode">{t.driverInviteCode}</label>
                <input id="rcode" style={input} value={reg.inviteCode}
                  onChange={(e) => setReg({ ...reg, inviteCode: e.target.value })} />
                <button style={btn} onClick={cadastrar} disabled={ocupado}>{t.driverCreate}</button>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
