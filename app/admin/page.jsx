'use client';

import { useState } from 'react';
import { useLanguage } from '../../lib/LanguageContext';
import Header from '../components/Header';
import { theme } from '../../lib/theme';

const wrap = { maxWidth: 780, margin: '0 auto', padding: '20px 20px 80px', color: theme.text };
const card = { background: theme.card, color: theme.text, borderRadius: 14, padding: 20, marginBottom: 16, border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)' };
const input = { padding: 9, borderRadius: 8, border: `1px solid ${theme.border}`, marginRight: 8, marginBottom: 8 };
const btn = { padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: theme.gold, color: theme.greenDark, fontWeight: 700, marginRight: 8 };
const smallBtn = { ...btn, padding: '5px 12px', fontSize: 12 };

function maskPhone(v) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function maskCnpj(v) {
  const d = v.replace(/\D/g, '').slice(0, 14);
  let out = d;
  if (d.length > 2) out = `${d.slice(0, 2)}.${d.slice(2)}`;
  if (d.length > 5) out = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
  if (d.length > 8) out = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
  if (d.length > 12) out = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return out;
}

async function uploadImage(file, folder) {
  const base64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const res = await fetch('/.netlify/functions/upload-image', {
    method: 'POST',
    body: JSON.stringify({ base64, contentType: file.type, folder }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data.url;
}

export default function AdminPage() {
  const { t } = useLanguage();
  const [session, setSession] = useState(null);
  const [loginForm, setLoginForm] = useState({ tenantSlug: 'playas-y-ventajas', internalCode: 'ADMIN-001', pin: '' });
  const [businesses, setBusinesses] = useState([]);
  const [billing, setBilling] = useState([]);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({
    name: '', category: 'passeio', city: '', phone: '', email: '', cnpj: '', website: '', logoUrl: '',
    lat: '', lng: '', ownerInternalCode: '', ownerPin: '', billingPlan: 'FREE',
  });

  async function login() {
    const res = await fetch('/.netlify/functions/login', { method: 'POST', body: JSON.stringify(loginForm) });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    if (data.role !== 'ADMIN' && data.role !== 'SUPER_ADMIN') { setMsg('Este usuário não tem acesso de administrador.'); return; }
    setSession(data);
    loadBusinesses(data);
    loadBilling(data);
  }

  async function loadBusinesses(s) {
    const sess = s || session;
    const res = await fetch(`/.netlify/functions/admin?sessionToken=${sess.sessionToken}`);
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setBusinesses(data);
  }

  async function loadBilling(s) {
    const sess = s || session;
    const res = await fetch(`/.netlify/functions/admin?sessionToken=${sess.sessionToken}&mode=billing`);
    const data = await res.json();
    if (res.ok) setBilling(data);
  }

  async function handleLogoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, 'business-logos');
      setForm({ ...form, logoUrl: url });
      setMsg('Logo enviada.');
    } catch (err) { setMsg(`Erro no upload: ${err.message}`); }
  }

  async function createBusiness() {
    if (form.ownerPin.length < 6) { setMsg('O PIN da empresa precisa ter no mínimo 6 caracteres.'); return; }
    const res = await fetch('/.netlify/functions/admin', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create_business', sessionToken: session.sessionToken,
        name: form.name, category: form.category, city: form.city, phone: form.phone, email: form.email,
        cnpj: form.cnpj, website: form.website, logoUrl: form.logoUrl,
        lat: form.lat ? Number(form.lat) : null, lng: form.lng ? Number(form.lng) : null,
        ownerInternalCode: form.ownerInternalCode, ownerPin: form.ownerPin, billingPlan: form.billingPlan,
      }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setMsg(`Empresa cadastrada. Login dela em /empresa: ${form.ownerInternalCode}`);
    setForm({ name: '', category: 'passeio', city: '', phone: '', email: '', cnpj: '', website: '', logoUrl: '', lat: '', lng: '', ownerInternalCode: '', ownerPin: '', billingPlan: 'FREE' });
    loadBusinesses();
  }

  async function toggleActive(b) {
    await fetch('/.netlify/functions/admin', {
      method: 'POST',
      body: JSON.stringify({ action: 'toggle_business', sessionToken: session.sessionToken, businessId: b.id, isActive: !b.isActive }),
    });
    loadBusinesses();
  }

  async function setBillingPlan(b, plan, status, feeCents) {
    await fetch('/.netlify/functions/admin', {
      method: 'POST',
      body: JSON.stringify({ action: 'set_billing', sessionToken: session.sessionToken, businessId: b.id, plan, status, feeCents }),
    });
    loadBusinesses();
  }

  function useMyLocation() {
    navigator.geolocation.getCurrentPosition(
      (pos) => setForm({ ...form, lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }),
      () => setMsg('Não foi possível obter localização.'),
    );
  }

  if (!session) {
    return (
      <main style={{ background: theme.bg, minHeight: '100vh' }}>
        <Header title={t.adminPanel} />
        <div style={wrap}>
        <div style={card}>
          <h3>{t.login}</h3>
          <input style={input} placeholder="Usuário" value={loginForm.internalCode} onChange={(e) => setLoginForm({ ...loginForm, internalCode: e.target.value })} />
          <input style={input} placeholder={t.pin} type="password" value={loginForm.pin} onChange={(e) => setLoginForm({ ...loginForm, pin: e.target.value })} />
          <button style={btn} onClick={login}>{t.enter}</button>
          {msg && <p style={{ fontSize: 13, color: '#c0392b' }}>{msg}</p>}
        </div>
        </div>
      </main>
    );
  }

  return (
    <main style={{ background: theme.bg, minHeight: '100vh' }}>
      <Header title={t.adminPanel} />
      <div style={wrap}>

      <div style={card}>
        <h3>{t.registerBusiness}</h3>
        <input style={input} placeholder={t.businessName} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select style={input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option value="passeio">Passeio</option><option value="hotel">Hotel</option><option value="pousada">Pousada</option>
          <option value="restaurante">Restaurante</option><option value="bar">Bar</option>
          <option value="translado">Translado</option><option value="servico">Serviço</option>
        </select>
        <input style={input} placeholder={t.city} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        <br />
        <input style={input} placeholder="(00) 00000-0000" value={form.phone} onChange={(e) => setForm({ ...form, phone: maskPhone(e.target.value) })} />
        <input style={input} placeholder={t.email} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <br />
        <input style={input} placeholder={t.cnpjPlaceholder} value={form.cnpj} onChange={(e) => setForm({ ...form, cnpj: maskCnpj(e.target.value) })} />
        <input style={input} placeholder={t.website} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
        <br />
        <label style={{ fontSize: 13 }}>{t.businessLogo} <input type="file" accept="image/*" onChange={handleLogoUpload} /></label>
        {form.logoUrl && <img src={form.logoUrl} alt="logo" style={{ height: 40, marginLeft: 8, verticalAlign: 'middle' }} />}
        <br />
        <input style={input} placeholder={t.latitude} value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} />
        <input style={input} placeholder={t.longitude} value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} />
        <button style={smallBtn} onClick={useMyLocation}>{t.useLocation}</button>
        <br />
        <input style={input} placeholder={t.loginCode} value={form.ownerInternalCode} onChange={(e) => setForm({ ...form, ownerInternalCode: e.target.value })} />
        <input style={input} placeholder={t.pinMin} value={form.ownerPin} onChange={(e) => setForm({ ...form, ownerPin: e.target.value })} />
        <select style={input} value={form.billingPlan} onChange={(e) => setForm({ ...form, billingPlan: e.target.value })}>
          <option value="FREE">{t.freePlan}</option>
          <option value="BASIC">{t.basicPlan}</option>
          <option value="PRO">{t.proPlan}</option>
        </select>
        <br />
        <button style={btn} onClick={createBusiness}>{t.registerButton}</button>
      </div>

      <div style={card}>
        <h3>{t.registeredBusinesses} ({businesses.length})</h3>
        {businesses.map((b) => (
          <div key={b.id} style={{ borderTop: '1px solid #e2e8f0', padding: '10px 0' }}>
            {b.logoUrl && <img src={b.logoUrl} alt="" style={{ height: 30, verticalAlign: 'middle', marginRight: 8 }} />}
            <strong>{b.name}</strong> — {b.category} — {b.city} {b.isActive ? '✅' : '⛔'}
            <br />
            <span style={{ fontSize: 12 }}>Login: {b.ownerInternalCode} · CNPJ: {b.cnpj || '—'} · {b.website || '—'}</span>
            <br />
            <span style={{ fontSize: 12 }}>{b.billingPlan} · {b.billingStatus}</span>
            <div style={{ marginTop: 6 }}>
              <button style={smallBtn} onClick={() => toggleActive(b)}>{b.isActive ? t.deactivate : t.active}</button>
              <button style={smallBtn} onClick={() => setBillingPlan(b, b.billingPlan, 'ACTIVE', b.monthlyFeeCents)}>{t.activateBilling}</button>
              <button style={smallBtn} onClick={() => setBillingPlan(b, b.billingPlan, 'SUSPENDED', b.monthlyFeeCents)}>{t.suspend}</button>
            </div>
          </div>
        ))}
      </div>

      <div style={card}>
        <h3>{t.billingPanel}</h3>
        {billing.length === 0 ? <p style={{ fontSize: 13 }}>{t.noBillingYet}</p> : (
          <ul>{billing.map((c, i) => (
            <li key={i} style={{ fontSize: 13 }}>{c.businessName} — {c.couponPublicId} — R$ {(c.amountCents / 100).toFixed(2)} — {new Date(c.validatedAt).toLocaleString('pt-BR')}</li>
          ))}</ul>
        )}
      </div>

      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
      </div>
    </main>
  );
}
