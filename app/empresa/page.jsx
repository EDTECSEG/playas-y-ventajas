'use client';

import { useRef, useState } from 'react';
import { useLanguage } from '../../lib/LanguageContext';
import Header from '../components/Header';
import ModuleSplash from '../components/ModuleSplash';
import { theme } from '../../lib/theme';

function loadQrScanner() {
  return new Promise((resolve) => {
    if (window.Html5Qrcode) return resolve(window.Html5Qrcode);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    script.onload = () => resolve(window.Html5Qrcode);
    document.body.appendChild(script);
  });
}

async function uploadImage(file, folder, sessionToken) {
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const headers = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
  const res = await fetch('/.netlify/functions/upload-image', {
    method: 'POST',
    headers,
    body: JSON.stringify({ base64, contentType: file.type, folder }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.url;
}


const wrap = { maxWidth: 720, margin: '0 auto', padding: '20px 20px 80px', color: theme.text };
const card = { background: theme.card, color: theme.text, borderRadius: 14, padding: 20, marginBottom: 16, border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)' };
const input = { padding: 9, borderRadius: 8, border: `1px solid ${theme.border}`, marginRight: 8, marginBottom: 8 };
const btn = { padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: theme.gold, color: theme.greenDark, fontWeight: 700, marginRight: 8 };
const smallBtn = { ...btn, padding: '5px 12px', fontSize: 12 };

export default function EmpresaPage() {
  const { t } = useLanguage();
  const [splashDone, setSplashDone] = useState(false);
  const [session, setSession] = useState(null);
  const [form, setForm] = useState({ tenantSlug: 'playas-y-ventajas', internalCode: '', pin: '' });
  const [dash, setDash] = useState(null);
  const [msg, setMsg] = useState('');
  const [campaignTitle, setCampaignTitle] = useState('Nova campanha');
  const [templateForm, setTemplateForm] = useState({ campaignId: '', title: '10% OFF', benefitType: 'DISCOUNT_PERCENT', benefitValue: 10, totalStock: '', imageUrl: '' });
  const [stats, setStats] = useState(null);
  const [justCreatedTemplate, setJustCreatedTemplate] = useState(null);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [tab, setTab] = useState('criar');
  const [myData, setMyData] = useState({ name: '', phone: '', email: '', city: '', logoUrl: '', lat: '', lng: '' });
  const [mustChangePin, setMustChangePin] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [newPin2, setNewPin2] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [regForm, setRegForm] = useState({
    tenantSlug: 'playas-y-ventajas', name: '', category: 'passeio', city: '', phone: '', email: '',
    cnpj: '', website: '', logoUrl: '', lat: '', lng: '', internalCode: '', pin: '', pin2: '',
  });

  async function registerBusiness() {
    if (regForm.name.length < 2) { setMsg('Informe o nome da empresa.'); return; }
    if (regForm.internalCode.length < 2) { setMsg('Informe um código de login.'); return; }
    if (regForm.pin.length < 6) { setMsg('A senha precisa ter no mínimo 6 caracteres.'); return; }
    if (regForm.pin !== regForm.pin2) { setMsg('As senhas não conferem.'); return; }
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      body: JSON.stringify({ action: 'register_business', ...regForm }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error === 'CODE_TAKEN' ? 'Este código de login já está em uso. Escolha outro.' : `Erro: ${data.error}`);
      return;
    }
    setMsg(`Empresa cadastrada! Use o código "${data.internalCode}" e sua senha para entrar.`);
    setForm({ ...form, internalCode: data.internalCode });
    setAuthMode('login');
  }

  const [emailStep, setEmailStep] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [emailLogin, setEmailLogin] = useState({ email: '', emailOtp: '' });
  const [regMode, setRegMode] = useState('pin');
  const [regOtpSent, setRegOtpSent] = useState(false);
  const [regOtp, setRegOtp] = useState('');

  async function sendEmailCode() {
    setMsg('');
    if (!emailLogin.email) { setMsg('Informe seu e-mail.'); return; }
    const res = await fetch('/.netlify/functions/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantSlug: form.tenantSlug || 'playas-y-ventajas', email: emailLogin.email }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(data.error ? `Erro: ${data.error}` : 'Não foi possível enviar o código.'); return; }
    setOtpSent(true);
    setMsg('Código enviado! Confira seu e-mail (inclusive o lixo eletrônico).');
  }

  async function enterWithEmail() {
    setMsg('');
    if (!emailLogin.email) { setMsg('Informe seu e-mail.'); return; }
    if (!emailLogin.emailOtp) { setMsg('Informe o código de 6 dígitos recebido por e-mail.'); return; }
    const res = await fetch('/.netlify/functions/login-by-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantSlug: form.tenantSlug || 'playas-y-ventajas', email: emailLogin.email, emailOtp: emailLogin.emailOtp }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(data.error ? `Erro: ${data.error}` : 'Código inválido ou expirado.'); return; }
    setSession(data);
    setMsg('Login por e-mail realizado com sucesso!');
    loadDashboard(data);
    loadStats(data);
  }

  async function sendRegisterEmailCode() {
    setMsg('');
    if (!regForm.email) { setMsg('Informe seu e-mail.'); return; }
    const res = await fetch('/.netlify/functions/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: regForm.email, name: regForm.name }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(data.error ? `Erro: ${data.error}` : 'Não foi possível enviar o código.'); return; }
    setRegOtpSent(true);
    setMsg('Código enviado! Confira seu e-mail (inclusive o lixo eletrônico).');
  }

  async function registerBusinessByEmail() {
    if (regForm.name.length < 2) { setMsg('Informe o nome da empresa.'); return; }
    if (regForm.internalCode.length < 2) { setMsg('Informe um código de login.'); return; }
    if (regForm.pin.length < 6) { setMsg('A senha precisa ter no mínimo 6 caracteres.'); return; }
    if (regForm.pin !== regForm.pin2) { setMsg('As senhas não conferem.'); return; }
    if (!regForm.email) { setMsg('Informe seu e-mail.'); return; }
    if (!regOtp) { setMsg('Informe o código de 6 dígitos recebido por e-mail.'); return; }
    const res = await fetch('/.netlify/functions/register-business-by-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantSlug: regForm.tenantSlug, ...regForm, emailOtp: regOtp }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg(data.error === 'CODE_TAKEN' ? 'Este código de login já está em uso. Escolha outro.' : `Erro: ${data.error}`);
      return;
    }
    setMsg(`Empresa cadastrada! Use o código "${data.internalCode}" e sua senha para entrar.`);
    setForm({ ...form, internalCode: data.internalCode });
    setAuthMode('login');
    setRegOtpSent(false);
    setRegOtp('');
  }

  function useRegisterLocation() {
    navigator.geolocation.getCurrentPosition(
      (pos) => setRegForm({ ...regForm, lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }),
      () => setMsg('Não foi possível obter a localização.'),
    );
  }

  async function handleRegisterLogoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, 'business-logos');
      setRegForm({ ...regForm, logoUrl: url });
    } catch (err) {
      setMsg(`Não foi possível enviar a logo agora (${err.message}). Você poderá adicionar depois em "Meus dados".`);
    }
  }

  async function saveNewPin() {
    if (newPin.length < 6) { setMsg('A nova senha precisa ter no mínimo 6 caracteres.'); return; }
    if (newPin !== newPin2) { setMsg('As senhas não conferem.'); return; }
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ action: 'set_pin', newPin }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setMustChangePin(false);
    setNewPin(''); setNewPin2('');
    setMsg('Senha atualizada com sucesso.');
    loadDashboard(session);
    loadStats(session);
  }

  async function loadMyData() {
    const res = await fetch(`/.netlify/functions/empresa?mode=my-data`, { headers: { Authorization: `Bearer ${session.sessionToken}` } });
    const data = await res.json();
    if (res.ok) setMyData({ name: data.name || '', phone: data.phone || '', email: data.email || '', city: data.city || '', logoUrl: data.logoUrl || '', lat: data.lat ?? '', lng: data.lng ?? '' });
  }

  async function handleMyLogoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, 'business-logos', session.sessionToken);
      setMyData({ ...myData, logoUrl: url });
    } catch (err) { setMsg(`Erro no upload: ${err.message}`); }
  }

  function useMyLocation() {
    if (!navigator.geolocation) { setMsg('Seu navegador não suporta geolocalização.'); return; }
    setMsg('Buscando sua localização…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMyData({ ...myData, lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) });
        setMsg('Localização preenchida. Clique em "Salvar dados".');
      },
      (err) => setMsg(`Não foi possível obter a localização (${err.message}).`),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function saveMyData() {
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ action: 'update_my_data', ...myData }),
    });
    const data = await res.json();
    setMsg(res.ok ? 'Dados atualizados.' : `Erro: ${data.error}`);
  }

  const [validateForm, setValidateForm] = useState({ publicId: '', rawToken: '', shortCode: '' });
  const [validateResult, setValidateResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const scannerRef = useRef(null);
  const lastDecodedRef = useRef({ text: '', at: 0 });
  const scannerDivId = 'qr-reader';

  async function login() {
    const res = await fetch('/.netlify/functions/login', { method: 'POST', body: JSON.stringify(form) });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setSession(data);
    if (data.mustChangePin) {
      setMustChangePin(true);
      setMsg('Sua senha foi redefinida. Defina uma nova senha para continuar.');
      return;
    }
    setMsg('Login ok.');
    loadDashboard(data);
    loadStats(data);
  }

  async function loadStats(s) {
    const sess = s || session;
    const res = await fetch(`/.netlify/functions/empresa?mode=stats`, { headers: { Authorization: `Bearer ${sess.sessionToken}` } });
    const data = await res.json();
    if (res.ok) setStats(data);
  }

  async function loadDashboard(s) {
    const sess = s || session;
    if (!sess?.businessId) { setMsg('Este usuário não está vinculado a um estabelecimento.'); return; }
    const res = await fetch(`/.netlify/functions/empresa`, { headers: { Authorization: `Bearer ${sess.sessionToken}` } });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setDash(data);
  }

  async function createCampaign() {
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ action: 'create_campaign', title: campaignTitle }),
    });
    const data = await res.json();
    setMsg(res.ok ? 'Campanha criada.' : `Erro: ${data.error}`);
    if (res.ok) loadDashboard();
  }

  async function handleTemplateImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, 'campaign-images', session.sessionToken);
      setTemplateForm({ ...templateForm, imageUrl: url });
      setMsg('Imagem enviada.');
    } catch (err) { setMsg(`Erro no upload: ${err.message}`); }
  }

  async function toggleTemplate(tpl) {
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ action: 'toggle_template', templateId: tpl.id, isActive: !tpl.is_active }),
    });
    const data = await res.json();
    setMsg(res.ok ? (tpl.is_active ? 'Cupom desativado.' : 'Cupom ativado.') : `Erro: ${data.error}`);
    if (res.ok) loadDashboard();
  }

  async function deleteTemplate(tpl) {
    if (!window.confirm(`Apagar o cupom "${tpl.title}"? Esta ação não pode ser desfeita.`)) return;
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ action: 'delete_template', templateId: tpl.id }),
    });
    const data = await res.json();
    setMsg(res.ok ? 'Cupom apagado.' : `Erro: ${data.error}`);
    if (res.ok) { setEditingTemplate(null); loadDashboard(); loadStats(); }
  }

  function startEditTemplate(tpl) {
    setEditingTemplate({ id: tpl.id, title: tpl.title || '', benefitValue: tpl.benefit_value != null ? Number(tpl.benefit_value) : 10, totalStock: tpl.total_stock != null ? String(tpl.total_stock) : '', imageUrl: tpl.image_url || null });
    setMsg('');
  }

  async function handleEditTemplateImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, 'campaign-images', session.sessionToken);
      setEditingTemplate({ ...editingTemplate, imageUrl: url });
      setMsg('Imagem enviada.');
    } catch (err) { setMsg(`Erro no upload: ${err.message}`); }
  }

  async function saveEditTemplate() {
    if (!editingTemplate.title || editingTemplate.title.length < 2) { setMsg('Informe um nome para a oferta.'); return; }
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({
        action: 'update_template',
        templateId: editingTemplate.id, title: editingTemplate.title, benefitType: templateForm.benefitType,
        benefitValue: Number(editingTemplate.benefitValue), totalStock: editingTemplate.totalStock ? Number(editingTemplate.totalStock) : null,
        imageUrl: editingTemplate.imageUrl || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setMsg('Cupom atualizado.');
    setEditingTemplate(null);
    loadDashboard();
  }

  async function createTemplate() {
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({
        action: 'create_template',
        campaignId: templateForm.campaignId, title: templateForm.title, benefitType: templateForm.benefitType,
        benefitValue: Number(templateForm.benefitValue), totalStock: templateForm.totalStock ? Number(templateForm.totalStock) : null,
        imageUrl: templateForm.imageUrl || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setMsg('');
    setJustCreatedTemplate({ ...templateForm });
    loadDashboard(); loadStats();
  }

  async function validateCoupon(publicId, rawToken, shortCode) {
    const res = await fetch('/.netlify/functions/validate-coupon', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ publicId, rawToken: rawToken || undefined, shortCode: shortCode || undefined }),
    });
    const data = await res.json();
    const friendly = {
      PROMOTION_ENDED: 'A promoção acabou — este cupom não pode mais ser usado.',
      COUPON_CANCELLED: 'A promoção acabou — este cupom não pode mais ser usado.',
      COUPON_ALREADY_USED: 'Este cupom já foi usado antes.',
      COUPON_EXPIRED: 'Este cupom expirou.',
      INVALID_TOKEN: 'Código inválido para este cupom.',
      NOT_FOUND: 'Cupom não encontrado.',
    };
    setValidateResult({ ok: res.ok, ...data, errorLabel: friendly[data.error] });
  }

  async function startScan() {
    setScanning(true);
    const Html5Qrcode = await loadQrScanner();
    const scanner = new Html5Qrcode(scannerDivId);
    scannerRef.current = scanner;
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 220 },
      async (decodedText) => {
        const parts = decodedText.split('|');
        if (parts[0] === 'PYV1' && parts.length === 3) {
          // Evita revalidar o mesmo QR repetidamente enquanto a câmera fica aberta.
          const now = Date.now();
          if (lastDecodedRef.current.text === decodedText && now - lastDecodedRef.current.at < 4000) return;
          lastDecodedRef.current = { text: decodedText, at: now };
          setValidateForm({ publicId: parts[1], rawToken: parts[2], shortCode: '' });
          validateCoupon(parts[1], parts[2], null);
        }
      },
      () => {},
    );
  }

  async function stopScan() {
    if (scannerRef.current) { await scannerRef.current.stop().catch(() => {}); }
    setScanning(false);
  }

  return (
    <main style={{ background: theme.bg, minHeight: '100vh' }}>
      <ModuleSplash visible={!splashDone} onDone={() => setSplashDone(true)} />
      <Header title={t.businessPanel} right={session && (
        <button style={{ ...smallBtn, background: '#0B6E4F', color: '#FFFFFF', border: '1px solid rgba(255,255,255,0.6)' }} onClick={() => setSession(null)}>{t.logout}</button>
      )} />
      <div style={wrap}>

      {!session ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button style={authMode === 'login' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => { setAuthMode('login'); setMsg(''); }}>{t.authLogin}</button>
            <button style={authMode === 'register' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => { setAuthMode('register'); setMsg(''); }}>{t.authRegister}</button>
          </div>

          {authMode === 'login' ? (
            <>
            <div style={card}>
              <h3>{t.login}</h3>
              <input style={input} placeholder={t.companyCode} value={form.internalCode} onChange={(e) => setForm({ ...form, internalCode: e.target.value })} />
              <input style={input} placeholder={t.password} value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} />
              <button style={btn} onClick={login}>{t.enter}</button>
            </div>
            {!emailStep ? (
              <button style={{ ...btn, background: theme.border, color: theme.text }} onClick={() => { setEmailStep('ask'); setMsg(''); }}>{t.enterWithEmail ?? 'Entrar com e-mail'}</button>
            ) : (
              <div style={card}>
                <h3>{t.enterWithEmail ?? 'Entrar com e-mail'}</h3>
                <p style={{ fontSize: 12 }}>{t.emailOtpHint ?? 'Enviaremos um código de 6 dígitos para o seu e-mail cadastrado.'}</p>
                <input style={input} type="email" placeholder={t.emailPlaceholder ?? 'seu@email.com'} value={emailLogin.email} onChange={(e) => setEmailLogin({ ...emailLogin, email: e.target.value })} />
                {!otpSent ? (
                  <>
                    <button style={btn} onClick={sendEmailCode}>{t.sendEmailCodeBtn ?? 'Enviar código'}</button>
                    <button style={{ ...btn, background: theme.border, color: theme.text }} onClick={() => setEmailStep(null)}>{t.cancel ?? 'Cancelar'}</button>
                  </>
                ) : (
                  <>
                    <input style={input} placeholder={`${t.emailOtpPlaceholder ?? 'Código de 6 dígitos'}`} value={emailLogin.emailOtp} onChange={(e) => setEmailLogin({ ...emailLogin, emailOtp: e.target.value })} />
                    <button style={btn} onClick={enterWithEmail}>{t.enterWithEmailBtn ?? 'Entrar'}</button>
                    <button style={{ ...btn, background: theme.border, color: theme.text }} onClick={() => { setOtpSent(false); setEmailStep('ask'); }}>{t.resendCode ?? 'Reenviar código'}</button>
                    <button style={{ ...btn, background: theme.border, color: theme.text }} onClick={() => { setOtpSent(false); setEmailStep(null); }}>{t.cancel ?? 'Cancelar'}</button>
                  </>
                )}
              </div>
            )}
            </>
          ) : (
            <div style={card}>
              <h3>{t.authRegisterTitle}</h3>
              <p style={{ fontSize: 13 }}>{t.authRegisterSub}</p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <button style={regMode === 'pin' ? smallBtn : { ...smallBtn, background: theme.border, color: theme.text }} onClick={() => { setRegMode('pin'); setMsg(''); }}>{t.registerWithCode ?? 'Código + senha'}</button>
                <button style={regMode === 'email' ? smallBtn : { ...smallBtn, background: theme.border, color: theme.text }} onClick={() => { setRegMode('email'); setMsg(''); }}>{t.registerWithEmail ?? 'E-mail'}</button>
              </div>
              {regMode === 'email' && (
                <div style={{ padding: 10, background: theme.bg, borderRadius: 8, marginBottom: 10 }}>
                  <p style={{ fontSize: 12, marginTop: 0 }}>{t.emailRegHint ?? 'Enviaremos um código de 6 dígitos para o e-mail informado. Ele valida a propriedade do e-mail.'}</p>
                  {!regOtpSent ? (
                    <button style={smallBtn} onClick={sendRegisterEmailCode}>{t.sendEmailCodeBtn ?? 'Enviar código'}</button>
                  ) : (
                    <>
                      <input style={input} placeholder={t.emailOtpPlaceholder ?? 'Código de 6 dígitos'} value={regOtp} onChange={(e) => setRegOtp(e.target.value)} />
                      <button style={smallBtn} onClick={() => { setRegOtpSent(false); setRegOtp(''); }}>{t.resendCode ?? 'Reenviar código'}</button>
                    </>
                  )}
                </div>
              )}
              <input style={input} placeholder={t.businessName} value={regForm.name} onChange={(e) => setRegForm({ ...regForm, name: e.target.value })} />
              <select style={input} value={regForm.category} onChange={(e) => setRegForm({ ...regForm, category: e.target.value })}>
                <option value="passeio">Passeio</option><option value="hotel">Hotel</option><option value="pousada">Pousada</option>
                <option value="restaurante">Restaurante</option><option value="bar">Bar</option>
                <option value="translado">Translado</option><option value="servico">Serviço</option>
              </select>
              <input style={input} placeholder={t.city} value={regForm.city} onChange={(e) => setRegForm({ ...regForm, city: e.target.value })} />
              <br />
              <input style={input} placeholder="(00) 00000-0000" value={regForm.phone} onChange={(e) => setRegForm({ ...regForm, phone: e.target.value })} />
              <input style={input} placeholder={t.email} value={regForm.email} onChange={(e) => setRegForm({ ...regForm, email: e.target.value })} />
              <br />
              <input style={input} placeholder={t.cnpjPlaceholder} value={regForm.cnpj} onChange={(e) => setRegForm({ ...regForm, cnpj: e.target.value })} />
              <input style={input} placeholder={t.website} value={regForm.website} onChange={(e) => setRegForm({ ...regForm, website: e.target.value })} />
              <br />
              <label style={{ fontSize: 13 }}>{t.businessLogo} <input type="file" accept="image/*" onChange={handleRegisterLogoUpload} /></label>
              {regForm.logoUrl && <img src={regForm.logoUrl} alt="logo" style={{ height: 40, marginLeft: 8, verticalAlign: 'middle' }} />}
              <br />
              <input style={input} placeholder={t.latitude} value={regForm.lat} onChange={(e) => setRegForm({ ...regForm, lat: e.target.value })} />
              <input style={input} placeholder={t.longitude} value={regForm.lng} onChange={(e) => setRegForm({ ...regForm, lng: e.target.value })} />
              <button style={smallBtn} onClick={useRegisterLocation}>{t.useLocation}</button>
              <br />
              <input style={input} placeholder={t.loginShort} autoComplete="off" value={regForm.internalCode} onChange={(e) => setRegForm({ ...regForm, internalCode: e.target.value })} />
              <input style={input} placeholder={t.pinMin} type="password" value={regForm.pin} onChange={(e) => setRegForm({ ...regForm, pin: e.target.value })} />
              <input style={input} placeholder={t.confirmPin} type="password" value={regForm.pin2} onChange={(e) => setRegForm({ ...regForm, pin2: e.target.value })} />
              <br />
              <button style={btn} onClick={regMode === 'email' ? registerBusinessByEmail : registerBusiness}>{t.authRegisterButton}</button>
            </div>
          )}
        </>
      ) : mustChangePin ? (
        <div style={card}>
          <h3>{t.defineNewPasswordTitle}</h3>
          <p style={{ fontSize: 13 }}>{t.defineNewPasswordNotice}</p>
          <input style={input} type="password" placeholder={t.newPassword} value={newPin} onChange={(e) => setNewPin(e.target.value)} />
          <input style={input} type="password" placeholder={t.confirmPassword} value={newPin2} onChange={(e) => setNewPin2(e.target.value)} />
          <br />
          <button style={btn} onClick={saveNewPin}>{t.saveNewPassword}</button>
          <button style={{ ...btn, background: theme.border, color: theme.text }} onClick={() => setSession(null)}>{t.logout}</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button style={tab === 'criar' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => setTab('criar')}>{t.tabManageOffers}</button>
            <button style={tab === 'validar' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => setTab('validar')}>{t.tabValidate}</button>
            <button style={tab === 'dados' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => { setTab('dados'); loadMyData(); }}>{t.tabMyData}</button>
          </div>

          {tab === 'validar' && (
          <div style={card}>
            <h3>{t.validateCoupon}</h3>
            {!scanning ? (
              <button style={btn} onClick={startScan}>{t.scanQr}</button>
            ) : (
              <div>
                <div id={scannerDivId} style={{ maxWidth: 320 }} />
                <button style={{ ...btn, marginTop: 8 }} onClick={stopScan}>{t.stopCamera}</button>
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <input style={input} placeholder={t.couponCode} value={validateForm.publicId} onChange={(e) => setValidateForm({ ...validateForm, publicId: e.target.value })} />
              <button style={btn} onClick={() => validateCoupon(validateForm.publicId, null, null)}>{t.validateManually}</button>
            </div>
            {validateResult && (
              validateResult.ok ? (
                <div style={{ marginTop: 8, padding: 12, background: theme.greenLight, borderRadius: 10 }}>
                  <strong>{t.couponValidated}</strong>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>{t.fieldBusiness} {validateResult.businessName || '—'}</p>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>{t.fieldOffer} {validateResult.offerTitle || '—'}</p>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>{t.fieldCustomer} {validateResult.customerName || validateResult.customerPhone || t.notIdentified}</p>
                  {validateResult.idempotent && <p style={{ fontSize: 12, opacity: 0.7 }}>{t.validatedBefore}</p>}
                </div>
              ) : (
                <p style={{ marginTop: 8, fontWeight: 600, color: '#c0392b' }}>✘ {validateResult.errorLabel || validateResult.error}</p>
              )
            )}
          </div>
          )}

          {tab === 'criar' && (
          <>
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.howToCreateTitle}</h3>
            <ol style={{ fontSize: 13, lineHeight: 1.8 }}>
              <li>{t.howToStep1}</li>
              <li>{t.howToStep2}</li>
              <li>{t.howToStep3}</li>
              <li>{t.howToStep4}</li>
              <li>{t.howToStep5}</li>
              <li>{t.howToStep6}</li>
              <li>{t.howToStep7}</li>
            </ol>
          </div>
          <div style={card}>
            <h3>{t.newCampaign}</h3>
            <input style={input} value={campaignTitle} onChange={(e) => setCampaignTitle(e.target.value)} />
            <button style={btn} onClick={createCampaign}>{t.createCampaign}</button>

            <h3>{t.newTemplate}</h3>
            <select style={input} value={templateForm.campaignId} onChange={(e) => setTemplateForm({ ...templateForm, campaignId: e.target.value })}
              onFocus={(e) => { if (!e.target.value) e.target.style.color = 'transparent'; }}
              onBlur={(e) => { e.target.style.color = ''; }}
            >
              <option value="">{t.selectCampaign}</option>
              {(dash?.campaigns || []).map((c) => <option key={c.id} value={c.id} style={{ color: theme.text }}>{c.title}</option>)}
            </select>
            <input
              style={input} placeholder={t.titleDesc} onFocus={(e) => { e.target.placeholder = ''; e.target.style.color = theme.text; }}
              onBlur={(e) => { if (!e.target.value) e.target.placeholder = t.titleDesc; }}
              value={templateForm.title} onChange={(e) => setTemplateForm({ ...templateForm, title: e.target.value })} />
            <input
              style={input} placeholder={t.valueDesc} onFocus={(e) => { e.target.placeholder = ''; e.target.style.color = theme.text; }}
              onBlur={(e) => { if (!e.target.value) e.target.placeholder = t.valueDesc; }}
              value={templateForm.benefitValue} onChange={(e) => setTemplateForm({ ...templateForm, benefitValue: e.target.value })} />
            <input
              style={input} placeholder={t.stockDesc} onFocus={(e) => { e.target.placeholder = ''; e.target.style.color = theme.text; }}
              onBlur={(e) => { if (!e.target.value) e.target.placeholder = t.stockDesc; }}
              value={templateForm.totalStock} onChange={(e) => setTemplateForm({ ...templateForm, totalStock: e.target.value })} />
            <br />
            <label style={{ fontSize: 13 }}>{t.campaignImage} <input type="file" accept="image/*" onChange={handleTemplateImage} /></label>
            {templateForm.imageUrl && <img src={templateForm.imageUrl} alt="" style={{ height: 50, marginLeft: 8, verticalAlign: 'middle' }} />}
            <br />
            <button style={{ ...btn, marginTop: 8 }} onClick={createTemplate}>{t.createTemplate}</button>

            {justCreatedTemplate && (
              <div style={{ marginTop: 12, padding: 12, background: theme.greenLight, borderRadius: 10, border: `1px solid ${theme.border}` }}>
                <strong>{t.offerCreated}</strong>
                <p style={{ fontSize: 13, margin: '6px 0' }}>
                  {justCreatedTemplate.title} · {justCreatedTemplate.benefitValue}% OFF · {t.stockField} {justCreatedTemplate.totalStock || t.unlimited}
                </p>
                <button style={smallBtn} onClick={() => { navigator.clipboard?.writeText(justCreatedTemplate.title); setMsg('Copiado.'); }}>{t.copyOfferName}</button>
                <button style={smallBtn} onClick={() => setJustCreatedTemplate(null)}>{t.close}</button>
              </div>
            )}
          </div>

          {stats && (
            <div style={card}>
              <h3>{t.stats}</h3>
              <ul style={{ lineHeight: 1.9 }}>
                <li>{t.issued} <strong>{stats.totalIssued}</strong></li>
                <li>{t.validated} <strong>{stats.totalValidated}</strong></li>
                <li>{t.available} <strong>{stats.totalAvailable}</strong></li>
                <li>{t.expired} <strong>{stats.totalExpired}</strong></li>
                <li>{t.totalBilled} <strong>R$ {(stats.totalBilledCents / 100).toFixed(2)}</strong></li>
              </ul>
            </div>
          )}

          {dash && (
            <div style={card}>
              <h3>{t.campaigns} ({(dash.campaigns || []).length})</h3>
              <ul>{(dash.campaigns || []).map((c) => <li key={c.id}>{c.title} — {c.status === 'PUBLISHED' ? t.campaignActive : c.status}</li>)}</ul>
              <h3>{t.templates} ({(dash.templates || []).length})</h3>
              <ul>{(dash.templates || []).map((tpl) => (
                <li key={tpl.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  {tpl.image_url && <img src={tpl.image_url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 6 }} />}
                  <span style={{ textDecoration: tpl.is_active === false ? 'line-through' : 'none', opacity: tpl.is_active === false ? 0.6 : 1 }}>
                    {tpl.title} — {t.issued} {tpl.issued_count}
                  </span>
                  {tpl.is_active === false && <strong style={{ fontSize: 11, color: '#c0392b' }}>{t.disabledLabel}</strong>}
                  <button style={{ ...smallBtn, background: tpl.is_active === false ? '#0B6E4F' : '#c0392b', color: '#fff' }} onClick={() => toggleTemplate(tpl)}>
                    {tpl.is_active === false ? t.active : t.deactivate}
                  </button>
                  <button style={smallBtn} onClick={() => startEditTemplate(tpl)}>{t.edit}</button>
                  <button style={{ ...smallBtn, background: '#c0392b', color: '#fff' }} onClick={() => deleteTemplate(tpl)}>🗑️ {t.delete}</button>
                  {editingTemplate?.id === tpl.id && (
                    <div style={{ width: '100%', marginTop: 6, padding: 10, background: theme.bg, borderRadius: 8 }}>
                      <input style={input} placeholder={t.offerName} value={editingTemplate.title} onChange={(e) => setEditingTemplate({ ...editingTemplate, title: e.target.value })} />
                      <input style={input} placeholder={t.value} value={editingTemplate.benefitValue} onChange={(e) => setEditingTemplate({ ...editingTemplate, benefitValue: e.target.value })} />
                      <input style={input} placeholder={t.stock} value={editingTemplate.totalStock} onChange={(e) => setEditingTemplate({ ...editingTemplate, totalStock: e.target.value })} />
                      <br />
                      <label style={{ fontSize: 13 }}>{t.campaignImage} <input type="file" accept="image/*" onChange={handleEditTemplateImage} /></label>
                      {editingTemplate.imageUrl && <img src={editingTemplate.imageUrl} alt="" style={{ height: 50, marginLeft: 8, verticalAlign: 'middle' }} />}
                      <br />
                      <button style={{ ...btn, marginTop: 8 }} onClick={saveEditTemplate}>{t.saveEdit}</button>
                      <button style={{ ...smallBtn, background: theme.border, color: theme.text }} onClick={() => setEditingTemplate(null)}>{t.cancel}</button>
                    </div>
                  )}
                </li>
              ))}</ul>
              <h3>{t.couponsIssued} ({(dash.coupons || []).length})</h3>
              <ul>{(dash.coupons || []).map((c) => <li key={c.id}>{c.publicId} — {c.status} {(c.customerName || c.customerPhone) ? `· ${c.customerName || c.customerPhone}` : ''}</li>)}</ul>
            </div>
          )}
          </>
          )}

          {tab === 'dados' && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.myCompanyData}</h3>
            <input style={input} placeholder={t.businessNameField} value={myData.name} onChange={(e) => setMyData({ ...myData, name: e.target.value })} />
            <input style={input} placeholder={t.phoneField} value={myData.phone} onChange={(e) => setMyData({ ...myData, phone: e.target.value })} />
            <input style={input} placeholder={t.emailField} value={myData.email} onChange={(e) => setMyData({ ...myData, email: e.target.value })} />
            <input style={input} placeholder={t.cityField} value={myData.city} onChange={(e) => setMyData({ ...myData, city: e.target.value })} />
            <input style={input} placeholder={t.latField} value={myData.lat} onChange={(e) => setMyData({ ...myData, lat: e.target.value })} />
            <input style={input} placeholder={t.lngField} value={myData.lng} onChange={(e) => setMyData({ ...myData, lng: e.target.value })} />
            <button style={{ ...smallBtn, marginLeft: 8 }} onClick={useMyLocation}>{t.useMyLocation}</button>
            <br />
            <label style={{ fontSize: 13 }}>{t.logoField} <input type="file" accept="image/*" onChange={handleMyLogoUpload} /></label>
            {myData.logoUrl && <img src={myData.logoUrl} alt="" style={{ height: 40, marginLeft: 8, verticalAlign: 'middle' }} />}
            <br />
            <button style={{ ...btn, marginTop: 8 }} onClick={saveMyData}>{t.saveData}</button>
          </div>
          )}
        </>
      )}
      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
      </div>
    </main>
  );
}
