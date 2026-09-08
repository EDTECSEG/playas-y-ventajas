'use client';

import { useRef, useState } from 'react';

function loadQrScanner() {
  return new Promise((resolve) => {
    if (window.Html5Qrcode) return resolve(window.Html5Qrcode);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    script.onload = () => resolve(window.Html5Qrcode);
    document.body.appendChild(script);
  });
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


const wrap = { maxWidth: 720, margin: '0 auto', padding: '48px 24px 80px', color: '#FFFDF7' };
const card = { background: '#FFFDF7', color: '#0B6E4F', borderRadius: 12, padding: 20, marginBottom: 16 };
const input = { padding: 8, borderRadius: 6, border: '1px solid #cbd5e1', marginRight: 8, marginBottom: 8 };
const btn = { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#0B6E4F', color: '#FFFDF7', fontWeight: 600, marginRight: 8 };

export default function EmpresaPage() {
  const [session, setSession] = useState(null);
  const [form, setForm] = useState({ tenantSlug: 'playas-y-ventajas', internalCode: 'MERCHANT-001', pin: '1234' });
  const [dash, setDash] = useState(null);
  const [msg, setMsg] = useState('');
  const [campaignTitle, setCampaignTitle] = useState('Nova campanha');
  const [templateForm, setTemplateForm] = useState({ campaignId: '', title: '10% OFF', benefitType: 'DISCOUNT_PERCENT', benefitValue: 10, totalStock: '', imageUrl: '' });
  const [stats, setStats] = useState(null);
  const [validateForm, setValidateForm] = useState({ publicId: '', rawToken: '', shortCode: '' });
  const [validateResult, setValidateResult] = useState(null);
  const [scanning, setScanning] = useState(false);
  const scannerRef = useRef(null);
  const scannerDivId = 'qr-reader';

  async function login() {
    const res = await fetch('/.netlify/functions/login', { method: 'POST', body: JSON.stringify(form) });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setSession(data);
    setMsg('Login ok.');
    loadDashboard(data);
    loadStats(data);
  }

  async function loadStats(s) {
    const sess = s || session;
    const res = await fetch(`/.netlify/functions/empresa?sessionToken=${sess.sessionToken}&mode=stats`);
    const data = await res.json();
    if (res.ok) setStats(data);
  }

  async function loadDashboard(s) {
    const sess = s || session;
    if (!sess?.businessId) { setMsg('Este usuário não está vinculado a um estabelecimento.'); return; }
    const res = await fetch(`/.netlify/functions/empresa?sessionToken=${sess.sessionToken}`);
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setDash(data);
  }

  async function createCampaign() {
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      body: JSON.stringify({ action: 'create_campaign', sessionToken: session.sessionToken, title: campaignTitle }),
    });
    const data = await res.json();
    setMsg(res.ok ? 'Campanha criada.' : `Erro: ${data.error}`);
    if (res.ok) loadDashboard();
  }

  async function handleTemplateImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const url = await uploadImage(file, 'campaign-images');
      setTemplateForm({ ...templateForm, imageUrl: url });
      setMsg('Imagem enviada.');
    } catch (err) { setMsg(`Erro no upload: ${err.message}`); }
  }

  async function createTemplate() {
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      body: JSON.stringify({
        action: 'create_template', sessionToken: session.sessionToken,
        campaignId: templateForm.campaignId, title: templateForm.title, benefitType: templateForm.benefitType,
        benefitValue: Number(templateForm.benefitValue), totalStock: templateForm.totalStock ? Number(templateForm.totalStock) : null,
        imageUrl: templateForm.imageUrl || null,
      }),
    });
    const data = await res.json();
    setMsg(res.ok ? 'Cupom-template criado.' : `Erro: ${data.error}`);
    if (res.ok) { loadDashboard(); loadStats(); }
  }

  async function validateCoupon(publicId, rawToken, shortCode) {
    const res = await fetch('/.netlify/functions/validate-coupon', {
      method: 'POST',
      body: JSON.stringify({
        sessionToken: session.sessionToken, publicId, rawToken: rawToken || undefined, shortCode: shortCode || undefined,
      }),
    });
    const data = await res.json();
    setValidateResult({ ok: res.ok, ...data });
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
          await scanner.stop();
          setScanning(false);
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
    <main style={wrap}>
      <h1>🏪 Painel da Empresa</h1>

      {!session ? (
        <div style={card}>
          <h3>Login</h3>
          <input style={input} placeholder="tenant slug" value={form.tenantSlug} onChange={(e) => setForm({ ...form, tenantSlug: e.target.value })} />
          <input style={input} placeholder="código interno" value={form.internalCode} onChange={(e) => setForm({ ...form, internalCode: e.target.value })} />
          <input style={input} placeholder="PIN" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} />
          <button style={btn} onClick={login}>Entrar</button>
          <p style={{ fontSize: 12, opacity: 0.8 }}>Login: MERCHANT-001 / PIN 1234</p>
        </div>
      ) : (
        <>
          <div style={card}>
            <p>Logado como <strong>{session.role}</strong> (business: {session.businessId})</p>

            <h3>✅ Validar cupom do cliente</h3>
            {!scanning ? (
              <button style={btn} onClick={startScan}>📷 Escanear QR code</button>
            ) : (
              <div>
                <div id={scannerDivId} style={{ maxWidth: 320 }} />
                <button style={{ ...btn, marginTop: 8 }} onClick={stopScan}>Parar câmera</button>
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <input style={input} placeholder="código do cupom (PYV-...)" value={validateForm.publicId} onChange={(e) => setValidateForm({ ...validateForm, publicId: e.target.value })} />
              <button style={btn} onClick={() => validateCoupon(validateForm.publicId, null, null)}>Validar manualmente</button>
            </div>
            {validateResult && (
              <p style={{ marginTop: 8, fontWeight: 600, color: validateResult.ok ? '#0B6E4F' : '#c0392b' }}>
                {validateResult.ok ? `✔ Validado! (idempotent=${validateResult.idempotent})` : `✘ ${validateResult.error}`}
              </p>
            )}

            <h3>Nova campanha</h3>
            <input style={input} value={campaignTitle} onChange={(e) => setCampaignTitle(e.target.value)} />
            <button style={btn} onClick={createCampaign}>Criar campanha</button>

            <h3>Novo cupom-template</h3>
            <input style={input} placeholder="campaign ID" value={templateForm.campaignId} onChange={(e) => setTemplateForm({ ...templateForm, campaignId: e.target.value })} />
            <input style={input} placeholder="título" value={templateForm.title} onChange={(e) => setTemplateForm({ ...templateForm, title: e.target.value })} />
            <input style={input} placeholder="valor (%)" value={templateForm.benefitValue} onChange={(e) => setTemplateForm({ ...templateForm, benefitValue: e.target.value })} />
            <input style={input} placeholder="estoque (vazio=ilimitado)" value={templateForm.totalStock} onChange={(e) => setTemplateForm({ ...templateForm, totalStock: e.target.value })} />
            <br />
            <label style={{ fontSize: 13 }}>Imagem/propaganda do cupom: <input type="file" accept="image/*" onChange={handleTemplateImage} /></label>
            {templateForm.imageUrl && <img src={templateForm.imageUrl} alt="" style={{ height: 50, marginLeft: 8, verticalAlign: 'middle' }} />}
            <br />
            <button style={{ ...btn, marginTop: 8 }} onClick={createTemplate}>Criar cupom-template</button>
          </div>

          {stats && (
            <div style={card}>
              <h3>📊 Estatísticas</h3>
              <ul style={{ lineHeight: 1.9 }}>
                <li>Cupons emitidos: <strong>{stats.totalIssued}</strong></li>
                <li>Cupons validados (usados): <strong>{stats.totalValidated}</strong></li>
                <li>Disponíveis (ainda não usados): <strong>{stats.totalAvailable}</strong></li>
                <li>Expirados: <strong>{stats.totalExpired}</strong></li>
                <li>Total cobrado até agora: <strong>R$ {(stats.totalBilledCents / 100).toFixed(2)}</strong></li>
              </ul>
            </div>
          )}

          {dash && (
            <div style={card}>
              <h3>Campanhas ({(dash.campaigns || []).length})</h3>
              <ul>{(dash.campaigns || []).map((c) => <li key={c.id}>{c.title} — {c.status} — <code>{c.id}</code></li>)}</ul>
              <h3>Templates ({(dash.templates || []).length})</h3>
              <ul>{(dash.templates || []).map((t) => <li key={t.id}>{t.title} — emitidos: {t.issued_count}</li>)}</ul>
              <h3>Cupons emitidos ({(dash.coupons || []).length})</h3>
              <ul>{(dash.coupons || []).map((c) => <li key={c.id}>{c.publicId} — {c.status}</li>)}</ul>
            </div>
          )}
        </>
      )}
      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
    </main>
  );
}
