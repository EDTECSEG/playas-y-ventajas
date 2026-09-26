'use client';

// Modulo do motorista: cadastro, PIN, documentos e situacao da habilitacao.
//
// Os textos ficam em portugues literal, e nao em t.*, porque lib/i18n.js nao tem
// chave de motorista e o arquivo esta em alteracao por outro trabalho. Quando
// esse arquivo voltar a ser editavel, estas strings migram para la. Os codigos
// de erro usam um mapa local, como app/empresa/page.jsx faz com 'friendly'.

import { useEffect, useRef, useState } from 'react';
import Header from '../components/Header';
import ModuleSplash from '../components/ModuleSplash';
import { theme } from '../../lib/theme';

// Mesma convencao de app/cliente/page.jsx: o tenant e um unico, fixo no cliente.
const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

// Mesmo teto do servidor, para avisar antes de enviar 8 MB de base64.
const MAX_BYTES = 6 * 1024 * 1024;

const DOC_TYPES = [
  { value: 'cnh', label: 'CNH (carteira de motorista)' },
  { value: 'rg', label: 'RG (identidade)' },
  { value: 'crv', label: 'CRV (registro de veiculo)' },
];

const STATUS_LABEL = {
  pending: { text: 'Aguardando aprovacao da empresa', color: theme.goldDark, bg: '#FEF6E0' },
  approved: { text: 'Habilitado a dirigir', color: theme.green, bg: theme.greenLight },
  rejected: { text: 'Recusado - envie o documento de novo', color: '#B42318', bg: '#FEF3F2' },
  suspended: { text: 'Conta suspensa', color: '#B42318', bg: '#FEF3F2' },
};

const friendly = {
  TENANT_REQUIRED: 'Nao foi possivel identificar a empresa. Recarregue a pagina.',
  NAME_REQUIRED: 'Informe seu nome.',
  PHONE_INVALID: 'Informe um telefone valido.',
  EMAIL_INVALID: 'Informe um email valido.',
  PIN_INVALID: 'Informe um PIN valido.',
  PIN_MISMATCH: 'Os PINs nao batem.',
  DRIVER_ID_REQUIRED: 'Cadastro nao encontrado. Faca o cadastro de novo.',
  DOC_TYPE_INVALID: 'Escolha o tipo de documento.',
  FILE_REQUIRED: 'Escolha um arquivo.',
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
  'arquivo excede o limite de 6 MB': 'O arquivo passa de 6 MB.',
  'tipo de documento nao permitido (use PDF, JPEG ou PNG)': 'Use PDF, JPEG ou PNG.',
  'conteudo nao corresponde ao tipo informado': 'O conteudo do arquivo nao bate com o tipo escolhido.',
  'falha ao armazenar o documento': 'Nao foi possivel salvar o arquivo. Tente de novo.',
  'erro interno': 'Erro no servidor. Tente de novo.',
};

function say(code) {
  if (!code) return '';
  if (friendly[code]) return friendly[code];
  return String(code);
}

const wrap = { maxWidth: 720, margin: '0 auto', padding: '20px 20px 80px', color: theme.text };
const card = { background: theme.card, color: theme.text, borderRadius: 14, padding: 20, marginBottom: 16, border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)' };
const input = { padding: 9, borderRadius: 8, border: `1px solid ${theme.border}`, marginRight: 8, marginBottom: 8, width: '100%', boxSizing: 'border-box' };
const btn = { padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: theme.gold, color: theme.greenDark, fontWeight: 700, marginRight: 8 };
const smallBtn = { ...btn, padding: '5px 12px', fontSize: 12 };
const ghostBtn = { ...smallBtn, background: theme.green, color: '#FFFFFF' };
const label = { display: 'block', fontSize: 13, color: theme.textMuted, marginBottom: 4 };

