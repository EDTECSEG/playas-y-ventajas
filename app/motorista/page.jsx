'use client';

// Modulo do motorista: cadastro, PIN, documentos e situacao da habilitacao.
//
// Os textos ficam em portugues literal, e nao em t.*, porque lib/i18n.js nao tem
// chave de motorista e o arquivo esta em alteracao por outro trabalho. Quando
// esse arquivo voltar a ser editavel, estas strings migram para la.
//
// A parte que decide credencial e resposta esta em ./logic, que e puro e
// testado sem DOM. Este arquivo cuida de estado, fetch e render.

import { useEffect, useRef, useState } from 'react';
import Header from '../components/Header';
import ModuleSplash from '../components/ModuleSplash';
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
  localDateIso,
  sortRunsByTime,
  formatRunWhen,
  RUN_STATUS_LABEL,
  situationFor,
  sessionFromStorage,
  pendingFromStorage,
} from './logic';

// Rotulo e cor da situacao sao apresentacao, e ficam aqui com o theme. A
// logica de credencial, PIN e resposta vive em ./logic.
const STATUS_LABEL = {
  pending: { text: 'Aguardando aprovacao da empresa', color: theme.goldDark, bg: '#FEF6E0' },
  approved: { text: 'Habilitado a dirigir', color: theme.green, bg: theme.greenLight },
  rejected: { text: 'Recusado - envie o documento de novo', color: '#B42318', bg: '#FEF3F2' },
  suspended: { text: 'Conta suspensa', color: '#B42318', bg: '#FEF3F2' },
};

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
    r.onerror = () => reject(new Error('Nao foi possivel ler o arquivo.'));
    r.readAsDataURL(file);
  });
}

