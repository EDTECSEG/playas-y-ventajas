'use client';

import { useRef, useState } from 'react';
import { useLanguage } from '../../lib/LanguageContext';
import Header from '../components/Header';
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
  const res = await fetch('/.netlify/functions/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
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
      <Header title={t.businessPanel} right={session && (
        <button style={{ ...smallBtn, background: '#0B6E4F', color: '#FFFFFF', border: '1px solid rgba(255,255,255,0.6)' }} onClick={() => setSession(null)}>Sair</button>
      )} />
      <div style={wrap}>

      {!session ? (
        <div style={card}>
          <h3>{t.login}</h3>
          <input style={input} placeholder="Código da empresa" value={form.internalCode} onChange={(e) => setForm({ ...form, internalCode: e.target.value })} />
          <input style={input} placeholder="Senha" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} />
          <button style={btn} onClick={login}>{t.enter}</button>
        </div>
      ) : mustChangePin ? (
        <div style={card}>
          <h3>🔑 Defina uma nova senha</h3>
          <p style={{ fontSize: 13 }}>Por segurança, defina uma nova senha para continuar usando o painel.</p>
          <input style={input} type="password" placeholder="Nova senha (mín. 6 caracteres)" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
          <input style={input} type="password" placeholder="Confirme a nova senha" value={newPin2} onChange={(e) => setNewPin2(e.target.value)} />
          <br />
          <button style={btn} onClick={saveNewPin}>Salvar nova senha</button>
          <button style={{ ...btn, background: theme.border, color: theme.text }} onClick={() => setSession(null)}>Sair</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button style={tab === 'criar' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => setTab('criar')}>📋 Criar e gerenciar ofertas</button>
            <button style={tab === 'validar' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => setTab('validar')}>✅ Validar cupom</button>
            <button style={tab === 'dados' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => { setTab('dados'); loadMyData(); }}>🏢 Meus dados</button>
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
                  <strong>✔ Cupom validado!</strong>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>Empresa: {validateResult.businessName || '—'}</p>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>Oferta: {validateResult.offerTitle || '—'}</p>
                  <p style={{ fontSize: 13, margin: '4px 0' }}>Cliente: {validateResult.customerName || validateResult.customerPhone || 'não identificado'}</p>
                  {validateResult.idempotent && <p style={{ fontSize: 12, opacity: 0.7 }}>(já tinha sido validado antes)</p>}
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
            <h3 style={{ marginTop: 0 }}>📖 Como criar um cupom</h3>
            <ol style={{ fontSize: 13, lineHeight: 1.8 }}>
              <li>Crie ou selecione uma campanha.</li>
              <li>Informe o nome da oferta.</li>
              <li>Defina o desconto/benefício.</li>
              <li>Defina a quantidade disponível (ou deixe em branco para ilimitado).</li>
              <li>Adicione uma imagem de propaganda.</li>
              <li>Confira os dados e crie o cupom.</li>
              <li>Confira o código gerado na confirmação.</li>
            </ol>
          </div>
          <div style={card}>
            <h3>{t.newCampaign}</h3>
            <input style={input} value={campaignTitle} onChange={(e) => setCampaignTitle(e.target.value)} />
            <button style={btn} onClick={createCampaign}>{t.createCampaign}</button>

            <h3>{t.newTemplate}</h3>
            <select style={input} value={templateForm.campaignId} onChange={(e) => setTemplateForm({ ...templateForm, campaignId: e.target.value })}>
              <option value="">Selecione a campanha</option>
              {(dash?.campaigns || []).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <input style={input} placeholder={t.title} value={templateForm.title} onChange={(e) => setTemplateForm({ ...templateForm, title: e.target.value })} />
            <input style={input} placeholder={t.value} value={templateForm.benefitValue} onChange={(e) => setTemplateForm({ ...templateForm, benefitValue: e.target.value })} />
            <input style={input} placeholder={t.stock} value={templateForm.totalStock} onChange={(e) => setTemplateForm({ ...templateForm, totalStock: e.target.value })} />
            <br />
            <label style={{ fontSize: 13 }}>{t.campaignImage} <input type="file" accept="image/*" onChange={handleTemplateImage} /></label>
            {templateForm.imageUrl && <img src={templateForm.imageUrl} alt="" style={{ height: 50, marginLeft: 8, verticalAlign: 'middle' }} />}
            <br />
            <button style={{ ...btn, marginTop: 8 }} onClick={createTemplate}>{t.createTemplate}</button>

            {justCreatedTemplate && (
              <div style={{ marginTop: 12, padding: 12, background: theme.greenLight, borderRadius: 10, border: `1px solid ${theme.border}` }}>
                <strong>✅ Oferta criada com sucesso!</strong>
                <p style={{ fontSize: 13, margin: '6px 0' }}>
                  {justCreatedTemplate.title} · {justCreatedTemplate.benefitValue}% OFF · Estoque: {justCreatedTemplate.totalStock || 'ilimitado'}
                </p>
                <button style={smallBtn} onClick={() => { navigator.clipboard?.writeText(justCreatedTemplate.title); setMsg('Copiado.'); }}>Copiar nome da oferta</button>
                <button style={smallBtn} onClick={() => setJustCreatedTemplate(null)}>Fechar</button>
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
              <ul>{(dash.campaigns || []).map((c) => <li key={c.id}>{c.title} — {c.status === 'PUBLISHED' ? 'ativa' : c.status}</li>)}</ul>
              <h3>{t.templates} ({(dash.templates || []).length})</h3>
              <ul>{(dash.templates || []).map((tpl) => (
                <li key={tpl.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  {tpl.image_url && <img src={tpl.image_url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 6 }} />}
                  <span style={{ textDecoration: tpl.is_active === false ? 'line-through' : 'none', opacity: tpl.is_active === false ? 0.6 : 1 }}>
                    {tpl.title} — {t.issued} {tpl.issued_count}
                  </span>
                  {tpl.is_active === false && <strong style={{ fontSize: 11, color: '#c0392b' }}>desativado</strong>}
                  <button style={{ ...smallBtn, background: tpl.is_active === false ? '#0B6E4F' : '#c0392b', color: '#fff' }} onClick={() => toggleTemplate(tpl)}>
                    {tpl.is_active === false ? 'Ativar' : 'Desativar'}
                  </button>
                  <button style={smallBtn} onClick={() => startEditTemplate(tpl)}>Editar</button>
                  <button style={{ ...smallBtn, background: '#c0392b', color: '#fff' }} onClick={() => deleteTemplate(tpl)}>🗑️ Apagar</button>
                  {editingTemplate?.id === tpl.id && (
                    <div style={{ width: '100%', marginTop: 6, padding: 10, background: theme.bg, borderRadius: 8 }}>
                      <input style={input} placeholder="nome da oferta" value={editingTemplate.title} onChange={(e) => setEditingTemplate({ ...editingTemplate, title: e.target.value })} />
                      <input style={input} placeholder={t.value} value={editingTemplate.benefitValue} onChange={(e) => setEditingTemplate({ ...editingTemplate, benefitValue: e.target.value })} />
                      <input style={input} placeholder={t.stock} value={editingTemplate.totalStock} onChange={(e) => setEditingTemplate({ ...editingTemplate, totalStock: e.target.value })} />
                      <br />
                      <label style={{ fontSize: 13 }}>{t.campaignImage} <input type="file" accept="image/*" onChange={handleEditTemplateImage} /></label>
                      {editingTemplate.imageUrl && <img src={editingTemplate.imageUrl} alt="" style={{ height: 50, marginLeft: 8, verticalAlign: 'middle' }} />}
                      <br />
                      <button style={{ ...btn, marginTop: 8 }} onClick={saveEditTemplate}>Salvar edição</button>
                      <button style={{ ...smallBtn, background: theme.border, color: theme.text }} onClick={() => setEditingTemplate(null)}>Cancelar</button>
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
            <h3 style={{ marginTop: 0 }}>🏢 Meus dados</h3>
            <input style={input} placeholder="nome da empresa" value={myData.name} onChange={(e) => setMyData({ ...myData, name: e.target.value })} />
            <input style={input} placeholder="telefone" value={myData.phone} onChange={(e) => setMyData({ ...myData, phone: e.target.value })} />
            <input style={input} placeholder="e-mail" value={myData.email} onChange={(e) => setMyData({ ...myData, email: e.target.value })} />
            <input style={input} placeholder="cidade" value={myData.city} onChange={(e) => setMyData({ ...myData, city: e.target.value })} />
            <input style={input} placeholder="latitude (ex.: -22.9064)" value={myData.lat} onChange={(e) => setMyData({ ...myData, lat: e.target.value })} />
            <input style={input} placeholder="longitude (ex.: -43.1785)" value={myData.lng} onChange={(e) => setMyData({ ...myData, lng: e.target.value })} />
            <br />
            <label style={{ fontSize: 13 }}>Logo: <input type="file" accept="image/*" onChange={handleMyLogoUpload} /></label>
            {myData.logoUrl && <img src={myData.logoUrl} alt="" style={{ height: 40, marginLeft: 8, verticalAlign: 'middle' }} />}
            <br />
            <button style={{ ...btn, marginTop: 8 }} onClick={saveMyData}>Salvar dados</button>
          </div>
          )}
        </>
      )}
      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
      </div>
    </main>
  );
}
