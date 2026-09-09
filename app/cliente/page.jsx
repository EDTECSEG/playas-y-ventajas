'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../lib/LanguageContext';
import Header from '../components/Header';
import { theme } from '../../lib/theme';

const wrap = { maxWidth: 720, margin: '0 auto', padding: '20px 20px 80px', color: theme.text, background: theme.bg, minHeight: '100vh' };
const card = { background: theme.card, color: theme.text, borderRadius: 14, padding: 20, marginBottom: 16, border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)' };
const input = { padding: 9, borderRadius: 8, border: `1px solid ${theme.border}`, marginRight: 8, marginBottom: 8 };
const btn = { padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: theme.gold, color: theme.greenDark, fontWeight: 700 };

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

function loadQrCode() {
  return new Promise((resolve, reject) => {
    if (window.QRCode) return resolve(window.QRCode);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/qrcodejs@1.0.0/qrcode.min.js';
    script.onload = () => resolve(window.QRCode);
    script.onerror = () => reject(new Error('falha de rede ao carregar a biblioteca de QR code'));
    document.body.appendChild(script);
  });
}

function loadLeaflet() {
  return new Promise((resolve) => {
    if (window.L) return resolve(window.L);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => resolve(window.L);
    document.body.appendChild(script);
  });
}

