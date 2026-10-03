'use client';

import { useRef, useState } from 'react';
import { useLanguage } from '../../lib/LanguageContext';
import Header from '../components/Header';
import ModuleSplash from '../components/ModuleSplash';
import { theme } from '../../lib/theme';

function loadQrScanner() {
  return new Promise((resolve, reject) => {
    if (window.Html5Qrcode) return resolve(window.Html5Qrcode);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    script.onload = () => resolve(window.Html5Qrcode);
    // Sem onerror a promessa nunca resolve nem rejeita: a tela ficava em
    // "abrindo camera" para sempre quando a CDN estava fora do ar.
    script.onerror = () => reject(new Error('falha de rede ao carregar o leitor de QR code'));
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

const CATEGORY_OPTIONS = [
  ['passeio', 'Passeio'], ['hotel', 'Hotel'], ['pousada', 'Pousada'],
  ['restaurante', 'Restaurante'], ['bar', 'Bar'], ['translado', 'Translado'], ['servico', 'Serviço'],
];

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
  const [myData, setMyData] = useState({ name: '', phone: '', email: '', city: '', category: '', logoUrl: '', lat: '', lng: '' });
  const [featuredSel, setFeaturedSel] = useState({});
  const [igForm, setIgForm] = useState({ templateId: '', title: '', value: '', businessName: '', handle: '' });
  const igCanvasRef = useRef(null);
  const [mustChangePin, setMustChangePin] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [newPin2, setNewPin2] = useState('');
  const [authMode, setAuthMode] = useState('login');
  // Revisao de cadastro de motorista. `drivers` vem de driver-list-for-business,
  // que NAO traz doc_url: o arquivo sai sob demanda em driver-document-url, que
  // devolve uma URL assinada de 5 minutos. Ver `openDocument`.
  const [drivers, setDrivers] = useState([]);
  const [driversMsg, setDriversMsg] = useState('');
  const [driversBusy, setDriversBusy] = useState(false);
  const [rejeitando, setRejeitando] = useState(null);
  const [motivo, setMotivo] = useState('');
  // Redefinicao de PIN do motorista (driver-reset-pin). `resetandoPin` e o id do
  // cadastro com o campo aberto; `pinNovo` e o valor digitado pela empresa — o
  // app do motorista nao tem caminho para trocar o proprio PIN, entao este e o
  // unico. Nao volta do servidor: o PIN digitado e descartado com o campo.
  const [resetandoPin, setResetandoPin] = useState(null);
  const [pinNovo, setPinNovo] = useState('');
  // Servicos de translado do proprio negocio (painel). `shuttleForm` vira o
  // corpo de save_shuttle_service; `stopsText` e uma linha por parada no
  // formato "Rotulo|lat|lng".
  const [shuttles, setShuttles] = useState([]);
  const [shuttleMsg, setShuttleMsg] = useState('');
  const [shuttleBusy, setShuttleBusy] = useState(false);
  const [shuttleForm, setShuttleForm] = useState({
    serviceId: '', name: '', description: '', serviceType: 'shuttle',
    originLat: '', originLng: '', destLat: '', destLng: '',
    priceCents: '', opensAt: '', closesAt: '', activeDays: '1,2,3,4,5,6', stopsText: '',
  });
  const [editingShuttle, setEditingShuttle] = useState(null);
  // Fila de reservas de translado: a empresa confirma/recusa/cancela.
  // `revisandoReserva` guarda o id com o motivo aberto; `reservaMotivo` o texto
  // da justificativa (opcional). `reservaFiltro` e um filtro de tela repassado
  // a RPC como p_status; os demais campos sao iguais aos de `motoristas`.
  const [reservations, setReservations] = useState([]);
  const [reservationsMsg, setReservationsMsg] = useState('');
  const [reservationsBusy, setReservationsBusy] = useState(false);
  const [reservaFiltro, setReservaFiltro] = useState('');
  const [revisandoReserva, setRevisandoReserva] = useState(null);
  const [reservaMotivo, setReservaMotivo] = useState('');

  // --- Relatorio (business_report_v3, com degradacao para business_report) ---
  // Bloco proprio e aditivo: nao encosta em nenhuma variavel dos modos acima,
  // entao o agente da aba Reservas pode mexer noTranslations sem colidir aqui.
  const [report, setReport] = useState(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportMsg, setReportMsg] = useState('');
  const [reportDays, setReportDays] = useState(30);
  const [reportBillingBusy, setReportBillingBusy] = useState(false);
  const [reportBillingMsg, setReportBillingMsg] = useState('');
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
    if (res.ok) setMyData({ name: data.name || '', phone: data.phone || '', email: data.email || '', city: data.city || '', category: data.category || '', logoUrl: data.logoUrl || '', lat: data.lat ?? '', lng: data.lng ?? '' });
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

  // --- Servicos de translado ------------------------------------------
  // Escrita do modulo 1: a empresa cadastra a oferta de translado e o
  // motorista (aprovado) reporta a posicao do veiculo. /cliente consome via
  // shuttle.js. Este painel lista inclusive os inativos (mode=shuttles).
  async function loadShuttles(s) {
    const sess = s || session;
    setShuttleBusy(true);
    setShuttleMsg('');
    try {
      const res = await fetch('/.netlify/functions/empresa?mode=shuttles', {
        headers: { Authorization: `Bearer ${sess.sessionToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setShuttleMsg(t.shuttleLoadError);
        setShuttles([]);
        return;
      }
      setShuttles(data || []);
      if (!(data || []).length) setShuttleMsg(t.shuttlesEmpty);
    } catch (e) {
      setShuttleMsg(t.shuttleLoadErrorGeneric);
    } finally {
      setShuttleBusy(false);
    }
  }

  function newShuttle() {
    setEditingShuttle('new');
    setShuttleForm({
      serviceId: '', name: '', description: '', serviceType: 'shuttle',
      originLat: '', originLng: '', destLat: '', destLng: '',
      priceCents: '', opensAt: '', closesAt: '', activeDays: '1,2,3,4,5,6', stopsText: '',
    });
  }

  function startEditShuttle(s) {
    setEditingShuttle(s);
    setShuttleForm({
      serviceId: s.shuttleId || '',
      name: s.name || '',
      description: s.description || '',
      serviceType: s.serviceType || 'shuttle',
      originLat: s.origin ? s.origin.lat : '',
      originLng: s.origin ? s.origin.lng : '',
      destLat: s.destination ? s.destination.lat : '',
      destLng: s.destination ? s.destination.lng : '',
      priceCents: s.priceCents != null ? s.priceCents : '',
      opensAt: s.opensAt || '',
      closesAt: s.closesAt || '',
      activeDays: Array.isArray(s.activeDays) ? s.activeDays.join(',') : '',
      stopsText: Array.isArray(s.stops)
        ? s.stops.map((st) => (st.label ? `${st.label}|${st.lat}|${st.lng}` : `${st.lat}|${st.lng}`)).join('\n')
        : '',
    });
  }

  function cancelEditShuttle() {
    setEditingShuttle(null);
    setShuttleMsg('');
  }

  function useShuttleOrigin() {
    if (!navigator.geolocation) { setShuttleMsg(t.shuttleNoGeo); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setShuttleForm({ ...shuttleForm, originLat: pos.coords.latitude.toFixed(6), originLng: pos.coords.longitude.toFixed(6) }),
      (err) => setShuttleMsg(t.shuttleNoLoc.replace('{err}', err.message)),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function saveShuttle() {
    if (!String(shuttleForm.name || '').trim()) { setShuttleMsg(t.shuttleNameRequired); return; }
    if (!shuttleForm.originLat || !shuttleForm.originLng || !shuttleForm.destLat || !shuttleForm.destLng) {
      setShuttleMsg(t.shuttleOriginDestRequired);
      return;
    }
    const stops = String(shuttleForm.stopsText || '')
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((line) => {
        const parts = line.split('|').map((x) => (x || '').trim());
        return { label: parts.length >= 3 ? (parts[0] || null) : null, lat: Number(parts[parts.length - 2]), lng: Number(parts[parts.length - 1]) };
      });
    const activeDays = String(shuttleForm.activeDays || '')
      .split(',').map((x) => Number((x || '').trim())).filter((n) => !Number.isNaN(n));
    try {
      const res = await fetch('/.netlify/functions/empresa', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        body: JSON.stringify({ action: 'save_shuttle_service', ...shuttleForm, stops, activeDays }),
      });
      const data = await res.json();
      if (!res.ok) { setShuttleMsg(`Erro: ${data.error}`); return; }
      setEditingShuttle(null);
      setShuttleMsg(t.shuttleSaved);
      await loadShuttles();
    } catch (e) {
      setShuttleMsg(t.shuttleSaveError);
    }
  }

  async function toggleShuttle(s) {
    try {
      const res = await fetch('/.netlify/functions/empresa', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        body: JSON.stringify({ action: 'toggle_shuttle_service', serviceId: s.shuttleId, isActive: !s.isActive }),
      });
      const data = await res.json();
      if (!res.ok) { setShuttleMsg(`Erro: ${data.error}`); return; }
      await loadShuttles();
    } catch (e) {
      setShuttleMsg(t.shuttleUpdateError);
    }
  }

  async function deleteShuttle(s) {
    if (!window.confirm(t.shuttleDeleteConfirm.replace('{name}', s.name))) return;
    try {
      const res = await fetch('/.netlify/functions/empresa', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.sessionToken}` },
        body: JSON.stringify({ action: 'delete_shuttle_service', serviceId: s.shuttleId }),
      });
      const data = await res.json();
      if (!res.ok) { setShuttleMsg(`Erro: ${data.error}`); return; }
      setShuttleMsg(t.shuttleDeleted);
      await loadShuttles();
    } catch (e) {
      setShuttleMsg(t.shuttleDeleteError);
    }
  }

  // --- Destaque de cupom ------------------------------------------------
  // Self-service: a empresa destaca o proprio cupom por N dias. `business_set_coupon_featured`
  // zera o anterior (sem prorrogacao) e ativa o novo ate `until` (UTC).
  async function setCouponFeatured(tpl, days) {
    const until = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
    const res = await fetch('/.netlify/functions/empresa', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.sessionToken}` },
      body: JSON.stringify({ action: 'set_coupon_featured', templateId: tpl.id, until }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    setDash((d) => ({ ...d, templates: (d?.templates || []).map((x) => (x.id === tpl.id ? { ...x, featured_until: until } : x)) }));
    if (days > 0) {
      const ate = new Date(until).toLocaleDateString();
      setMsg(`⭐ ${t.featured} ativo até ${ate}.`);
    } else {
      setMsg('⭐ Destaque removido.');
    }
  }

  // --- Card para Instagram (opcao A: gerador local) ----------------------
  // Card 1080x1080 desenhado em canvas, so com texto e formas: sem imagens
  // remotas, para nao sujar o canvas com CORS taint e o download nunca falhar.
  function wrapCanvasText(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const cand = line ? `${line} ${w}` : w;
      if (line && ctx.measureText(cand).width > maxWidth) { lines.push(line); line = w; } else { line = cand; }
    }
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }

  function pickTemplate(id) {
    const tpl = (dash?.templates || []).find((x) => x.id === id);
    if (tpl) {
      setIgForm({
        templateId: id,
        title: tpl.title || '',
        value: tpl.benefit_value != null ? tpl.benefit_value : (tpl.benefitValue ?? ''),
        businessName: (dash && (dash.businessName || dash.business_name)) || myData.name || '',
        handle: '',
      });
    }
  }

  function drawIgCard() {
    const canvas = igCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = 1080, H = 1080;
    canvas.width = W; canvas.height = H;
    const title = igForm.title.trim() || 'Oferta imperdível';
    const valueText = String(igForm.value).trim() || '0';
    const biz = igForm.businessName.trim() || 'Playas y Ventajas';
    const handle = igForm.handle.trim().replace(/^@/, '');

    // Fundo verde degradê + formas decorativas em dourado.
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0B6E4F'); g.addColorStop(1, '#064B35');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(242,193,78,0.18)';
    ctx.beginPath(); ctx.arc(W - 120, 120, 270, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(242,193,78,0.12)';
    ctx.beginPath(); ctx.arc(40, H - 60, 210, 0, Math.PI * 2); ctx.fill();

    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillStyle = '#F2C14E'; ctx.font = '900 380px Arial';
    ctx.fillText(`${valueText}%`, W / 2, 430);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 46px Arial';
    ctx.fillText('OFF', W / 2, 590);

    ctx.fillStyle = '#fff'; ctx.font = 'bold 64px Arial';
    const lines = wrapCanvasText(ctx, title, W - 160);
    lines.forEach((line, i) => ctx.fillText(line, W / 2, 750 + i * 80));

    ctx.fillStyle = '#FDF6E3'; ctx.font = 'bold 46px Arial';
    ctx.fillText(biz, W / 2, H - 170);
    if (handle) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = '34px Arial';
      ctx.fillText(`@${handle}`, W / 2, H - 100);
    }
  }

  function igCaptionText() {
    const tpl = (dash?.templates || []).find((x) => x.id === igForm.templateId);
    const title = igForm.title.trim() || (tpl && tpl.title) || '';
    const value = String(igForm.value).trim();
    const biz = igForm.businessName.trim() || (dash && (dash.businessName || dash.business_name)) || myData.name || '';
    const handle = igForm.handle.trim().replace(/^@/, '');
    const parts = [title];
    if (value) parts.push(`${value}% OFF`);
    parts.push('Aproveite enquanto dura!');
    return `${parts.join(' — ')}\n\n${biz} ${handle ? `· @${handle.replace(/^@/, '')}` : ''}\n🌊 ${t.tagline}`;
  }

  function downloadIgCard() {
    try { drawIgCard(); } catch (err) { setMsg(t.igGenerateError.replace('{err}', err.message)); return; }
    const a = document.createElement('a');
    a.download = `pyv-card-${igForm.templateId || 'oferta'}.png`;
    a.href = igCanvasRef.current.toDataURL('image/png');
    a.click();
    setMsg(t.igDownloaded);
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

  // ------------------------------------------------------------
  // Relatorio (aba "Relatorio")
  // ------------------------------------------------------------
  // A UI so manda `days`. Quem valida o periodo, resolve a empresa e escolhe
  // entre business_report_v3 e business_report e o handler, a partir do ATOR
  // (nunca do businessId da URL); a resposta traz `source` dizendo qual das
  // duas respondeu. Sem AbortController nesta pagina (mesmo padrao de
  // loadStats/loadShuttles): o carimbo reportBusy e a trava contra clique duplo.
  async function loadReport(s, days) {
    const sess = s || session;
    if (!sess || reportBusy) return;
    setReportBusy(true);
    setReportMsg('');
    setReportBillingMsg('');
    try {
      const res = await fetch(`/.netlify/functions/empresa?mode=report&days=${encodeURIComponent(String(days || 30))}`, {
        headers: { Authorization: `Bearer ${sess.sessionToken}` },
      });
      const data = await res.json();
      if (res.ok) { setReport(data); return; }
      setReportMsg(data.error || (t.reportLoadError ?? 'Erro ao carregar relatório'));
    } catch (e) {
      setReportMsg(t.reportLoadError ?? 'Erro ao carregar relatório');
    } finally {
      setReportBusy(false);
    }
  }

  // A assinatura nao e gerenciada aqui: quem monta e paga o checkout e o
  // endpoint billing. Este botao so pede o status e obedece a URL devolvida
  // (vindo de tres lugares diferentes conforme o caminho que o checkout usou).
  async function openBillingSubscription() {
    const sess = session;
    if (!sess || reportBillingBusy) return;
    setReportBillingBusy(true);
    setReportBillingMsg('');
    try {
      const res = await fetch('/.netlify/functions/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.sessionToken}` },
        body: JSON.stringify({ action: 'status', businessId: sess.businessId }),
      });
      const data = await res.json();
      const url = data?.subscription_url || data?.init_point || data?.data?.subscription_url || data?.data?.init_point;
      if (url) { window.open(url, '_blank'); return; }
      setReportBillingMsg(data?.status || data?.error || (t.reportBillingNoLink ?? 'Sem cobrança ativa para abrir.'));
    } catch (e) {
      setReportBillingMsg(t.reportBillingNoLink ?? 'Não foi possível consultar a assinatura.');
    } finally {
      setReportBillingBusy(false);
    }
  }

  // --- Revisao de cadastro de motorista -------------------------------
  //
  // A listagem vem de driver-list-for-business, que devolve nome, telefone,
  // status e os documentos (id, tipo, status) — sem URL de arquivo. O
  //arquivo em si so aparece em driver-document-url, sob forma de URL assinada
  // de 5 minutos, e por isso `openDocument` busca no clique em vez de a lista
  // trazer o link pronto.

  async function loadDrivers(s) {
    const sess = s || session;
    setDriversBusy(true);
    setDriversMsg('');
    try {
      const res = await fetch('/.netlify/functions/driver-list-for-business', {
        headers: { Authorization: `Bearer ${sess.sessionToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setDriversMsg(t.driversLoadError ?? 'Não foi possível carregar os motoristas.');
        setDrivers([]);
        return;
      }
      setDrivers(data.drivers || []);
      if (!(data.drivers || []).length) {
        setDriversMsg(t.driversEmpty ?? 'Nenhum motorista cadastrado ainda.');
      }
    } catch (e) {
      setDriversMsg(t.driversLoadError ?? 'Não foi possível carregar os motoristas.');
    } finally {
      setDriversBusy(false);
    }
  }

  // Abre o documento numa aba nova. A URL vale por 5 minutos, então clicar de
  // novo é o que renova: não vale guardar em state por causa disso.
  async function openDocument(documentId) {
    setDriversMsg('');
    const sess = session;
    if (!sess?.sessionToken) return;
    try {
      const res = await fetch(
        `/.netlify/functions/driver-document-url?documentId=${encodeURIComponent(documentId)}`,
        { headers: { Authorization: `Bearer ${sess.sessionToken}` } }
      );
      const data = await res.json();
      if (!res.ok) {
        setDriversMsg(
          res.status === 403
            ? (t.driversDocForbidden ?? 'Você não tem permissão para ver este documento.')
            : (t.driversDocError ?? 'Não foi possível abrir o documento.')
        );
        return;
      }
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setDriversMsg(t.driversDocError ?? 'Não foi possível abrir o documento.');
    }
  }

  async function reviewDocument(documentId, action, reason) {
    setDriversMsg('');
    const sess = session;
    if (!sess?.sessionToken) return;
    setDriversBusy(true);
    try {
      const res = await fetch('/.netlify/functions/driver-review-document', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sess.sessionToken}`,
        },
        body: JSON.stringify({ documentId, action, reason: reason || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDriversMsg(
          res.status === 403
            ? (t.driversReviewForbidden ?? 'Você não pode revisar este cadastro.')
            : (t.driversReviewError ?? 'Não foi possível registrar a decisão.')
        );
        return;
      }
      setRejeitando(null);
      setMotivo('');
      // Recarrega em vez de remendar a lista local: a aprovação muda o status
      // do documento E do motorista, e um remendo local erra um dos dois.
      await loadDrivers(sess);
    } catch (e) {
      setDriversMsg(t.driversReviewError ?? 'Não foi possível registrar a decisão.');
    } finally {
      setDriversBusy(false);
    }
  }

  // Redefine o PIN de um cadastro. A empresa escolhe o valor e o repassa ao
  // motorista por fora — o app dele nao tem como trocar o proprio PIN, porque
  // driver-set-pin so funciona com o token do cadastro, que ja morreu.
  // O PIN nunca volta do servidor: a resposta traz so ok/driverId.
  async function resetPin(driverId) {
    setDriversMsg('');
    const sess = session;
    if (!sess?.sessionToken) return;
    const pin = pinNovo.trim();
    if (!/^[0-9]{4,8}$/.test(pin)) {
      setDriversMsg(t.driversResetInvalid ?? 'O novo PIN precisa ter de 4 a 8 dígitos.');
      return;
    }
    setDriversBusy(true);
    try {
      const res = await fetch('/.netlify/functions/driver-reset-pin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sess.sessionToken}`,
        },
        body: JSON.stringify({ driverId, newPin: pin }),
      });
      if (!res.ok) {
        setDriversMsg(
          res.status === 403
            ? (t.driversResetForbidden ?? 'Você não pode redefinir o PIN deste motorista.')
            : (t.driversResetError ?? 'Não foi possível redefinir o PIN.')
        );
        return;
      }
      setResetandoPin(null);
      setPinNovo('');
      setDriversMsg(t.driversResetOk ?? 'PIN redefinido. As sessões abertas desse motorista foram encerradas.');
    } catch (e) {
      setDriversMsg(t.driversResetError ?? 'Não foi possível redefinir o PIN.');
    } finally {
      setDriversBusy(false);
    }
  }

  // --- Fila de reservas de translado ---------------------------------------
  // GET mode=reservations devolve { reservations, count }; a lista carrega
  // telefone de contato e observacao, entao a resposta e no-store. `status` e
  // um filtro de tela opcional repassado a RPC como p_status.
  async function loadReservations(s, status) {
    const sess = s || session;
    setReservationsBusy(true);
    setReservationsMsg('');
    try {
      const q = status ? `&status=${encodeURIComponent(status)}` : '';
      const res = await fetch(`/.netlify/functions/empresa?mode=reservations${q}`, {
        headers: { Authorization: `Bearer ${sess.sessionToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setReservationsMsg(
          res.status === 403
            ? (t.reservationsForbidden ?? 'Você não pode ver esta fila.')
            : (t.reservationsLoadError ?? 'Não foi possível carregar as reservas.')
        );
        setReservations([]);
        return;
      }
      setReservations(data.reservations || []);
      if (!(data.reservations || []).length) {
        setReservationsMsg(t.reservationsEmpty ?? 'Nenhuma reserva ainda.');
      }
    } catch (e) {
      setReservationsMsg(t.reservationsLoadError ?? 'Não foi possível carregar as reservas.');
    } finally {
      setReservationsBusy(false);
    }
  }

  // Decisao da empresa. action = confirm | reject | cancel; o handler valida
  // antes da RPC e mapeia RESERVATION_NOT_FOUND -> 404 e
  // INVALID_STATUS_TRANSITION -> 409.
  async function reviewReservation(reservationId, decision, reason) {
    const sess = session;
    if (!sess?.sessionToken) return;
    setReservationsBusy(true);
    setReservationsMsg('');
    try {
      const res = await fetch('/.netlify/functions/empresa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sess.sessionToken}` },
        body: JSON.stringify({ action: 'review_reservation', reservationId, decision, reason: reason || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setReservationsMsg(
          res.status === 409
            ? (t.reservationsConflict ?? 'A reserva já foi decidida ou o status não permite essa mudança.')
            : res.status === 404
              ? (t.reservationsNotFound ?? 'Reserva não encontrada.')
              : res.status === 403
                ? (t.reservationsForbidden ?? 'Você não pode revisar esta reserva.')
                : (data?.error === 'ACTION_INVALID'
                    ? (t.reservationsActionInvalid ?? 'Ação inválida.')
                    : (t.reservationsReviewError ?? 'Não foi possível registrar a decisão.'))
        );
        return;
      }
      setRevisandoReserva(null);
      setReservaMotivo('');
      await loadReservations(sess);
    } catch (e) {
      setReservationsMsg(t.reservationsReviewError ?? 'Não foi possível registrar a decisão.');
    } finally {
      setReservationsBusy(false);
    }
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
            </>
          ) : (
            <div style={card}>
              <h3>{t.authRegisterTitle}</h3>
              <p style={{ fontSize: 13 }}>{t.authRegisterSub}</p>
              <input style={input} placeholder={t.businessName} value={regForm.name} onChange={(e) => setRegForm({ ...regForm, name: e.target.value })} />
              <select style={input} value={regForm.category} onChange={(e) => setRegForm({ ...regForm, category: e.target.value })}>
                {CATEGORY_OPTIONS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
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
              <button style={btn} onClick={registerBusiness}>{t.authRegisterButton}</button>
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
            <button style={tab === 'ig' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => setTab('ig')}>{t.igTab ?? '📣 Instagram'}</button>
            <button style={tab === 'translado' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => { setTab('translado'); loadShuttles(); }}>{t.tabShuttles ?? '🚐 Translado'}</button>
            <button style={tab === 'motoristas' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => { setTab('motoristas'); loadDrivers(); }}>{t.tabDrivers ?? 'Motoristas'}</button>
            <button style={tab === 'reservas' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => { setTab('reservas'); loadReservations(session); }}>{t.tabReservas ?? '📅 Reservas'}</button>
            <button style={tab === 'relatorio' ? btn : { ...btn, background: theme.border, color: theme.text }} onClick={() => { setTab('relatorio'); loadReport(session, reportDays); }}>{t.reportTab ?? '📈 Relatório'}</button>
          </div>

          {tab === 'motoristas' && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.driversTitle ?? 'Cadastro de motoristas'}</h3>
            <p style={{ fontSize: 13, opacity: 0.75, marginTop: 0 }}>
              {t.driversHint ?? 'Confira o documento e aprove o cadastro. O arquivo abre numa aba nova e o link expira em 5 minutos.'}
            </p>

            {driversMsg && <p style={{ fontSize: 13, color: '#c0392b', fontWeight: 600 }}>{driversMsg}</p>}
            {driversBusy && <p style={{ fontSize: 13, opacity: 0.7 }}>{t.loading ?? 'Carregando...'}</p>}

            {!driversBusy && drivers.map((d) => (
              <div key={d.driverId} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12, marginTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{d.name}</strong>
                  <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: d.status === 'approved' ? theme.greenLight : '#fdf3d0', color: d.status === 'approved' ? theme.greenDark : '#8a6d1f' }}>
                    {d.status === 'approved' ? (t.driverApproved ?? 'aprovado') : d.status === 'pending' ? (t.driverPending ?? 'pendente') : d.status}
                  </span>
                </div>
                <p style={{ fontSize: 13, opacity: 0.75, margin: '4px 0' }}>{d.phone}</p>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                  <button
                    style={{ ...smallBtn, background: theme.border, color: theme.text }}
                    disabled={driversBusy}
                    onClick={() => { setResetandoPin(resetandoPin === d.driverId ? null : d.driverId); setPinNovo(''); }}
                  >
                    {t.driversResetPin ?? 'Redefinir PIN'}
                  </button>

                  {resetandoPin === d.driverId && (
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <input
                        style={input}
                        type="password"
                        inputMode="numeric"
                        placeholder={t.driversResetPinNew ?? 'Novo PIN (4 a 8 dígitos)'}
                        value={pinNovo}
                        onChange={(e) => setPinNovo(e.target.value.replace(/\D/g, ''))}
                      />
                      <button
                        style={smallBtn}
                        disabled={driversBusy}
                        onClick={() => resetPin(d.driverId)}
                      >
                        {t.driversResetPinConfirm ?? 'Salvar novo PIN'}
                      </button>
                    </span>
                  )}
                </div>

                {d.documents.map((doc) => (
                  <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                    <span style={{ fontSize: 13 }}>
                      {(doc.docType === 'cnh' ? 'CNH' : doc.docType === 'rg' ? 'RG' : 'CRV')} · {doc.status}
                    </span>
                    <button style={smallBtn} onClick={() => openDocument(doc.id)}>{t.viewDocument ?? 'Ver documento'}</button>

                    {doc.status === 'pending' && d.status === 'pending' && (
                      <>
                        <button
                          style={smallBtn}
                          disabled={driversBusy}
                          onClick={() => reviewDocument(doc.id, 'approve')}
                        >
                          {t.approveDriver ?? 'Aprovar'}
                        </button>
                        <button
                          style={{ ...smallBtn, background: theme.border, color: theme.text }}
                          disabled={driversBusy}
                          onClick={() => { setRejeitando(rejeitando === doc.id ? null : doc.id); setMotivo(''); }}
                        >
                          {t.rejectDriver ?? 'Reprovar'}
                        </button>
                      </>
                    )}

                    {rejeitando === doc.id && (
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <input
                          style={input}
                          placeholder={t.rejectReason ?? 'Motivo (opcional)'}
                          value={motivo}
                          onChange={(e) => setMotivo(e.target.value)}
                        />
                        <button
                          style={{ ...smallBtn, background: '#c0392b', color: '#fff' }}
                          disabled={driversBusy}
                          onClick={() => reviewDocument(doc.id, 'reject', motivo)}
                        >
                          {t.confirmReject ?? 'Confirmar reprovação'}
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
          )}

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
                  {tpl.featured_until && (
                    <span style={{ fontSize: 11, fontWeight: 700, background: theme.goldLight, color: theme.greenDark, padding: '2px 8px', borderRadius: 999 }}>
                      ⭐ {t.featured} até {new Date(tpl.featured_until).toLocaleDateString()}
                    </span>
                  )}
                  <select
                    style={{ ...input, padding: '4px 6px', fontSize: 12, marginBottom: 0 }}
                    value={featuredSel[tpl.id] ?? '7'}
                    onChange={(e) => setFeaturedSel({ ...featuredSel, [tpl.id]: e.target.value })}
                  >
                    <option value="1">1 dia</option><option value="3">3 dias</option><option value="7">7 dias</option><option value="30">30 dias</option>
                  </select>
                  <button style={smallBtn} onClick={() => setCouponFeatured(tpl, Number(featuredSel[tpl.id] ?? 7))}>⭐ {t.featured}</button>
                  {!!tpl.featured_until && <button style={{ ...smallBtn, background: theme.border, color: theme.text }} onClick={() => setCouponFeatured(tpl, 0)}>✕</button>}
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
            <select
              style={input}
              value={myData.category}
              onChange={(e) => setMyData({ ...myData, category: e.target.value })}
            >
              <option value="">{t.allActivities}</option>
              {CATEGORY_OPTIONS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
            </select>
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

          {tab === 'ig' && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.igTab ?? '📣 Instagram'}</h3>
            <p style={{ fontSize: 13, marginTop: 0 }}>
              {t.igHint ?? 'Gere o card 1080×1080 de uma oferta, baixe o PNG e publique no Instagram. O card usa só texto (sem foto), para o download nunca falhar por bloqueio de imagem.'}
            </p>
            <select
              style={input}
              value={igForm.templateId}
              onChange={(e) => pickTemplate(e.target.value)}
            >
              <option value="">{t.igSelectOffer ?? 'Selecione a oferta'}</option>
              {(dash?.templates || []).map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.title}</option>)}
            </select>
            <input style={input} placeholder={t.igTitle ?? 'título do card'} value={igForm.title} onChange={(e) => setIgForm({ ...igForm, title: e.target.value })} />
            <input style={input} placeholder={t.igValue ?? 'valor (%)'} value={igForm.value} onChange={(e) => setIgForm({ ...igForm, value: e.target.value })} />
            <input style={input} placeholder={t.igBusiness ?? 'nome da empresa'} value={igForm.businessName} onChange={(e) => setIgForm({ ...igForm, businessName: e.target.value })} />
            <input style={input} placeholder={t.igHandle ?? '@seu_instagram'} value={igForm.handle} onChange={(e) => setIgForm({ ...igForm, handle: e.target.value })} />
            <br />
            <canvas
              ref={igCanvasRef}
              onClick={() => { try { drawIgCard(); } catch (err) { setMsg(t.igGenerateError.replace('{err}', err.message)); } }}
              style={{ width: '100%', maxWidth: 360, height: 360, borderRadius: 12, border: `1px solid ${theme.border}`, background: '#0B6E4F', cursor: 'pointer' }}
            />
            <p style={{ fontSize: 11, color: theme.textMuted }}>{t.igPreviewHint ?? 'Prévia (clique para atualizar). O arquivo baixado tem 1080×1080.'}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button style={btn} onClick={downloadIgCard}>{t.igDownload ?? '⬇️ Baixar PNG 1080×1080'}</button>
              <button style={{ ...btn, background: '#E4405F', color: '#fff' }} onClick={() => window.open('https://www.instagram.com/', '_blank')}>
                {t.igOpenInstagram ?? '📸 Abrir Instagram'}
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              <strong style={{ fontSize: 13 }}>{t.igCaption ?? 'Legenda sugerida (toque para copiar):'}</strong>
              <pre
                onClick={() => { navigator.clipboard?.writeText(igCaptionText()); setMsg(t.igCaptionCopied); }}
                style={{
                  whiteSpace: 'pre-wrap', fontSize: 13, background: theme.bg, border: `1px solid ${theme.border}`,
                  borderRadius: 8, padding: 10, cursor: 'pointer', margin: '6px 0 0',
                }}
              >{igCaptionText()}</pre>
            </div>
          </div>
          )}

          {tab === 'translado' && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.shuttlesTitle ?? '🚐 Serviços de translado'}</h3>
            <p style={{ fontSize: 13, opacity: 0.75, marginTop: 0 }}>
              {t.shuttlesHint ?? 'Cadastre o translado do seu negócio. Ele aparece para o cliente no mapa de "Translado e proximidade"; o motorista aprovado reporta a posição do veículo.'}
            </p>

            {shuttleMsg && <p style={{ fontSize: 13, color: '#c0392b', fontWeight: 600 }}>{shuttleMsg}</p>}
            {shuttleBusy && <p style={{ fontSize: 13, opacity: 0.7 }}>{t.loading ?? 'Carregando...'}</p>}

            <button style={btn} onClick={newShuttle}>{t.shuttleNew ?? '➕ Novo serviço'}</button>

            {editingShuttle && (
              <div style={{ marginTop: 12, padding: 12, background: theme.bg, borderRadius: 8, border: `1px solid ${theme.border}` }}>
                <input style={input} placeholder={t.shuttleName ?? 'Nome do serviço'} value={shuttleForm.name} onChange={(e) => setShuttleForm({ ...shuttleForm, name: e.target.value })} />
                <input style={input} placeholder={t.shuttleDescription ?? 'Descrição (opcional)'} value={shuttleForm.description} onChange={(e) => setShuttleForm({ ...shuttleForm, description: e.target.value })} />
                <select style={input} value={shuttleForm.serviceType} onChange={(e) => setShuttleForm({ ...shuttleForm, serviceType: e.target.value })}>
                  <option value="shuttle">{t.shuttleTypeShuttle ?? 'Translado compartilhado'}</option>
                  <option value="transfer">{t.shuttleTypeTransfer ?? 'Privativo'}</option>
                  <option value="tour">{t.shuttleTypeTour ?? 'Tour'}</option>
                </select>
                <input style={input} placeholder={t.shuttlePrice ?? 'Preço em reais (ex.: 25)'} value={shuttleForm.priceCents} onChange={(e) => setShuttleForm({ ...shuttleForm, priceCents: e.target.value })} />
                <br />
                <input style={input} placeholder={t.latField} value={shuttleForm.originLat} onChange={(e) => setShuttleForm({ ...shuttleForm, originLat: e.target.value })} />
                <input style={input} placeholder={t.lngField} value={shuttleForm.originLng} onChange={(e) => setShuttleForm({ ...shuttleForm, originLng: e.target.value })} />
                <span style={{ fontSize: 12, opacity: 0.75 }}>{t.shuttleOrigin ?? 'Origem'}</span>
                <button style={smallBtn} onClick={useShuttleOrigin}>{t.useMyLocation}</button>
                <br />
                <input style={input} placeholder={t.latField} value={shuttleForm.destLat} onChange={(e) => setShuttleForm({ ...shuttleForm, destLat: e.target.value })} />
                <input style={input} placeholder={t.lngField} value={shuttleForm.destLng} onChange={(e) => setShuttleForm({ ...shuttleForm, destLng: e.target.value })} />
                <span style={{ fontSize: 12, opacity: 0.75 }}>{t.shuttleDest ?? 'Destino'}</span>
                <br />
                <input style={input} placeholder={t.shuttleOpens ?? 'Abre (ex.: 08:00)'} value={shuttleForm.opensAt} onChange={(e) => setShuttleForm({ ...shuttleForm, opensAt: e.target.value })} />
                <input style={input} placeholder={t.shuttleCloses ?? 'Fecha (ex.: 22:00)'} value={shuttleForm.closesAt} onChange={(e) => setShuttleForm({ ...shuttleForm, closesAt: e.target.value })} />
                <input style={input} placeholder={t.shuttleDays ?? 'Dias 0-6 separados por vírgula (0=domingo)'} value={shuttleForm.activeDays} onChange={(e) => setShuttleForm({ ...shuttleForm, activeDays: e.target.value })} />
                <br />
                <textarea
                  style={{ ...input, display: 'block', width: '100%', minHeight: 56, fontFamily: 'inherit' }}
                  placeholder={t.shuttleStops ?? 'Paradas (opcional), uma por linha: Rótulo|lat|lng'}
                  value={shuttleForm.stopsText}
                  onChange={(e) => setShuttleForm({ ...shuttleForm, stopsText: e.target.value })}
                />
                <br />
                <button style={{ ...btn, marginTop: 8 }} onClick={saveShuttle}>{t.saveShuttle ?? 'Salvar serviço'}</button>
                <button style={{ ...smallBtn, background: theme.border, color: theme.text }} onClick={cancelEditShuttle}>{t.cancel}</button>
              </div>
            )}

            {!shuttleBusy && shuttles.map((s) => (
              <div key={s.shuttleId} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12, marginTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{s.name}</strong>
                  <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: s.isActive === false ? '#fdf3d0' : theme.greenLight, color: s.isActive === false ? '#8a6d1f' : theme.greenDark }}>
                    {s.isActive === false ? (t.disabledLabel ?? 'inativo') : (t.active ?? 'ativo')}
                  </span>
                  <span style={{ fontSize: 12, opacity: 0.75 }}>
                    {s.serviceType} · R$ {s.priceCents != null ? (s.priceCents / 100).toFixed(2) : (t.toCombine ?? 'a combinar')}
                    {(s.opensAt || s.closesAt) ? ` · ${s.opensAt || '?'}–${s.closesAt || '?'}` : ''}
                  </span>
                </div>
                {s.description && <p style={{ fontSize: 13, opacity: 0.75, margin: '4px 0' }}>{s.description}</p>}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button style={{ ...smallBtn, background: s.isActive === false ? '#0B6E4F' : '#c0392b', color: '#fff' }} onClick={() => toggleShuttle(s)}>
                    {s.isActive === false ? (t.active ?? 'Ativar') : (t.deactivate ?? 'Desativar')}
                  </button>
                  <button style={smallBtn} onClick={() => startEditShuttle(s)}>{t.edit ?? 'Editar'}</button>
                  <button style={{ ...smallBtn, background: '#c0392b', color: '#fff' }} onClick={() => deleteShuttle(s)}>🗑️ {t.delete ?? 'Apagar'}</button>
                </div>
              </div>
            ))}
          </div>
          )}

          {/* ------------------------------------------------------------
              Relatorio - painel proprio, inserido depois do bloco de
              translado e antes do fim da pagina. Nao mistura variavel com os
              blocos acima: o agente da aba Reservas pode acrescentar o painel
              dele ao lado deste sem reverter nada daqui.
              ------------------------------------------------------------ */}
          {tab === 'relatorio' && (
          <>
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportTitle ?? '📈 Relatório'}</h3>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  style={reportDays === d ? btn : { ...btn, background: theme.border, color: theme.text }}
                  onClick={() => { setReportDays(d); loadReport(session, d); }}
                >
                  {d} {t.reportDays ?? 'dias'}
                </button>
              ))}
            </div>
            {reportBusy && <p style={{ fontSize: 13 }}>{t.loading ?? 'Carregando...'}</p>}
            {reportMsg && <p style={{ fontSize: 13, color: '#c0392b' }}>{reportMsg}</p>}
          </div>

          {report && (
          <>
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportTotals ?? 'Totais do período'}</h3>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {[
                [t.reportIssued ?? 'Emitidos', report.totals?.issued],
                [t.reportValidated ?? 'Validados', report.totals?.validated],
                [t.reportConversion ?? 'Conversão', report.totals?.conversionPct != null ? `${report.totals.conversionPct}%` : '—'],
                [t.reportNewCustomers ?? 'Novos clientes', report.totals?.newCustomers],
              ].map(([label, value]) => (
                <div key={label} style={{ flex: '1 1 120px', background: theme.greenLight, borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700 }}>{value ?? 0}</div>
                </div>
              ))}
            </div>
            {report.totals?.totalCustomers != null && (
              <p style={{ fontSize: 13, opacity: 0.75, margin: '10px 0 0' }}>
                {t.reportTotalCustomers ?? 'Clientes acumulados:'} {report.totals.totalCustomers}
                {report.totals.returningCustomers != null ? ` · ${t.reportReturning ?? 'recorrentes:'} ${report.totals.returningCustomers}` : ''}
              </p>
            )}
          </div>

          {Array.isArray(report.daily) && report.daily.length > 0 && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportDaily ?? 'Resgates por dia'}</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 6 }}>{t.reportDay ?? 'Dia'}</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>{t.reportIssued ?? 'Emitidos'}</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>{t.reportValidated ?? 'Validados'}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.daily.map((d) => (
                    <tr key={d.day} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ padding: 6 }}>{d.day}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{d.issued}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{d.validated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )}

          {report.byCampaign?.length > 0 && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportByCampaign ?? 'Por campanha'}</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 6 }}>{t.reportCampaign ?? 'Campanha'}</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>{t.reportIssued ?? 'Emitidos'}</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>{t.reportValidated ?? 'Validados'}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byCampaign.map((c) => (
                    <tr key={c.campaignId || c.title} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ padding: 6 }}>{c.title}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{c.issued}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{c.validated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )}

          {report.byTemplate?.length > 0 && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportByTemplate ?? 'Por cupom'}</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: 6 }}>{t.reportTemplate ?? 'Cupom'}</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>{t.reportIssued ?? 'Emitidos'}</th>
                    <th style={{ textAlign: 'right', padding: 6 }}>{t.reportValidated ?? 'Validados'}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byTemplate.map((c) => (
                    <tr key={c.templateId || c.title} style={{ borderTop: `1px solid ${theme.border}` }}>
                      <td style={{ padding: 6 }}>{c.title}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{c.issued}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{c.validated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )}

          {report.drivers && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportDrivers ?? '🚗 Motoristas'}</h3>
            <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportDriversTotal ?? 'Total:'} <strong>{report.drivers.total ?? 0}</strong></p>
            <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportDriversApproved ?? 'Aprovados:'} <strong>{report.drivers.approved ?? 0}</strong></p>
            <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportDriversPending ?? 'Pendentes:'} <strong>{report.drivers.pending ?? 0}</strong></p>
            {report.drivers.documentsPending != null && (
              <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportDriversDocs ?? 'Documentos pendentes:'} <strong>{report.drivers.documentsPending}</strong></p>
            )}
            <p style={{ fontSize: 12, opacity: 0.75, margin: '8px 0 0' }}>{t.reportDriversHint ?? 'Mesmo escopo da aba Motoristas: seus motoristas e os independentes.'}</p>
          </div>
          )}

          {report.billing && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportBilling ?? '💳 Assinatura'}</h3>
            <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportPlan ?? 'Plano:'} <strong>{report.billing.plan ?? '—'}</strong></p>
            <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportBillingStatus ?? 'Status:'} <strong>{report.billing.status ?? '—'}</strong></p>
            <p style={{ fontSize: 13, margin: '6px 0' }}>
              {t.reportMonthlyFee ?? 'Mensalidade:'} <strong>{report.billing.monthlyFeeCents != null ? `R$ ${(report.billing.monthlyFeeCents / 100).toFixed(2)}` : '—'}</strong>
            </p>
            <p style={{ fontSize: 13, margin: '6px 0' }}>
              {t.reportFeePerCoupon ?? 'Taxa por resgate:'} <strong>{report.billing.feePerCouponCents != null ? `R$ ${(report.billing.feePerCouponCents / 100).toFixed(2)}` : '—'}</strong>
            </p>
            <p style={{ fontSize: 13, margin: '6px 0' }}>
              {t.reportCharged ?? 'Cobrado no período:'} <strong>{report.billing.chargedCents != null ? `R$ ${(report.billing.chargedCents / 100).toFixed(2)}` : '—'}</strong>
            </p>
            <p style={{ fontSize: 12, opacity: 0.75, margin: '10px 0' }}>{t.reportChargedHint ?? 'Valor cobrado pela plataforma, não o desconto dado ao cliente.'}</p>
            {reportBillingMsg && <p style={{ fontSize: 13, color: '#c0392b' }}>{reportBillingMsg}</p>}
            <button style={smallBtn} onClick={openBillingSubscription} disabled={reportBillingBusy}>
              {reportBillingBusy ? (t.loading ?? 'Carregando...') : (t.reportBillingButton ?? 'Ver/retomar assinatura')}
            </button>
          </div>
          )}

          {report.shuttle && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportShuttle ?? '🚐 Translado'}</h3>
            <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportShuttleServices ?? 'Serviços:'} <strong>{report.shuttle.services ?? 0}</strong></p>
            <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportShuttleActive ?? 'Ativos:'} <strong>{report.shuttle.activeServices ?? 0}</strong></p>
            <p style={{ fontSize: 13, margin: '6px 0' }}>{t.reportShuttleReporting ?? 'Veículos reportando posição:'} <strong>{report.shuttle.vehiclesReporting ?? 0}</strong></p>
          </div>
          )}

          {report.rides === null && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reportRides ?? '🚕 Corridas'}</h3>
            <p style={{ fontSize: 13, opacity: 0.75, margin: 0 }}>{t.reportRidesEmpty ?? 'Ainda não há dados de corridas para o período.'}</p>
          </div>
          )}