export default function MotoristaPage() {
  const [splashDone, setSplashDone] = useState(false);
  const [session, setSession] = useState(null);
  // Cadastro pela metade: guarda pinToken e uploadToken ate o PIN ser definido.
  const [pending, setPending] = useState(null);
  const [tab, setTab] = useState('entrar');
  const [msg, setMsg] = useState('');
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [login, setLogin] = useState({ phone: '', pin: '' });
  const [reg, setReg] = useState({ name: '', phone: '', email: '', inviteCode: '' });
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

  // So aprovado envia posicao. O telefone/mapa pede permissao de localizacao:
  // recusada diz exatamente isso, e nao "erro interno".
  const enviarPosicao = () => run(async () => {
    if (!navigator.geolocation) throw new Error(friendlyMessage('INVALID_COORDS'));
    const pos = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(
        (p) => res(p),
        () => rej(new Error(friendlyMessage('INVALID_COORDS'))),
        { enableHighAccuracy: true, timeout: 12000 },
      );
    });
    const { body, headerToken } = buildPositionRequest({
      session,
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      heading: pos.coords.heading,
      speedKmh: pos.coords.speed,
      shuttleId: servicoSel,
    });
    const data = await call('driver-position', { body, token: headerToken });
    setUltimaPos(data.recordedAt);
  }, 'Posicao enviada. Quem procura o translado ja ve seu veiculo no mapa.');

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
    const data = await call('driver-register', {
      body: {
        tenantId: TENANT_ID,
        name: reg.name.trim(),
        phone: reg.phone.trim(),
        email: reg.email.trim(),
        inviteCode: reg.inviteCode.trim() || null,
      },
    });
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
    setReg({ name: '', phone: '', email: '', inviteCode: '' });
  }, 'Cadastro criado. Defina seu PIN para continuar.');

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
  }, 'PIN definido e voce ja entrou. Envie seus documentos abaixo.');

  const enviarDoc = () => run(async () => {
    const file = fileRef.current && fileRef.current.files && fileRef.current.files[0];
    if (!file) throw new Error(friendlyMessage('FILE_REQUIRED'));
    if (file.size > MAX_BYTES) throw new Error('O arquivo passa de 6 MB.');
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
  }, 'Documento enviado. A empresa vai revisar.');

  const sair = () => run(async () => {
    if (session && session.sessionToken) {
      // driver-logout so aceita POST. Sem method explicito o call cairia em GET
      // e o servidor responderia 405, deixando a sessao viva no servidor
      // enquanto a tela ja mostrava o login.
      try { await call('driver-logout', { method: 'POST', body: {}, token: session.sessionToken }); } catch (e) { /* localmente ja saiu */ }
    }
    limparTudo();
  });

  const situacao = situationFor({ session, pending });
  const info = situacao ? STATUS_LABEL[situacao] : null;

  return (
    <>
      <ModuleSplash visible={!splashDone} onDone={() => setSplashDone(true)} />
      <Header title="Motorista" right={session ? (
        <button style={smallBtn} onClick={sair} disabled={ocupado}>Sair</button>
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
            <h3 style={{ marginTop: 0 }}>Ola, {session.name}</h3>
            <p style={{ color: theme.textMuted, marginTop: 0 }}>
              Telefone {session.phone} · documento {docEnviado ? 'enviado' : 'pendente'}
            </p>
            {/* Entrar no app e dirigir sao coisas separadas. Sem esta frase o
                motorista aprovado em documentos acha que ja esta na frota,
                e o que nao esta aprovado nao entende por que nao aparece. */}
            {!canDrive(session.status) ? (
              <p style={{ color: theme.textMuted, marginBottom: 0 }}>
                Voce entrou, mas ainda nao pode dirigir. Assim que a empresa aprovar seus
                documentos, voce passa a aparecer na lista de veiculos.
              </p>
            ) : null}
          </div>
        ) : null}

        {session && canDrive(session.status) ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Transmissao de posicao</h3>
            <p style={{ color: theme.textMuted, marginTop: 0 }}>
              Envie sua posicao atual para aparecer no translado ao vivo. O cliente ve seu
              veiculo enquanto a posicao tiver menos de 5 minutos.
            </p>
            <label style={label} htmlFor="servico">Servico em execucao (opcional)</label>
            <select id="servico" style={input} value={servicoSel} onChange={(e) => setServicoSel(e.target.value)}>
              <option value="">Em viagem (sem rotulo)</option>
              {servicos.map((s) => <option key={s.shuttleId} value={s.shuttleId}>{s.name}</option>)}
            </select>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button style={btn} onClick={enviarPosicao} disabled={ocupado}>Enviar posicao</button>
              <button style={ghostBtn} onClick={carregarServicos} disabled={ocupado}>Recarregar servicos</button>
            </div>
            {ultimaPos ? (
              <p style={{ color: theme.textMuted, marginBottom: 0 }}>
                Ultima posicao registrada as {new Date(ultimaPos).toLocaleTimeString()}.
              </p>
            ) : null}
          </div>
        ) : null}

        {session && canDrive(session.status) ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Minhas corridas de hoje</h3>
            <p style={{ color: theme.textMuted, marginTop: 0 }}>
              Reservas confirmadas da sua empresa em {localDateIso()}. Nao mostramos nome nem
              telefone do cliente: aqui e a agenda da rota.
            </p>
            {corridasErro ? (
              <p style={{ color: '#B42318', margin: 0 }}>{corridasErro}</p>
            ) : corridas.length === 0 ? (
              <p style={{ marginBottom: 0 }}>Nenhuma corrida confirmada para hoje.</p>
            ) : (
              corridas.map((c) => (
                <div key={c.reservationId} style={{
                  border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12,
                  marginTop: 8, background: theme.bg,
                }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ flex: 1, minWidth: 120 }}>{formatRunWhen(c.scheduledFor)}</strong>
                    <span style={{
                      fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                      background: c.status === 'completed' ? theme.greenLight : theme.gold,
                      color: c.status === 'completed' ? theme.green : theme.greenDark,
                    }}>{RUN_STATUS_LABEL[c.status] || c.status}</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>{c.serviceName}</div>
                  <div style={{ fontSize: 12, color: theme.textMuted }}>
                    {c.passengers} passageiro(s)
                    {c.durationMinutes ? ` · ${c.durationMinutes} min` : ''}
                  </div>
                  {c.status === 'confirmed' ? (
                    <button style={{ ...smallBtn, marginTop: 8 }} onClick={() => concluirCorrida(c)} disabled={ocupado}>
                      Concluir corrida
                    </button>
                  ) : null}
                </div>
              ))
            )}
            <div style={{ marginTop: 12 }}>
              <button style={ghostBtn} onClick={carregarCorridas} disabled={ocupado}>Recarregar corridas</button>
            </div>
          </div>
        ) : null}

        {pending && !session ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Falta pouco: defina seu PIN</h3>
            {pending.pinToken ? (
              <>
                <label style={label} htmlFor="pin">PIN de 4 ou mais digitos</label>
                <input id="pin" style={input} type="password" inputMode="numeric" value={pinForm.pin}
                  onChange={(e) => setPinForm({ ...pinForm, pin: e.target.value })} />
                <label style={label} htmlFor="pin2">Repita o PIN</label>
                <input id="pin2" style={input} type="password" inputMode="numeric" value={pinForm.pin2}
                  onChange={(e) => setPinForm({ ...pinForm, pin2: e.target.value })} />
                <button style={btn} onClick={definirPin} disabled={ocupado}>Salvar PIN</button>
              </>
            ) : (
              /* pinToken ja foi consumido, entao este estado so aparece se o
                 login automatico apos salvar o PIN nao completou. Da para
                 enviar documento por aqui mesmo, e o login fica na aba Entrar. */
              <p style={{ color: theme.textMuted, margin: 0 }}>
                PIN ja definido. Envie os documentos abaixo e entre pela aba Entrar com seu
                telefone e PIN.
              </p>
            )}
          </div>
        ) : null}

        {(session || pending) ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Documentos</h3>
            <label style={label} htmlFor="doctype">Tipo</label>
            <select id="doctype" style={input} value={doc.docType} onChange={(e) => setDoc({ ...doc, docType: e.target.value })}>
              {DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            <label style={label} htmlFor="docnum">Numero (opcional)</label>
            <input id="docnum" style={input} value={doc.docNumber}
              onChange={(e) => setDoc({ ...doc, docNumber: e.target.value })} />
            <label style={label} htmlFor="docexp">Validade (opcional)</label>
            <input id="docexp" style={input} type="date" value={doc.docExpiresAt}
              onChange={(e) => setDoc({ ...doc, docExpiresAt: e.target.value })} />
            <label style={label} htmlFor="docfile">Arquivo (PDF, JPEG ou PNG, ate 6 MB)</label>
            <input id="docfile" ref={fileRef} style={input} type="file" accept="application/pdf,image/jpeg,image/png" />
            <button style={btn} onClick={enviarDoc} disabled={ocupado}>Enviar documento</button>
            {situacao === 'rejected' ? (
              <p style={{ color: theme.textMuted, marginBottom: 0 }}>
                Seu cadastro foi recusado. Envie o documento corrigido para nova analise.
              </p>
            ) : null}
          </div>
        ) : null}

        {!session && !pending ? (
          <div style={card}>
            <button style={{ ...smallBtn, background: tab === 'entrar' ? theme.green : theme.greenLight, color: tab === 'entrar' ? '#FFF' : theme.greenDark }}
              onClick={() => setTab('entrar')}>Entrar</button>
            <button style={{ ...smallBtn, background: tab === 'cadastrar' ? theme.green : theme.greenLight, color: tab === 'cadastrar' ? '#FFF' : theme.greenDark }}
              onClick={() => setTab('cadastrar')}>Cadastrar</button>

            {tab === 'entrar' ? (
              <div style={{ marginTop: 16 }}>
                <label style={label} htmlFor="lphone">Telefone</label>
                <input id="lphone" style={input} value={login.phone}
                  onChange={(e) => setLogin({ ...login, phone: e.target.value })} />
                <label style={label} htmlFor="lpin">PIN</label>
                <input id="lpin" style={input} type="password" inputMode="numeric" value={login.pin}
                  onChange={(e) => setLogin({ ...login, pin: e.target.value })} />
                <button style={btn} onClick={entrar} disabled={ocupado}>Entrar</button>
              </div>
            ) : (
              <div style={{ marginTop: 16 }}>
                <label style={label} htmlFor="rname">Nome completo</label>
                <input id="rname" style={input} value={reg.name}
                  onChange={(e) => setReg({ ...reg, name: e.target.value })} />
                <label style={label} htmlFor="rphone">Telefone</label>
                <input id="rphone" style={input} value={reg.phone}
                  onChange={(e) => setReg({ ...reg, phone: e.target.value })} />
                <label style={label} htmlFor="remail">Email</label>
                <input id="remail" style={input} type="email" value={reg.email}
                  onChange={(e) => setReg({ ...reg, email: e.target.value })} />
                <label style={label} htmlFor="rcode">Codigo de convite (opcional)</label>
                <input id="rcode" style={input} value={reg.inviteCode}
                  onChange={(e) => setReg({ ...reg, inviteCode: e.target.value })} />
                <button style={btn} onClick={cadastrar} disabled={ocupado}>Criar cadastro</button>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