export default function ClientePage() {
  const { t } = useLanguage();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [instagram, setInstagram] = useState('');
  const [email, setEmail] = useState('');
  const [customerId, setCustomerId] = useState(null);
  const [offers, setOffers] = useState([]);
  const [myCoupons, setMyCoupons] = useState([]);
  const [justClaimed, setJustClaimed] = useState(null);
  const [msg, setMsg] = useState('');
  const [mapStatus, setMapStatus] = useState('idle');

  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const qrDivRef = useRef(null);
  const myCouponQrDivRef = useRef(null);
  const [openCoupon, setOpenCoupon] = useState(null);

  useEffect(() => {
    const saved = localStorage.getItem('pyv_customer');
    if (saved) {
      const s = JSON.parse(saved);
      setPhone(s.phone); setName(s.name); setInstagram(s.instagram || ''); setEmail(s.email || ''); setCustomerId(s.customerId);
      loadMyCoupons(s.customerId);
    }
    loadOffers();
    showMap(); // abre o mapa automaticamente ao entrar no modulo, sem precisar clicar
  }, []);

  async function loadOffers() {
    const res = await fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}`);
    setOffers(await res.json());
  }

  async function loadMyCoupons(cid) {
    const res = await fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}&mode=my-coupons&customerId=${cid}`);
    setMyCoupons(await res.json());
  }

  async function claim(templateId) {
    if (!phone) { setMsg('Informe seu telefone primeiro.'); return; }
    const res = await fetch('/.netlify/functions/claim-coupon', {
      method: 'POST',
      body: JSON.stringify({ tenantId: TENANT_ID, templateId, phone, name, instagram, email }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    localStorage.setItem('pyv_customer', JSON.stringify({ phone, name, instagram, email, customerId: data.customerId }));
    const tokens = JSON.parse(localStorage.getItem('pyv_coupon_tokens') || '{}');
    tokens[data.publicId] = data.rawToken;
    localStorage.setItem('pyv_coupon_tokens', JSON.stringify(tokens));
    setCustomerId(data.customerId);
    setJustClaimed(data);
    setMsg('Cupom resgatado! Guarde o código abaixo — mostre no estabelecimento.');
    loadMyCoupons(data.customerId);
  }

  useEffect(() => {
    if (!justClaimed) return;
    let cancelled = false;
    (async () => {
      try {
        const QRCode = await loadQrCode();
        if (cancelled || !qrDivRef.current) return;
        qrDivRef.current.innerHTML = '';
        new QRCode(qrDivRef.current, { text: `PYV1|${justClaimed.publicId}|${justClaimed.rawToken}`, width: 220, height: 220 });
      } catch (err) {
        if (!cancelled) setMsg(`Cupom resgatado, mas o QR code falhou ao gerar (${err.message}). Use o código de texto abaixo.`);
      }
    })();
    return () => { cancelled = true; };
  }, [justClaimed]);

  useEffect(() => {
    if (!openCoupon) return;
    let cancelled = false;
    (async () => {
      try {
        const QRCode = await loadQrCode();
        if (cancelled || !myCouponQrDivRef.current) return;
        myCouponQrDivRef.current.innerHTML = '';
        new QRCode(myCouponQrDivRef.current, { text: `PYV1|${openCoupon.publicId}|${openCoupon.rawToken}`, width: 200, height: 200 });
      } catch (err) {
        if (!cancelled) setMsg(`Falha ao gerar QR do cupom aberto: ${err?.message || err}`);
      }
    })();
    return () => { cancelled = true; };
  }, [openCoupon]);

  function handleOpenCoupon(publicId) {
    const tokens = JSON.parse(localStorage.getItem('pyv_coupon_tokens') || '{}');
    const rawToken = tokens[publicId];
    if (!rawToken) { setMsg('Código não disponível neste aparelho. Se você o resgatou em outro dispositivo ou limpou os dados do navegador, ele não pode ser recuperado — é necessário ter salvo o print no momento do resgate.'); setOpenCoupon(null); return; }
    setMsg('');
    setOpenCoupon({ publicId, rawToken });
  }

  async function showMap() {
    setMapStatus('locating');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      const L = await loadLeaflet();
      if (!mapInstanceRef.current) {
        mapInstanceRef.current = L.map(mapRef.current).setView([latitude, longitude], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(mapInstanceRef.current);
      }
      L.marker([latitude, longitude]).addTo(mapInstanceRef.current).bindPopup('Você está aqui');

      // Nossos parceiros (verde)
      const res = await fetch(`/.netlify/functions/radar?tenantId=${TENANT_ID}&lat=${latitude}&lng=${longitude}&radiusKm=50`);
      const partners = await res.json();
      partners.forEach((b) => {
        L.circleMarker([b.lat, b.lng], { radius: 9, color: '#0B6E4F', fillColor: '#F2C14E', fillOpacity: 1 })
          .addTo(mapInstanceRef.current)
          .bindPopup(`<b>${b.name}</b><br>${b.category}${b.hasActiveOffer ? '<br>🎟️ tem oferta ativa' : ''}`);
      });

      // Outros comércios da regiao, cadastrados ou nao no nosso sistema (OpenStreetMap, sem custo)
      try {
        const query = `[out:json][timeout:20];(node["tourism"](around:6000,${latitude},${longitude});way["tourism"](around:6000,${latitude},${longitude});node["amenity"~"restaurant|cafe|bar"](around:6000,${latitude},${longitude}););out center 80;`;
        const osmRes = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: query });
        const osmData = await osmRes.json();
        (osmData.elements || []).forEach((el) => {
          const lat = el.lat ?? el.center?.lat;
          const lon = el.lon ?? el.center?.lon;
          if (!lat || !lon) return;
          L.circleMarker([lat, lon], { radius: 5, color: '#94a3b8', fillColor: '#cbd5e1', fillOpacity: 0.9 })
            .addTo(mapInstanceRef.current)
            .bindPopup(`${el.tags?.name || 'Estabelecimento da região'}${el.tags?.tourism ? ` (${el.tags.tourism})` : ''}`);
        });
      } catch { /* mapa de parceiros continua funcionando mesmo se isso falhar */ }

      setMapStatus('done');
    }, () => setMapStatus('denied'));
  }

  return (
    <main style={{ background: theme.bg, minHeight: '100vh' }}>
      <Header title={t.offersTitle} />
      <div style={wrap}>

      {!customerId && (
        <div style={card}>
          <h3>{t.identify}</h3>
          <input style={input} placeholder={t.phone} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <input style={input} placeholder={t.name} value={name} onChange={(e) => setName(e.target.value)} />
          <input style={input} placeholder={t.email} value={email} onChange={(e) => setEmail(e.target.value)} />
          <input style={input} placeholder={t.instagram} value={instagram} onChange={(e) => setInstagram(e.target.value)} />
          <p style={{ fontSize: 12 }}>{t.noPasswordNote}</p>
        </div>
      )}

      {justClaimed && (
        <div style={{ ...card, border: '3px solid #F2C14E', textAlign: 'center' }}>
          <h3>{t.yourCoupon}</h3>
          <div ref={qrDivRef} style={{ display: 'flex', justifyContent: 'center', margin: '0 auto' }} />
          <p style={{ fontSize: 20, fontWeight: 700, letterSpacing: 2, marginTop: 12 }}>{justClaimed.publicId}</p>
          <p style={{ fontSize: 11 }}>{t.shortCodeLabel}</p>
          <p style={{ fontSize: 22, fontWeight: 700, letterSpacing: 3 }}>{justClaimed.shortCode}</p>
          <p style={{ fontSize: 11 }}>{t.fullCodeLabel} <code>{justClaimed.rawToken}</code></p>
          <p style={{ fontSize: 12, color: '#c0392b' }}>{t.saveWarning}</p>
        </div>
      )}

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t.availableOffers}</h3>
        {offers.length === 0 ? <p>{t.noOffers}</p> : offers.map((o) => (
          <div key={o.templateId} style={{
            display: 'flex', alignItems: 'center', gap: 14, border: `1px solid ${theme.border}`,
            borderRadius: 12, padding: 12, marginBottom: 10, background: theme.bg,
          }}>
            {o.imageUrl ? (
              <img src={o.imageUrl} alt={o.title} style={{ width: 56, height: 44, objectFit: 'cover', borderRadius: 10, flexShrink: 0 }} />
            ) : (
              <div style={{
                background: theme.gold, color: theme.greenDark, fontWeight: 900, fontSize: 15,
                borderRadius: 10, width: 56, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                textAlign: 'center', lineHeight: 1.1, flexShrink: 0,
              }}>
                {Number(o.benefitValue)}%<br /><span style={{ fontSize: 9, fontWeight: 700 }}>OFF</span>
              </div>
            )}
            <div style={{ flex: 1 }}>
              <strong>{o.title}</strong>
              <div style={{ fontSize: 12, color: theme.textMuted }}>{o.businessName} · {o.category} · {Number(o.benefitValue)}% OFF</div>
            </div>
            <button style={btn} onClick={() => claim(o.templateId)}>{t.redeem}</button>
          </div>
        ))}
      </div>

      <div style={card}>
        <h3>{t.mapTitle}</h3>
        <p style={{ fontSize: 12 }}>{t.mapLegend}</p>
        <button style={btn} onClick={showMap}>{mapStatus === 'idle' ? t.showMap : t.updateMap}</button>
        {mapStatus === 'denied' && <p style={{ fontSize: 13 }}>{t.locationDenied}</p>}
        <div ref={mapRef} style={{ height: 320, marginTop: 12, borderRadius: 8, display: mapStatus === 'idle' ? 'none' : 'block' }} />
      </div>

      {customerId && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>{t.myCoupons}</h3>
          {myCoupons.length === 0 ? <p>{t.noneYet}</p> : myCoupons.map((c) => (
            <div key={c.publicId} onClick={() => handleOpenCoupon(c.publicId)} style={{
              display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', border: `1px solid ${theme.border}`,
              borderRadius: 12, padding: 12, marginBottom: 8, background: theme.bg,
            }}>
              <div style={{ flex: 1 }}>
                <strong>{c.title}</strong>
                <div style={{ fontSize: 12, color: theme.textMuted }}>{c.publicId} · {c.businessName}</div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                background: c.status === 'VALIDATED' ? theme.greenLight : theme.gold,
                color: c.status === 'VALIDATED' ? theme.green : theme.greenDark,
              }}>{c.status === 'AVAILABLE' ? 'Activo' : c.status}</span>
            </div>
          ))}
          {openCoupon && (
            <div style={{ textAlign: 'center', marginTop: 12, borderTop: `1px solid ${theme.border}`, paddingTop: 12 }}>
              <div ref={myCouponQrDivRef} style={{ display: 'flex', justifyContent: 'center', margin: '0 auto' }} />
              <p style={{ fontSize: 13, fontWeight: 700 }}>{openCoupon.publicId}</p>
            </div>
          )}
        </div>
      )}

      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
      </div>
    </main>
  );
}