{report.source === 'business_report' && (
            <p style={{ fontSize: 12, opacity: 0.6, margin: 0 }}>
              {t.reportFallbackNotice ?? 'Exibindo dados consolidados do relatório (motoristas, assinatura e translado entram na próxima versão).'}
            </p>
            )}
          </>
          )}
          </>
          )}

          {tab === 'reservas' && (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>{t.reservationsTitle ?? '📅 Reservas de translado'}</h3>
            <p style={{ fontSize: 13, opacity: 0.75, marginTop: 0 }}>
              {t.reservationsHint ?? 'A empresa decide cada reserva. Confirmar, recusar e cancelar exigem uma transição de status válida no banco.'}
            </p>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {['', 'pending', 'confirmed', 'rejected', 'cancelled', 'completed'].map((f) => (
                <button
                  key={f}
                  style={reservaFiltro === f ? btn : { ...btn, background: theme.border, color: theme.text }}
                  onClick={() => { setReservaFiltro(f); loadReservations(session, f || undefined); }}
                >
                  {f ? f : (t.reservationsAll ?? 'Todas')}
                </button>
              ))}
            </div>

            {reservationsMsg && <p style={{ fontSize: 13, color: '#c0392b', fontWeight: 600 }}>{reservationsMsg}</p>}
            {reservationsBusy && <p style={{ fontSize: 13, opacity: 0.7 }}>{t.loading ?? 'Carregando...'}</p>}

            {!reservationsBusy && reservations.map((r) => (
              <div key={r.reservationId} style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12, marginTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{r.serviceName}</strong>
                  <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, background: r.status === 'confirmed' || r.status === 'completed' ? theme.greenLight : r.status === 'pending' ? '#fdf3d0' : theme.border, color: r.status === 'confirmed' || r.status === 'completed' ? theme.greenDark : '#8a6d1f' }}>
                    {r.status}
                  </span>
                </div>
                <p style={{ fontSize: 13, opacity: 0.75, margin: '4px 0' }}>
                  {new Date(r.scheduledFor).toLocaleString()} · {r.passengers} {r.passengers === 1 ? (t.reservationsPax ?? 'pax') : (t.reservationsPaxs ?? 'pax')}
                  {r.priceCents != null ? ` · R$ ${(r.priceCents / 100).toFixed(2)}` : ''}
                </p>
                {r.businessName && <p style={{ fontSize: 12, opacity: 0.6, margin: '2px 0' }}>{r.businessName}{r.businessPhone ? ` · ${r.businessPhone}` : ''}</p>}
                {r.contactPhone && <p style={{ fontSize: 13, margin: '2px 0' }}>📞 {r.contactPhone}</p>}
                {r.notes && <p style={{ fontSize: 13, opacity: 0.75, margin: '2px 0' }}>{r.notes}</p>}
                {r.reason && <p style={{ fontSize: 12, opacity: 0.6, margin: '2px 0' }}>{t.reservationsReason ?? 'Motivo:'} {r.reason}</p>}

                {(r.status === 'pending' || r.status === 'confirmed') && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {r.status === 'pending' && (
                      <button style={{ ...smallBtn, background: '#0B6E4F', color: '#fff' }} disabled={reservationsBusy} onClick={() => reviewReservation(r.reservationId, 'confirm')}>
                        {t.reservationsConfirm ?? 'Confirmar'}
                      </button>
                    )}
                    {r.status === 'pending' && (
                      <button style={{ ...smallBtn, background: theme.border, color: theme.text }} disabled={reservationsBusy} onClick={() => { setRevisandoReserva(revisandoReserva === r.reservationId ? null : r.reservationId); setReservaMotivo(''); }}>
                        {t.reservationsReject ?? 'Recusar'}
                      </button>
                    )}
                    {r.status === 'confirmed' && (
                      <button style={{ ...smallBtn, background: '#c0392b', color: '#fff' }} disabled={reservationsBusy} onClick={() => reviewReservation(r.reservationId, 'cancel')}>
                        {t.reservationsCancel ?? 'Cancelar'}
                      </button>
                    )}
                    {(r.status === 'pending' && revisandoReserva === r.reservationId) && (
                      <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <input style={input} placeholder={t.reservationsReasonPlaceholder ?? 'Motivo (opcional)'} value={reservaMotivo} onChange={(e) => setReservaMotivo(e.target.value)} />
                        <button style={{ ...smallBtn, background: '#c0392b', color: '#fff' }} disabled={reservationsBusy} onClick={() => reviewReservation(r.reservationId, 'reject', reservaMotivo)}>
                          {t.reservationsConfirmReject ?? 'Confirmar recusa'}
                        </button>
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          )}
        </>
      )}

      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
      </div>
    </main>
  );
}