async function call(name, { body, token } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/.netlify/functions/${name}`, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) throw new Error(say(data.error) || `HTTP ${res.status}`);
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

  // Sessao e cadastro pela metade sao reidratados do navegador: sem isso,
  // um recarregamento no meio da habilitacao perderia o uploadToken, que
  // so aparece uma vez.
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem('pyv_driver') || 'null');
      if (s && s.sessionToken) setSession(s);
      const p = JSON.parse(localStorage.getItem('pyv_driver_pending') || 'null');
      if (p && p.pinToken) setPending(p);
    } catch (e) {
      // localStorage corrompido nao pode impedir a tela de abrir.
    }
  }, []);

  function limparTudo() {
    setSession(null);
    setPending(null);
    setDocEnviado(null);
    setLogin({ phone: '', pin: '' });
    setPinForm({ pin: '', pin2: '' });
    localStorage.removeItem('pyv_driver');
    localStorage.removeItem('pyv_driver_pending');
  }

  async function run(fn, ok) {
    setOcupado(true);
    setErro('');
    setMsg('');
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (e) {
      setErro(say(e.message));
    } finally {
      setOcupado(false);
    }
  }

  const entrar = () => run(async () => {
    const data = await call('driver-login', {
      body: { tenantId: TENANT_ID, phone: login.phone.trim(), pin: login.pin },
    });
    // A RPC devolve {error: 'NOT_APPROVED'} com HTTP 200 quando o cadastro
    // existe mas nao esta aprovado. So o sessionToken e sucesso de verdade.
    if (!data.sessionToken) throw new Error(data.error || 'nao foi possivel entrar');
    localStorage.setItem('pyv_driver', JSON.stringify(data));
    setSession(data);
    setLogin({ phone: '', pin: '' });
    if (data.status !== 'approved') setPending(null);
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
    if (pinForm.pin !== pinForm.pin2) throw new Error(friendly.PIN_MISMATCH);
    if (String(pinForm.pin).length < 4) throw new Error('O PIN precisa ter pelo menos 4 digitos.');
    await call('driver-set-pin', {
      body: { tenantId: TENANT_ID, phone: pending.phone, pin: pinForm.pin, pinToken: pending.pinToken },
    });
    setPinForm({ pin: '', pin2: '' });
    // O PIN Defined consome o pinToken; uploadToken continua valido para os
    // documentos, porque ainda nao ha sessao.
    const p = { ...pending };
    delete p.pinToken;
    localStorage.setItem('pyv_driver_pending', JSON.stringify(p));
    setPending(p);
  }, 'PIN definido. Agora envie seus documentos e entre com telefone e PIN.');

  const enviarDoc = () => run(async () => {
    const file = fileRef.current && fileRef.current.files && fileRef.current.files[0];
    if (!file) throw new Error(friendly.FILE_REQUIRED);
    if (file.size > MAX_BYTES) throw new Error(friendly['arquivo excede o limite de 6 MB']);
    const fileBase64 = await readAsBase64(file);

    // Com sessao vai no header; sem sessao (montando o cadastro) usa o
    // uploadToken. O endpoint recusa os dois juntos, entao nunca mandamos os dois.
    const body = {
      tenantId: TENANT_ID,
      driverId: (session && session.driverId) || pending.driverId,
      docType: doc.docType,
      contentType: file.type,
      fileBase64,
      docNumber: doc.docNumber.trim() || null,
      docExpiresAt: doc.docExpiresAt || null,
    };
    if (!session) body.uploadToken = pending.uploadToken;

    const data = await call('driver-add-document', {
      body,
      token: session ? session.sessionToken : undefined,
    });
    setDocEnviado(data);
    if (fileRef.current) fileRef.current.value = '';
  }, 'Documento enviado. A empresa vai revisar.');

  const sair = () => run(async () => {
    if (session && session.sessionToken) {
      try { await call('driver-logout', { token: session.sessionToken }); } catch (e) { /* localmente ja saiu */ }
    }
    limparTudo();
  });

  const situacao = session ? session.status : pending ? pending.status : null;
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
              <p style={{ color: theme.textMuted, margin: 0 }}>
                PIN definido. Envie os documentos abaixo e depois entre com seu telefone e PIN.
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
