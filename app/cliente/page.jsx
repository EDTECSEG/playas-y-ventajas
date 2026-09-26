'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../lib/LanguageContext';
import Header from '../components/Header';
import { theme } from '../../lib/theme';

const wrap = { maxWidth: 720, margin: '0 auto', padding: '20px 20px 80px', color: theme.text, background: theme.bg, minHeight: '100vh' };
const card = { background: theme.card, color: theme.text, borderRadius: 14, padding: 20, marginBottom: 16, border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)' };
const input = { padding: 9, borderRadius: 8, border: `1px solid ${theme.border}`, marginRight: 8, marginBottom: 8 };
const btn = { padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: theme.gold, color: theme.greenDark, fontWeight: 700 };
const smallBtn = { ...btn, padding: '5px 12px', fontSize: 12 };

const TENANT_ID = '0dc57eeb-46c8-47ac-aad4-640d9d59e7b9';

// Uma requisicao travada nao rejeita: o fetch fica pendurado para sempre e a
// tela mostrava "Nenhuma oferta" sem explicacao, como se o banco estivesse
// vazio. Cortar no tempo converte o travamento no mesmo caminho de erro de
// rede, que a tela sabe exibir.
const OFERTAS_TIMEOUT_MS = 15000;

function fetchComTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OFERTAS_TIMEOUT_MS);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

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
  const [emailCode, setEmailCode] = useState('');
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const requestEmailCode = async () => {
    setMsg(''); setMsg('Enviaremos um codigo de 6 digitos para o seu email.');
    try {
      const res = await fetch('/.netlify/functions/send-otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const data = await res.json();
      if (res.ok) { setEmailCodeSent(true); setMsg('Codigo enviado! Confira seu email (inclusive o lixo eletronico).'); }
      else { setMsg('Erro ao enviar codigo: ' + (data.error || 'tente novamente')); }
    } catch (err) { setMsg('Falha ao enviar codigo: ' + err.message); }
  };
  const [emailVerified, setEmailVerified] = useState(false);
  const [customerId, setCustomerId] = useState(null);
  const [offers, setOffers] = useState([]);
  // Separado de msg de proposito: msg e feedback de acao (cupom resgatado,
  // cadastro feito) e e sobrescrita o tempo todo. Aqui o que importa e nao
  // mentir: "nao ha ofertas" e "nao consegui buscar as ofertas" sao coisas
  // diferentes, e mostrar a primeira quando o servidor esta quebrado faz o
  // consumidor achar que a loja sumiu.
  const [offersErro, setOffersErro] = useState('');
  const [cities, setCities] = useState([]);
  const [filter, setFilter] = useState({ city: '', category: '', radiusKm: null, byDistance: false });
  const [filterMsg, setFilterMsg] = useState('');
  const [myCoupons, setMyCoupons] = useState([]);
  const [couponFilter, setCouponFilter] = useState('available');
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
      loadMyCoupons(s.customerId, s.customerToken).catch(() => { /* cupons e opcional: nao derruba a tela */ });
    }
    loadOffers();
    loadCityAndCategoryOptions();
  }, []);

  async function loadOffers() {
    const params = new URLSearchParams({ tenantId: TENANT_ID });
    if (filter.city) params.set('city', filter.city);
    if (filter.category) params.set('category', filter.category);
    if (filter.byDistance && filter.lat != null && filter.lng != null) {
      params.set('lat', filter.lat);
      params.set('lng', filter.lng);
      params.set('radiusKm', filter.radiusKm || 50);
    }
    // O endpoint devolve array no caminho feliz, mas em erro devolve
    // {"error": ...} com 500. setOffers com esse objeto chegava ao render,
    // onde offers.length e undefined e offers.map estoura: a pagina inteira
    // caia em "Application error" em vez de mostrar a lista. Erro de rede e
    // resposta fora do esperado caem no mesmo caminho.
    try {
      const res = await fetchComTimeout(`/.netlify/functions/offers?${params.toString()}`);
      if (!res.ok) {
        setOffers([]);
        setOffersErro('Nao foi possivel carregar as ofertas. Tente de novo em instantes.');
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        setOffers([]);
        setOffersErro('Nao foi possivel carregar as ofertas. Tente de novo em instantes.');
        return;
      }
      setOffers(data);
      setOffersErro('');
    } catch (err) {
      setOffers([]);
      setOffersErro('Nao foi possivel carregar as ofertas. Verifique sua conexao.');
    }
  }

  async function loadCityAndCategoryOptions() {
    if (cities.length > 0) {
      setFilter((f) => ({ ...f, categories: Array.from(new Set(offers.map((o) => o.category).filter(Boolean))) }));
      return;
    }
    try {
      const res = await fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}&mode=cities`);
      if (res.ok) {
        const data = await res.json();
        const opts = Array.isArray(data) ? data : (Array.isArray(data.cities) ? data.cities : []);
        setCities(opts);
        if (opts.length === 1) {
          setFilter((f) => ({ ...f, city: opts[0], categories: Array.from(new Set(offers.map((o) => o.category).filter(Boolean))) }));
        }
      }
    } catch { /* chips opcionais: ofertas continuam carregando mesmo se isso falhar */ }
  }

  async function loadMyCoupons(cid, token) {
    const saved = JSON.parse(localStorage.getItem('pyv_customer') || 'null');
    let tk = token || (saved && saved.customerToken);
    let res = await fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}&mode=my-coupons&customerId=${cid}&customerToken=${tk}`);
    if (res.status === 401) {
      // Token invalido: re-identifica pelo telefone salvo para renovar o customerToken.
      const idRes = await fetch('/.netlify/functions/identify', {
        method: 'POST',
        body: JSON.stringify({ phone: (saved && saved.phone) || phone }),
      });
      const idData = await idRes.json();
      if (!idRes.ok || !idData.customerToken) return;
      const cur = JSON.parse(localStorage.getItem('pyv_customer') || 'null') || {};
      localStorage.setItem('pyv_customer', JSON.stringify({ ...cur, customerToken: idData.customerToken }));
      tk = idData.customerToken;
      res = await fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}&mode=my-coupons&customerId=${cid}&customerToken=${tk}`);
    }
    const data = await res.json();
    if (res.ok) setMyCoupons(data);
  }

  async function finalizeRegistration() {
    if (!phone) { setMsg('Informe seu telefone.'); return; }
    if (email && !emailCode) { setMsg('Informe o código enviado ao teu email.'); return; }
    const res = await fetch('/.netlify/functions/identify', { method: 'POST', body: JSON.stringify({ phone, name, email, instagram, emailCode }) });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    localStorage.setItem('pyv_customer', JSON.stringify({ phone, name, instagram, email, customerId: data.customerId, customerToken: data.customerToken }));
    setCustomerId(data.customerId);
    setMsg('✅ Cadastro finalizado com sucesso!');
    loadMyCoupons(data.customerIdiden0);
  }

  async function claim(offer) {
    const templateId = offer.templateId;
    const saved = JSON.parse(localStorage.getItem('pyv_customer') || 'null') || {};
    const effPhone = phone || saved.phone;
    if (!effPhone) { setMsg('Informe seu telefone primeiro.'); return; }
    const effName = name || saved.name || '';
    const effInstagram = instagram || saved.instagram || '';
    const effEmail = email || saved.email || '';
    const res = await fetch('/.netlify/functions/claim-coupon', {
      method: 'POST',
      body: JSON.stringify({ tenantId: TENANT_ID, templateId, phone: effPhone, name: effName, instagram: effInstagram, email: effEmail }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    localStorage.setItem('pyv_customer', JSON.stringify({ ...saved, phone: effPhone, name: effName, instagram: effInstagram, email: effEmail, customerId: data.customerId, customerToken: data.customerToken }));
    const tokens = JSON.parse(localStorage.getItem('pyv_coupon_tokens') || '{}');
    tokens[data.publicId] = data.rawToken;
    localStorage.setItem('pyv_coupon_tokens', JSON.stringify(tokens));
    const logos = JSON.parse(localStorage.getItem('pyv_coupon_logos') || '{}');
    logos[data.publicId] = { businessName: offer.businessName, logoUrl: offer.logoUrl || null, businessId: offer.businessId || null, title: offer.title, benefitValue: offer.benefitValue };
    localStorage.setItem('pyv_coupon_logos', JSON.stringify(logos));
    setCustomerId(data.customerId);
    setJustClaimed({ ...data, businessName: offer.businessName, title: offer.title, benefitValue: offer.benefitValue, logoUrl: offer.logoUrl || null });
    loadMyCoupons(data.customerId);

    // Mensagem honesta: o resgate ja esta garantido; o WhatsApp e o canal.
    const bonus = data.referral && data.referral.converted;
    let msg = 'Cupom resgatado! Guarde o QR abaixo — mostre no estabelecimento.';
    if (data.whatsappUrl) msg += ' Toque em WhatsApp para mandar o código.';
    if (bonus) msg += ' Você ganhou um bônus de indicação!';
    setMsg(msg);
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
        setTimeout(() => qrDivRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
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

  function handleOpenCoupon(c) {
    const tokens = JSON.parse(localStorage.getItem('pyv_coupon_tokens') || '{}');
    const rawToken = tokens[c.publicId];
    if (!rawToken) { setMsg('Código não disponível neste aparelho. Se você o resgatou em outro dispositivo ou limpou os dados do navegador, ele não pode ser recuperado — é necessário ter salvo o print no momento do resgate.'); setOpenCoupon(null); return; }
    setMsg('');
    const logos = JSON.parse(localStorage.getItem('pyv_coupon_logos') || '{}');
    const meta = logos[c.publicId];
    const businessId = c.businessId || (meta && meta.businessId);
    setOpenCoupon({
      ...c,
      rawToken,
      logoUrl: (meta && meta.logoUrl) || null,
      businessName: c.businessName || (meta && meta.businessName) || '—',
      title: c.title || (meta && meta.title) || '',
    });
    if (businessId) {
      (async () => {
        try {
          const res = await fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}&businessLogoFor=${businessId}`);
          const logo = await res.json();
          if (res.ok && logo && logo.logoUrl) setOpenCoupon((prev) => (prev ? { ...prev, logoUrl: logo.logoUrl } : prev));
        } catch { /* logo opcional */ }
      })();
    }
  }

  async function showMap() {
    setMapStatus('locating');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      const L = await loadLeaflet();
      if (!mapInstanceRef.current) {
        mapInstanceRef.current = L.map(mapRef.current).setView([latitude, longitude], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(mapInstanceRef.current);
        // O contêiner da div sai de display:none e o Leaflet precisa recalcular o
        // tamanho (senão marcadores "escapam" do lugar ao dar zoom).
        setTimeout(() => mapInstanceRef.current.invalidateSize(), 0);
        setTimeout(() => mapInstanceRef.current.invalidateSize(), 300);
        window.addEventListener('resize', () => mapInstanceRef.current.invalidateSize());
      }
      // Localização do usuário: ponto pequeno, sem clique, para não cobrir a
      // empresa que ocupa a mesma posição e não atrapalhar ao tocar nela.
      L.circleMarker([latitude, longitude], { radius: 5, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.85, weight: 1, interactive: false })
        .addTo(mapInstanceRef.current);

      // Nossos parceiros (verde)
      let currentOffers = Array.isArray(offers) ? offers : [];
      if (currentOffers.length === 0) {
        try {
          const ores = await fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}`);
          const od = await ores.json();
          if (Array.isArray(od)) currentOffers = od;
        } catch { /* segue só com o radar */ }
      }
      const offersByBiz = {};
      currentOffers.forEach((o) => { if (o.businessId) (offersByBiz[o.businessId] = offersByBiz[o.businessId] || []).push(o); });
      const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const businessBlock = (g) => {
        const offs = offersByBiz[g.id] || [];
        let h = g.logoUrl
          ? `<img src="${esc(g.logoUrl)}" alt="" style="width:24px;height:24px;object-fit:cover;border-radius:50%;vertical-align:middle;margin-right:6px" />`
          : '';
        h += `<b>${esc(g.name)}</b><br>${esc(g.category)}`;
        if (offs.length) {
          offs.forEach((of) => {
            h += `<div style="margin-top:6px;border-top:1px solid #e2e8f0;padding-top:6px"><strong>🎟️ ${esc(of.title)}</strong>`;
            if (of.imageUrl) {
              h += `<img src="${esc(of.imageUrl)}" data-claim="${esc(of.templateId)}" style="width:92px;height:68px;object-fit:cover;border-radius:8px;margin-top:6px;cursor:pointer;display:block" title="Toque para resgatar" />`;
            }
            h += `<br><button data-claim="${esc(of.templateId)}" style="margin-top:6px;background:#F2C14E;border:none;border-radius:8px;padding:6px 12px;font-weight:700;cursor:pointer;color:#083b2a">🎟️ ${t.redeem}</button></div>`;
          });
        } else if (g.hasActiveOffer) {
          h += `<br>🎟️ ${t.hasActiveOffer}`;
        }
        return h;
      };
      // Card compacto de uma empresa (para grupos, lado a lado).
      const businessCard = (g) => {
        const offs = offersByBiz[g.id] || [];
        let cc = `<div style="flex:1 1 0;min-width:0;max-width:120px;border:1px solid #e2e8f0;border-radius:8px;padding:6px;text-align:center;background:#fff;display:flex;flex-direction:column;align-items:center">`;
        if (g.logoUrl) {
          cc += `<img src="${esc(g.logoUrl)}" style="width:26px;height:26px;object-fit:cover;border-radius:50%;margin:0 auto 3px;display:block" alt="" />`;
        }
        cc += `<div style="font-size:10px;font-weight:700;color:#083b2a;overflow-wrap:anywhere;line-height:1.2">${esc(g.name)}</div>`;
        if (offs.length) {
          offs.forEach((of) => {
            if (of.imageUrl) {
              cc += `<img src="${esc(of.imageUrl)}" data-claim="${esc(of.templateId)}" style="width:100%;height:44px;object-fit:cover;border-radius:6px;margin-top:5px;cursor:pointer;display:block" title="Toque para resgatar" />`;
            }
            cc += `<button data-claim="${esc(of.templateId)}" style="margin-top:4px;background:#F2C14E;border:none;border-radius:6px;padding:3px 6px;font-size:10px;font-weight:700;cursor:pointer;color:#083b2a;width:100%">🎟️ ${esc(of.title)}</button>`;
          });
        } else if (g.hasActiveOffer) {
          cc += `<div style="font-size:9px;color:#0B6E4F;margin-top:4px">${t.hasActiveOffer}</div>`;
        }
        cc += `</div>`;
        return cc;
      };
      try {
        const res = await fetch(`/.netlify/functions/radar?tenantId=${TENANT_ID}&lat=${latitude}&lng=${longitude}&radiusKm=50`);
        const partners = await res.json();
        if (Array.isArray(partners)) {
          // Empresas a menos de ~110m (mesmo précio/endereço) viram um grupo.
          const groups = {};
          partners.forEach((b) => {
            const key = `${Math.round(b.lat * 1000)}|${Math.round(b.lng * 1000)}`;
            (groups[key] = groups[key] || []).push(b);
          });
          Object.values(groups).forEach((group) => {
            try {
              const shared = group.length > 1;
              const popupHtml = shared
                ? `<div style="display:flex;flex-wrap:nowrap;align-items:flex-start;justify-content:space-between;gap:6px;max-width:210px">${group.map(businessCard).join('')}</div>`
                : businessBlock(group[0]);
              let marker;
              if (shared) {
                // Um único marcador na coordenada exata com os logos lado a lado.
                const logos = group.filter((g) => g.logoUrl).slice(0, 2).map((g) =>
                  `<img src="${esc(g.logoUrl)}" alt="" style="width:18px;height:18px;object-fit:cover;border-radius:50%;border:2px solid #FFFFFF;margin-left:${group.filter((x) => x.logoUrl).length > 1 ? -7 : 0}px;box-shadow:0 1px 3px rgba(0,0,0,0.4)" />`
                ).join('');
                const countBadge = group.length > 2 ? `<span style="color:#083b2a;font-weight:800;font-size:10px;background:#F2C14E;border-radius:999px;padding:0 4px;margin-left:2px">+${group.length - 2}</span>` : '';
                const html = logos
                  ? `<div style="display:flex;align-items:center;min-width:${18 + group.filter((x) => x.logoUrl).length * 11}px;justify-content:flex-start">${logos}${countBadge}</div>`
                  : `<div style="width:26px;height:26px;border-radius:50%;background:#F2C14E;color:#083b2a;font-weight:900;font-size:12px;display:flex;align-items:center;justify-content:center;border:2px solid #FFFFFF;box-shadow:0 1px 3px rgba(0,0,0,0.4)">${group.length}</div>`;
                marker = L.marker([group[0].lat, group[0].lng], { icon: L.divIcon({ className: 'pyv-biz-marker', iconSize: [36, 26], iconAnchor: [18, 13], html }) });
              } else {
                const b = group[0];
                marker = b.logoUrl
                  ? L.marker([b.lat, b.lng], { icon: L.divIcon({ className: 'pyv-biz-marker', iconSize: [28, 28], iconAnchor: [14, 14], html: `<img src="${esc(b.logoUrl)}" alt="" style="width:28px;height:28px;object-fit:cover;border-radius:50%;border:2px solid #FFFFFF;box-shadow:0 1px 4px rgba(0,0,0,0.4)" />` }) })
                  : L.circleMarker([b.lat, b.lng], { radius: 6, color: '#0B6E4F', fillColor: '#F2C14E', fillOpacity: 1 });
              }
              marker.addTo(mapInstanceRef.current).bindPopup(popupHtml);
              marker.on('popupopen', (e) => {
                e.popup.getElement().querySelectorAll?.('[data-claim]').forEach((el) => {
                  const tid = el.getAttribute('data-claim');
                  el.addEventListener('click', () => claim(currentOffers.find((x) => x.templateId === tid) || { templateId: tid }));
                });
              });
            } catch { /* um grupo falho nao derruba os demais */ }
          });
        }
      } catch { /* radar indisponivel nao derruba o mapa */ }

      // Outros comércios da regiao, cadastrados ou nao no nosso sistema.
      // Vai pelo nosso endpoint e nao direto do OpenStreetMap: na versao anterior
      // a pagina chamava o Overpass do navegador, que nao devolve
      // Access-Control-Allow-Origin — a resposta era recusada por CORS, o catch
      // engolia o erro e esta camada nunca aparecia.
      try {
        const placesRes = await fetchComTimeout(
          `/.netlify/functions/map-places?lat=${encodeURIComponent(latitude)}&lng=${encodeURIComponent(longitude)}`
        );
        const placesData = await placesRes.json();
        (placesData.lugares || []).forEach((p) => {
          L.circleMarker([p.lat, p.lng], { radius: 5, color: '#94a3b8', fillColor: '#cbd5e1', fillOpacity: 0.9 })
            .addTo(mapInstanceRef.current)
            .bindPopup(`${p.nome}${p.categoria ? ` (${p.categoria})` : ''}`);
        });
      } catch { /* mapa de parceiros continua funcionando mesmo se isso falhar */ }

      setMapStatus('done');
    }, () => setMapStatus('denied'));
  }

  return (
    <main style={{ background: theme.bg, minHeight: '100vh' }}>
      <style>{`
        @media (max-width: 400px) {
          .offer-row { flex-wrap: wrap; }
          .offer-info { flex: 1 1 100% !important; order: 2; }
          .offer-img { order: 1; }
          .offer-btn { order: 3; align-self: center; }
        }
      `}</style>
      <Header title={t.offersTitle} />
      <div style={wrap}>

      {!customerId && (
        <div style={card}>
          <h3>{t.identify}</h3>
          <input style={input} placeholder={t.phone} value={phone} onChange={(e) => setPhone(e.target.value)} />
          <input style={input} placeholder={t.name} value={name} onChange={(e) => setName(e.target.value)} />
          <input style={input} placeholder={t.email} value={email} onChange={(e) => setEmail(e.target.value)} />
          {email && !emailCodeSent && (
            <div>
              <button style={btn} onClick={requestEmailCode}>Enviar código de confirmação</button>
              <p style={{ fontSize: 11, color: '#888', margin: '0 0 6px' }}>Enviaremos um código de 6 dígitos para <strong>{email}</strong>.</p>
            </div>
          )}
          {emailCodeSent && (
            <input
              style={input}
              placeholder="Digite o código de 6 dígitos recebido por email"
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
            />
          )}
          <input style={input} placeholder={t.instagram} value={instagram} onChange={(e) => setInstagram(e.target.value)} />
          <p style={{ fontSize: 12 }}>{t.noPasswordNote}</p>
          <button style={btn} onClick={finalizeRegistration}>{t.finishRegistration}</button>
        </div>
      )}

      {justClaimed && (
        <div style={{ ...card, border: '3px solid #F2C14E', textAlign: 'center' }}>
          {justClaimed.logoUrl && (
            <img src={justClaimed.logoUrl} alt={justClaimed.businessName} style={{ height: 48, borderRadius: 8, marginBottom: 6 }} />
          )}
          <h3 style={{ margin: 0 }}>{justClaimed.businessName || t.yourCoupon}</h3>
          <div ref={qrDivRef} style={{ display: 'flex', justifyContent: 'center', margin: '0 auto' }} />
          <p style={{ fontSize: 17, fontWeight: 700, letterSpacing: 1, marginTop: 12 }}>
            {justClaimed.title}
            {justClaimed.benefitValue != null && <> · {Number(justClaimed.benefitValue)}% OFF</>}
          </p>
          <p style={{
            fontSize: 15, fontWeight: 800, letterSpacing: 1.5, color: theme.greenDark,
            background: theme.goldLight, border: `1px solid ${theme.gold}`, borderRadius: 10,
            padding: '8px 10px', margin: '10px 0 0', fontFamily: 'monospace',
          }}>
            {justClaimed.publicId}
          </p>
          {justClaimed.shortCode && (
            <p style={{ fontSize: 13, color: theme.textMuted, margin: '8px 0 0' }}>
              Código curto: <strong style={{ letterSpacing: 2 }}>{justClaimed.shortCode}</strong>
            </p>
          )}

          {/* WhatsApp: link wa.me (gratuito, sem API). O usuario so toca em enviar. */}
          {justClaimed.whatsappUrl && (
            <a
              href={justClaimed.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                marginTop: 12, padding: '11px 14px', borderRadius: 10, textDecoration: 'none',
                background: '#128C4A', color: '#fff', fontWeight: 700, fontSize: 14,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.7.2-.2.3-.7 1-.9 1.1-.2.2-.3.2-.6.1-1.7-.9-2.8-1.6-3.9-3.5-.3-.5.3-.5.8-1.5.1-.2 0-.4 0-.5s-.7-1.6-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.2 5 4.4 1.9.8 2.6.9 3.5.7.6-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.2-.3-.3-.6-.4zM12 2C6.5 2 2 6.5 2 12c0 1.8.5 3.4 1.3 4.9L2 22l5.3-1.3c1.4.8 3 1.2 4.7 1.2 5.5 0 10-4.5 10-10S17.5 2 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3.1.8.8-3-.2-.3c-.8-1.3-1.2-2.8-1.2-4.3 0-4.5 3.7-8.2 8.3-8.2s8.2 3.7 8.2 8.2-3.6 8.2-8.2 8.2z" />
              </svg>
              Enviar cupom pelo WhatsApp
            </a>
          )}

          {justClaimed.referral && justClaimed.referral.converted && (
            <p style={{ fontSize: 12, color: theme.greenDark, margin: '10px 0 0' }}>
              Você foi indicado por um parceiro — seu bônus de boas-vindas já está creditado.
            </p>
          )}
        </div>
      )}

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{customerId && name ? `${t.availableOffers} · ${name}` : t.availableOffers}</h3>
        {cities.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 12px' }}>
            <button
              style={{
                ...smallBtn, borderRadius: 999, padding: '5px 12px', cursor: 'pointer',
                background: filter.city === '' ? theme.gold : theme.bg,
                color: filter.city === '' ? theme.greenDark : theme.text,
                border: `1px solid ${filter.city === '' ? theme.gold : theme.border}`,
              }}
              onClick={() => { setFilter((f) => ({ ...f, city: '' })); loadOffers(); }}
            >{t.allCities}</button>
            {cities.map((c) => (
              <button
                key={c}
                style={{
                  ...smallBtn, borderRadius: 999, padding: '5px 12px', cursor: 'pointer',
                  background: filter.city === c ? theme.gold : theme.bg,
                  color: filter.city === c ? theme.greenDark : theme.text,
                  border: `1px solid ${filter.city === c ? theme.gold : theme.border}`,
                }}
                onClick={() => { setFilter((f) => ({ ...f, city: c })); loadOffers(); }}
              >{c}</button>
            ))}
          </div>
        )}
        {offersErro ? (
          <p style={{ color: '#B42318', margin: 0 }}>{offersErro}</p>
        ) : offers.length === 0 ? <p>{t.noOffers}</p> : offers.map((o) => (
          <div key={o.templateId} className="offer-row" style={{
            display: 'flex', alignItems: 'center', gap: 14, border: `1px solid ${theme.border}`,
            borderRadius: 12, padding: 12, marginBottom: 10, background: theme.bg,
          }}>
            {o.imageUrl ? (
              <img className="offer-img" src={o.imageUrl} alt={o.title} style={{ width: 56, height: 44, objectFit: 'cover', borderRadius: 10, flexShrink: 0 }} />
            ) : (
              <div className="offer-img" style={{
                background: theme.gold, color: theme.greenDark, fontWeight: 900, fontSize: 15,
                borderRadius: 10, width: 56, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                textAlign: 'center', lineHeight: 1.1, flexShrink: 0,
              }}>
                {Number(o.benefitValue)}%<br /><span style={{ fontSize: 9, fontWeight: 700 }}>OFF</span>
              </div>
            )}
            <button className="offer-btn" style={{ ...smallBtn, flexShrink: 0 }} onClick={() => claim(o)}>{t.redeem}</button>
            <div className="offer-info" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
              <strong>{o.title}</strong>
              <div style={{ fontSize: 12, color: theme.textMuted }}>{o.businessName} · {o.category} · {Number(o.benefitValue)}% OFF</div>
            </div>
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
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {['available', 'redeemed', 'all'].map((f) => (
              <button key={f} onClick={() => setCouponFilter(f)} style={{
                ...smallBtn,
                background: couponFilter === f ? theme.gold : theme.bg,
                color: couponFilter === f ? theme.greenDark : theme.text,
                border: `1px solid ${theme.border}`,
              }}>{t['filter_' + f]}</button>
            ))}
          </div>
          {myCoupons.length === 0 ? <p>{t.noneYet}</p> : (() => {
            const filtered = myCoupons.filter((c) => couponFilter === 'all' || (couponFilter === 'available' ? c.status !== 'VALIDATED' : c.status === 'VALIDATED'));
            if (filtered.length === 0) return <p>{t.noMatchedCoupons}</p>;
            return filtered.map((c) => (
            <div key={c.publicId} onClick={() => handleOpenCoupon(c)} style={{
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
              }}>{c.status === 'AVAILABLE' ? t.statusAvailable : c.status}</span>
            </div>
            ));
          })()}
          {openCoupon && (
            <div style={{ textAlign: 'center', marginTop: 12, borderTop: `1px solid ${theme.border}`, paddingTop: 12 }}>
              {openCoupon.logoUrl && (
                <img src={openCoupon.logoUrl} alt={openCoupon.businessName} style={{ height: 40, borderRadius: 8, marginBottom: 4 }} />
              )}
              <strong style={{ fontSize: 15 }}>{openCoupon.businessName}</strong>
              <div ref={myCouponQrDivRef} style={{ display: 'flex', justifyContent: 'center', margin: '0 auto' }} />
              <p style={{ fontSize: 14, fontWeight: 700, margin: '8px 0 0' }}>{openCoupon.title}</p>
              <p style={{
                fontSize: 15, fontWeight: 800, letterSpacing: 1.5, color: '#0B6E4F',
                background: '#FDF3D7', border: '1px solid #E8C46A', borderRadius: 8,
                padding: '6px 10px', margin: '8px 0 0', fontFamily: 'monospace',
              }}>{openCoupon.publicId}</p>
            </div>
          )}
        </div>
      )}

      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
      </div>
    </main>
  );
}

