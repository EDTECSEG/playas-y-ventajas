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

function shuttleTypeLabel(type, t) {
  const labels = {
    shuttle: t.shuttleTypeShuttle ?? 'Translado compartilhado',
    transfer: t.shuttleTypeTransfer ?? 'Privativo',
    tour: t.shuttleTypeTour ?? 'Tour',
  };
  return labels[type] || type || (t.shuttleTypeShuttle ?? 'Translado');
}

// --- Agendamento de translado (helpers puros, no mesmo estilo de shuttleTypeLabel)

// 0=domingo, igual ao active_days de shuttle_services.
function dayOfWeekIso(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
}

function minutesOf(hhmm) {
  const parts = String(hhmm || '').split(':').map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return parts[0] * 60 + parts[1];
}

// Slots de 30 min dentro de opens_at..closes_at, filtrados por active_days.
// Sem janela ou sem dia escolhido a lista e vazia — o painel mostra o motivo em
// vez de oferecer horario que o banco vai recusar com OUTSIDE_HOURS.
// nowMinutes existe para poder filtrar o dia de hoje; null = nao filtra.
function bookingSlots(service, dateStr, nowMinutes) {
  if (!service || !dateStr) return [];
  const days = Array.isArray(service.activeDays) ? service.activeDays : [];
  const dow = dayOfWeekIso(dateStr);
  if (dow === null) return [];
  if (days.length > 0 && !days.map(Number).includes(dow)) return [];

  const opens = minutesOf(service.opensAt);
  const closes = minutesOf(service.closesAt);
  if (opens === null || closes === null || closes < opens) return [];

  const out = [];
  for (let m = opens; m <= closes; m += 30) {
    if (nowMinutes !== null && nowMinutes !== undefined && m <= nowMinutes) continue;
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowMinutesLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function formatPrice(cents) {
  return cents === null || cents === undefined ? null : `R$ ${(Number(cents) / 100).toFixed(2)}`;
}

function formatWhen(iso, lang) {
  if (!iso) return '';
  const bcp = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' }[lang] || 'pt-BR';
  try {
    return new Date(iso).toLocaleString(bcp, { dateStyle: 'short', timeStyle: 'short' });
  } catch (e) {
    return String(iso);
  }
}

function reservationStatusLabel(status, t) {
  const map = {
    pending: t.resStatusPending,
    confirmed: t.resStatusConfirmed,
    cancelled: t.resStatusCancelled,
    rejected: t.resStatusRejected,
    completed: t.resStatusCompleted,
  };
  return map[status] || status;
}

// Link de WhatsApp no mesmo formato de netlify/functions/_wa.js (wa.me, sem API,
// sem custo). O telefone vem SEMPRE da RPC (businessPhone), nunca digitado
// aqui. A funcao do servidor continua sendo a copia canonica para os handlers;
// o cliente nao importa arquivo de netlify/functions, que e CommonJS de
// plataforma e nao pertence ao bundle do browser.
function buildWaLink({ phone, message, fallbackMessage }) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits) {
    while (digits.length > 2 && digits.charAt(0) === '0') digits = digits.slice(1);
    if (!(digits.indexOf('55') === 0 && digits.length >= 12)) {
      digits = digits.length <= 11 ? `55${digits}` : digits;
    }
  }
  const text = message || fallbackMessage || 'Olá!';
  if (!digits) return `https://wa.me/?text=${encodeURIComponent(text)}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// Codigo de regra do endpoint -> frase util. O handler devolve so o codigo
// (nunca o detail do Postgres), entao quem traduz para o cliente e a tela.
function reservationErrorMessage(code, t) {
  const map = {
    CUSTOMER_TOKEN_INVALID: t?.reserveSessionExpired ?? 'Sua identificação expirou. Identifique-se novamente.',
    RESERVATION_NOT_FOUND: t?.reserveNotFound ?? 'Reserva não encontrada.',
    SLOT_CONFLICT: t?.reserveSlotTaken ?? 'Esse horário acabou de ser reservado. Escolha outro.',
    OUTSIDE_HOURS: t?.reserveOutsideHours ?? 'Esse horário está fora do período de atendimento.',
    DAY_NOT_ACTIVE: t?.reserveDayInactive ?? 'Esse dia não está disponível para este serviço.',
    INVALID_PASSENGERS: t?.reserveBadPassengers ?? 'Número de passageiros inválido (de 1 a 20).',
    INVALID_SCHEDULE: t?.reservePastDate ?? 'Escolha uma data futura.',
    SHUTTLE_NOT_FOUND: t?.reserveServiceGone ?? 'Este serviço não está mais disponível.',
    INVALID_STATUS_TRANSITION: t?.reserveNotCancellable ?? 'Esta reserva não pode mais ser cancelada.',
  };
  return map[code] || (t?.reserveGeneric ?? 'Não foi possível concluir a reserva. Tente de novo.');
}

// Texto da conversa de WhatsApp: mesmo formato do buildCouponMessage de
// _wa.js, com o contexto que a RPC devolveu.
function reservationWaMessage(res) {
  const linhas = ['Olá! Acabei de fazer uma reserva de translado pelo Playas y Ventajas.'];
  if (res.serviceName) linhas.push('*Serviço:* ' + res.serviceName);
  if (res.businessName) linhas.push('*Estabelecimento:* ' + res.businessName);
  if (res.scheduledFor) linhas.push('*Data/hora:* ' + formatWhen(res.scheduledFor));
  if (res.passengers) linhas.push('*Passageiros:* ' + res.passengers);
  linhas.push('');
  linhas.push('Podem confirmar?');
  return linhas.join('\n');
}

function timeAgo(iso, t) {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return t.timeAgoNow ?? 'agora';
  const mins = Math.round(secs / 60);
  if (mins < 60) return (t.timeAgoMin ?? 'há {n} min').replace('{n}', mins);
  return (t.timeAgoHour ?? 'há {n} h').replace('{n}', Math.round(mins / 60));
}

export default function ClientePage() {
  const { lang, t } = useLanguage();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [instagram, setInstagram] = useState('');
  const [email, setEmail] = useState('');
  const [customerId, setCustomerId] = useState(null);
  // O customerToken (HMAC do customerId) e o que o endpoint exige. A pagina so
  // guardava o customerId em state, o que bastava para o card de ofertas, mas
  // nao para reservar: sem o par, o POST volta 401 CUSTOMER_TOKEN_INVALID.
  const [customerToken, setCustomerToken] = useState(null);
  const [offers, setOffers] = useState([]);
  // Separado de msg de proposito: msg e feedback de acao (cupom resgatado,
  // cadastro feito) e e sobrescrita o tempo todo. Aqui o que importa e nao
  // mentir: "nao ha ofertas" e "nao consegui buscar as ofertas" sao coisas
  // diferentes, e mostrar a primeira quando o servidor esta quebrado faz o
  // consumidor achar que a loja sumiu.
  const [offersErro, setOffersErro] = useState('');
  const [cities, setCities] = useState([]);
  const [categories, setCategories] = useState([]);
  const [filter, setFilter] = useState({ city: '', category: '', radiusKm: 16, byDistance: false, lat: null, lng: null });
  const [geoStatus, setGeoStatus] = useState('idle');
  const [filterMsg, setFilterMsg] = useState('');
  // loadOffers le filter deste ref, nao do state: setFilter e async e o handler
  // alem de setar ainda recarrega na mesma funcao, entao ler o state logo apos
  // setar veria o valor antigo (filtro aplicado "um clique atras", ou none).
  const filterRef = useRef(filter);
  const [myCoupons, setMyCoupons] = useState([]);
  const [couponFilter, setCouponFilter] = useState('available');
  const [justClaimed, setJustClaimed] = useState(null);
  const [msg, setMsg] = useState('');
  const [mapStatus, setMapStatus] = useState('idle');
  const [invite, setInvite] = useState(null);
  const [inviteMsg, setInviteMsg] = useState('');
  // Agendamento: lista, erro separado (mesmo motivo de offersErro — "nao ha
  // reservas" e "nao consegui buscar" sao coisas diferentes) e o painel inline.
  const [reservations, setReservations] = useState([]);
  const [reservationsErro, setReservationsErro] = useState('');
  const [resFilter, setResFilter] = useState('active');
  const [book, setBook] = useState(null);
  const [bookMsg, setBookMsg] = useState('');
  const [bookErro, setBookErro] = useState('');
  const [bookBusy, setBookBusy] = useState(false);
  const [justBooked, setJustBooked] = useState(null);

  const mapRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const qrDivRef = useRef(null);
  const myCouponQrDivRef = useRef(null);
  const [openCoupon, setOpenCoupon] = useState(null);
  const [shuttle, setShuttle] = useState({ status: 'idle', lat: null, lng: null, services: [], vehicles: [], err: '' });

  useEffect(() => {
    // Guarda o ?ref= do link de afiliado antes de qualquer fluxo de resgate.
    try {
      const ref = new URLSearchParams(window.location.search).get('ref');
      if (ref && /^[A-Za-z0-9-]{1,32}$/.test(ref)) localStorage.setItem('pyv_ref', ref);
    } catch (e) { /* segui sem referido */ }

    const saved = localStorage.getItem('pyv_customer');
    if (saved) {
      const s = JSON.parse(saved);
      setPhone(s.phone); setName(s.name); setInstagram(s.instagram || ''); setEmail(s.email || ''); setCustomerId(s.customerId);
      setCustomerToken(s.customerToken || null);
      loadMyCoupons(s.customerId, s.customerToken).catch(() => { /* cupons e opcional: nao derruba a tela */ });
      loadReservations(s.customerId, s.customerToken).catch(() => { /* reservas: erro fica no proprio card */ });
    }
    loadOffers();
    loadCityAndCategoryOptions();
  }, []);

  function updateFilter(patch) {
    const next = { ...filterRef.current, ...patch };
    filterRef.current = next;
    setFilter(next);
  }

  function applyNearMe(radiusKm) {
    if (!('geolocation' in navigator)) { setGeoStatus('denied'); return; }
    setGeoStatus('locating');
    setFilterMsg(t.nearMe);
    navigator.geolocation.getCurrentPosition((pos) => {
      updateFilter({ byDistance: true, radiusKm, lat: pos.coords.latitude, lng: pos.coords.longitude });
      setGeoStatus('done');
      setFilterMsg('');
      loadOffers();
    }, () => { setGeoStatus('denied'); setFilterMsg(t.locationDenied); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  }

  function turnOffNearMe() {
    updateFilter({ byDistance: false, lat: null, lng: null });
    setGeoStatus('idle');
    setFilterMsg('');
    loadOffers();
  }

  // Translado/proximidade: buscas servicos de translado e veiculos ao vivo do
  // tenant. A geolocalizacao e opcional — negada ou indisponivel, listamos tudo
  // sem distancia, em vez de esconder o recurso.
  async function loadShuttle() {
    if (!('geolocation' in navigator)) {
      setShuttle((s) => ({ ...s, status: 'done', lat: null, lng: null, err: '' }));
      await fetchShuttle(null, null);
      return;
    }
    setShuttle((s) => ({ ...s, status: 'locating', err: '' }));
    navigator.geolocation.getCurrentPosition(
      async (pos) => { setShuttle((s) => ({ ...s, lat: pos.coords.latitude, lng: pos.coords.longitude })); await fetchShuttle(pos.coords.latitude, pos.coords.longitude); },
      async () => { setShuttle((s) => ({ ...s, lat: null, lng: null })); await fetchShuttle(null, null); },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  async function fetchShuttle(lat, lng) {
    try {
      const params = new URLSearchParams({ tenantId: TENANT_ID });
      if (lat != null && lng != null) { params.set('lat', lat); params.set('lng', lng); params.set('radiusKm', '16'); }
      const res = await fetchComTimeout(`/.netlify/functions/shuttle?${params.toString()}`);
      if (!res.ok) {
        setShuttle((s) => ({ ...s, status: 'done', services: [], vehicles: [], err: (t.transladoFail ?? 'Não foi possível carregar o translado. Tente de novo em instantes.') }));
        return;
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.services) || !Array.isArray(data.vehicles)) {
        setShuttle((s) => ({ ...s, status: 'done', services: [], vehicles: [], err: (t.transladoFail ?? 'Não foi possível carregar o translado. Tente de novo em instantes.') }));
        return;
      }
      setShuttle((s) => ({ ...s, status: 'done', services: data.services, vehicles: data.vehicles, err: '' }));
    } catch (err) {
      setShuttle((s) => ({ ...s, status: 'done', services: [], vehicles: [], err: (t.transladoConn ?? 'Não foi possível carregar o translado. Verifique sua conexão.') }));
    }
  }

  function changeRadius(radiusKm) {
    updateFilter({ radiusKm });
    setFilterMsg('');
    loadOffers();
  }

  async function loadOffers() {
    const f = filterRef.current;
    const params = new URLSearchParams({ tenantId: TENANT_ID });
    if (f.city) params.set('city', f.city);
    if (f.category) params.set('category', f.category);
    if (f.byDistance && f.lat != null && f.lng != null) {
      params.set('lat', f.lat);
      params.set('lng', f.lng);
      params.set('radiusKm', f.radiusKm || 50);
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
    try {
      // Cidades e categorias vem do banco (RPCs list_cities/list_categories).
      // Antes as categorias eram derivadas da lista de ofertas ja carregada na
      // tela, que vinha vazia no mount: os chips nunca apareciam.
      const [cidades, cats] = await Promise.all([
        fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}&mode=cities`)
          .then((r) => r.ok ? r.json() : []),
        fetch(`/.netlify/functions/offers?tenantId=${TENANT_ID}&mode=categories`)
          .then((r) => r.ok ? r.json() : []),
      ]);
      const cityOpts = (Array.isArray(cidades) ? cidades : (Array.isArray(cidades.cities) ? cidades.cities : [])).filter(Boolean);
      const catOpts = (Array.isArray(cats) ? cats : (Array.isArray(cats.categories) ? cats.categories : [])).filter(Boolean);
      setCities(cityOpts);
      setCategories(catOpts);
      setFilter((f) => ({ ...f, city: cityOpts.length === 1 ? cityOpts[0] : f.city }));
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
    let ref;
    try { ref = localStorage.getItem('pyv_ref') || undefined; } catch (e) { /* sem referido */ }
    const res = await fetch('/.netlify/functions/identify', { method: 'POST', body: JSON.stringify({ phone, name, email, instagram, ref }) });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    localStorage.setItem('pyv_customer', JSON.stringify({ phone, name, instagram, email, customerId: data.customerId, customerToken: data.customerToken }));
    setCustomerId(data.customerId);
    setCustomerToken(data.customerToken);
    if (data.referral) { try { localStorage.removeItem('pyv_ref'); } catch (e) { /* sem referido */ } }
    setMsg('✅ Cadastro finalizado com sucesso!');
    loadMyCoupons(data.customerId, data.customerToken);
    loadReservations(data.customerId, data.customerToken).catch(() => { /* erro fica no card de reservas */ });
  }

  // --- Agendamento: reservas do cliente ------------------------------------
  // Mesmo desenho de loadOffers: res.ok e Array.isArray conferidos ANTES de
  // qualquer setState, e o erro vai para um estado separado. Passar a resposta
  // direto para o state ja quebrou esta tela uma vez (offers.map sobre um
  // {error}), entao o caminho de erro sempre zera a lista E seta a mensagem.
  async function loadReservations(cid, token) {
    const id = cid || customerId;
    const tk = token || customerToken;
    if (!id || !tk) return;
    try {
      const params = new URLSearchParams({ tenantId: TENANT_ID, customerId: id, customerToken: tk });
      const res = await fetchComTimeout(`/.netlify/functions/shuttle-reservation?${params.toString()}`);
      if (!res.ok) {
        setReservations([]);
        setReservationsErro('Não foi possível carregar suas reservas. Tente de novo em instantes.');
        return;
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.reservations)) {
        setReservations([]);
        setReservationsErro('Não foi possível carregar suas reservas. Tente de novo em instantes.');
        return;
      }
      setReservations(data.reservations);
      setReservationsErro('');
    } catch (err) {
      setReservations([]);
      setReservationsErro('Não foi possível carregar suas reservas. Verifique sua conexão.');
    }
  }

  function openBooking(service) {
    setBookMsg('');
    setBookErro('');
    setJustBooked(null);
    setBook({ service, date: '', time: '', passengers: 2, notes: '' });
  }

  function closeBooking() {
    setBook(null);
    setBookMsg('');
    setBookErro('');
  }

  function setBookField(patch) {
    setBook((b) => (b ? { ...b, ...patch } : b));
  }

  async function submitBooking() {
    if (!book) return;
    if (!customerId || !customerToken) {
      setBookErro(t.reserveIdentifyFirst ?? 'Identifique-se acima para reservar.');
      return;
    }
    const slots = bookingSlots(book.service, book.date, book.date === todayIso() ? nowMinutesLocal() : null);
    if (!book.time || !slots.includes(book.time)) {
      setBookErro(t.reservePickValidSlot ?? 'Escolha um horário disponível.');
      return;
    }
    setBookBusy(true);
    setBookErro('');
    setBookMsg('');
    try {
      // ISO com offset, como pede o contrato: o banco valida dia e hora no fuso
      // de referencia, e a string sem offset seria interpretada como UTC.
      const when = new Date(`${book.date}T${book.time}:00`);
      const res = await fetchComTimeout('/.netlify/functions/shuttle-reservation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: TENANT_ID,
          customerId,
          customerToken,
          action: 'create',
          shuttleId: book.service.shuttleId,
          scheduledFor: when.toISOString(),
          passengers: Number(book.passengers) || 1,
          notes: book.notes || null,
          contactPhone: phone || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setBookErro(reservationErrorMessage(data && data.error, t));
        return;
      }
      setJustBooked(data);
      setBook(null);
      loadReservations().catch(() => { /* erro fica no card de reservas */ });
    } catch (err) {
      setBookErro(t.reserveConn ?? 'Não foi possível reservar. Verifique sua conexão.');
    } finally {
      setBookBusy(false);
    }
  }

  async function cancelReservation(reservationId) {
    setBookBusy(true);
    try {
      const res = await fetchComTimeout('/.netlify/functions/shuttle-reservation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: TENANT_ID, customerId, customerToken, action: 'cancel', reservationId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setReservationsErro(reservationErrorMessage(data && data.error, t));
        return;
      }
      // Recarrega em vez de remendar o array: o cancelamento pode ter sido
      // recusado no banco e o estado local mentiria sobre o status.
      loadReservations().catch(() => { /* erro fica no card de reservas */ });
    } catch (err) {
      setReservationsErro(t.reserveConn ?? 'Não foi possível cancelar. Verifique sua conexão.');
    } finally {
      setBookBusy(false);
    }
  }

  // Card "Indique um amigo": o mesmo telefone sempre devolve o mesmo link de
  // afiliado (affiliates.js faz get-or-create), entao gerar de novo nao duplica.
  async function ensureInvite() {
    const savedInvite = JSON.parse(localStorage.getItem('pyv_customer_invite') || 'null');
    if (savedInvite && savedInvite.referralCode) { setInvite(savedInvite); return; }
    const savedCustomer = JSON.parse(localStorage.getItem('pyv_customer') || 'null') || {};
    const effPhone = phone || savedCustomer.phone || '';
    if (!effPhone) { setInviteMsg(t.inviteNeedsPhone ?? 'Cadastre seu telefone acima para gerar seu link.'); return; }
    const effName = name || savedCustomer.name || 'Cliente';
    setInviteMsg('');
    const res = await fetch('/.netlify/functions/affiliates', {
      method: 'POST',
      body: JSON.stringify({ name: effName, phone: effPhone }),
    });
    const data = await res.json();
    if (!res.ok || !data.referralCode) { setInviteMsg(t.inviteRetry ?? 'Não foi possível gerar seu link. Tente novamente.'); return; }
    const inv = { affiliateId: data.affiliateId, referralCode: data.referralCode, shareUrl: data.shareUrl };
    try { localStorage.setItem('pyv_customer_invite', JSON.stringify(inv)); } catch (e) { /* sem storage */ }
    setInvite(inv);
  }

  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin + invite.shareUrl);
      setInviteMsg(t.inviteCopied ?? 'Link copiado!');
    } catch (e) {
      setInviteMsg(t.inviteCopyFailed ?? 'Não foi possível copiar. Selecione e copie o link acima.');
    }
  }

  async function claim(offer) {
    const templateId = offer.templateId;
    const saved = JSON.parse(localStorage.getItem('pyv_customer') || 'null') || {};
    const effPhone = phone || saved.phone;
    if (!effPhone) { setMsg('Informe seu telefone primeiro.'); return; }
    const effName = name || saved.name || '';
    const effInstagram = instagram || saved.instagram || '';
    const effEmail = email || saved.email || '';
    let ref;
    try { ref = localStorage.getItem('pyv_ref') || undefined; } catch (e) { /* sem referido */ }
    const res = await fetch('/.netlify/functions/claim-coupon', {
      method: 'POST',
      body: JSON.stringify({ tenantId: TENANT_ID, templateId, phone: effPhone, name: effName, instagram: effInstagram, email: effEmail, ref }),
    });
    const data = await res.json();
    if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
    if (data.referral) { try { localStorage.removeItem('pyv_ref'); } catch (e) { /* sem referido */ } }
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

  const inviteUrl = (typeof window !== 'undefined' && invite) ? window.location.origin + invite.shareUrl : '';

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
          {/* O codigo curto saiu da tela (decisao do dono, setembro/2026): o
              balcao nao tem campo para digitar e o codigo acima ja autoriza
              sozinho, entao o numero so gerava confusao no caixa. O backend
              continua aceitando quem use o par codigo+curto em material
              antigo. Ver netlify/functions/_wa.js. */}

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
              onClick={() => { updateFilter({ city: '' }); loadOffers(); }}
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
                onClick={() => { updateFilter({ city: c }); loadOffers(); }}
              >{c}</button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 12px', alignItems: 'center' }}>
          <button
            type="button"
            style={{
              ...smallBtn, borderRadius: 999, padding: '5px 12px', cursor: 'pointer',
              background: filter.byDistance ? theme.gold : theme.bg,
              color: filter.byDistance ? theme.greenDark : theme.text,
              border: `1px solid ${filter.byDistance ? theme.gold : theme.border}`,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
            onClick={() => (filter.byDistance ? turnOffNearMe() : applyNearMe(filter.radiusKm || 16))}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
              <path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z" />
            </svg>
            {filter.byDistance ? `${filter.radiusKm} km` : t.nearMe}
          </button>
          {filter.byDistance && (
            <select
              aria-label={t.filterRadius}
              value={filter.radiusKm}
              onChange={(e) => changeRadius(Number(e.target.value))}
              style={{
                ...smallBtn, padding: '5px 8px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${theme.border}`, background: theme.bg, color: theme.text,
              }}
            >
              {[5, 16, 50, 100].map((km) => <option key={km} value={km}>{km} km</option>)}
            </select>
          )}
          {geoStatus === 'locating' && <span style={{ fontSize: 12, color: theme.textMuted }}>{t.checking}</span>}
        </div>
        {filterMsg && <p style={{ fontSize: 12, color: theme.textMuted, margin: '-4px 0 10px' }}>{filterMsg}</p>}

        {categories.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 12px' }}>
            <button
              style={{
                ...smallBtn, borderRadius: 999, padding: '5px 12px', cursor: 'pointer',
                background: filter.category === '' ? theme.gold : theme.bg,
                color: filter.category === '' ? theme.greenDark : theme.text,
                border: `1px solid ${filter.category === '' ? theme.gold : theme.border}`,
              }}
              onClick={() => { updateFilter({ category: '' }); loadOffers(); }}
            >{t.allActivities}</button>
            {categories.map((c) => (
              <button
                key={c}
                style={{
                  ...smallBtn, borderRadius: 999, padding: '5px 12px', cursor: 'pointer',
                  background: filter.category === c ? theme.gold : theme.bg,
                  color: filter.category === c ? theme.greenDark : theme.text,
                  border: `1px solid ${filter.category === c ? theme.gold : theme.border}`,
                }}
                onClick={() => { updateFilter({ category: c }); loadOffers(); }}
              >{t['cat_' + c] || c}</button>
            ))}
          </div>
        )}

        {offersErro ? (
          <p style={{ color: '#B42318', margin: 0 }}>{offersErro}</p>
        ) : offers.length === 0 ? <p>{t.noOffers}</p> : offers.map((o) => (
          <div key={o.templateId} className="offer-row" style={{
            display: 'flex', alignItems: 'center', gap: 14,
            border: o.featured ? `2px solid ${theme.gold}` : `1px solid ${theme.border}`,
            borderRadius: 12, padding: 12, marginBottom: 10,
            background: o.featured ? theme.goldLight : theme.bg,
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
              <div style={{ fontSize: 12, color: theme.textMuted }}>
                {o.featured && <span style={{ color: theme.greenDark, fontWeight: 700 }}>⭐ {t.featured} · </span>}
                {o.businessName} · {t['cat_' + o.category] || o.category} · {Number(o.benefitValue)}% OFF
              </div>
              {o.distanceKm != null && o.distanceKm !== '' && (
                <div style={{ fontSize: 12, color: theme.textMuted }}>{Number(o.distanceKm).toFixed(1)} km</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t.inviteTitle ?? '💛 Indique um amigo'}</h3>
        <p style={{ fontSize: 13, marginTop: 0 }}>
          {t.inviteSub ?? 'Quem entra pelo seu link e resgata um cupom pela primeira vez também libera um bônus para você.'}
        </p>
        {!invite ? (
          <>
            <button style={btn} onClick={ensureInvite}>{t.inviteGenerate ?? 'Gerar meu link'}</button>
            {inviteMsg && <p style={{ fontSize: 13 }}>{inviteMsg}</p>}
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, margin: 0 }}>
              {t.yourCode ?? 'Seu código:'} <strong style={{ fontFamily: 'monospace', letterSpacing: 1 }}>{invite.referralCode}</strong>
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0' }}>
              <input readOnly style={{ ...input, flex: 1, minWidth: 220, background: theme.bg, margin: 0 }} value={inviteUrl} onFocus={(e) => e.target.select()} />
              <button style={btn} onClick={copyInviteLink}>{t.inviteCopy ?? 'Copiar link'}</button>
              <a
                style={{ ...btn, background: '#128C4A', color: '#fff', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                href={`https://api.whatsapp.com/send?text=${encodeURIComponent('Ganhe desconto e aproveite Cabo Frio: ' + inviteUrl)}`}
                target="_blank"
                rel="noreferrer"
              >WhatsApp</a>
              <a
                style={{ ...btn, background: '#E4405F', color: '#fff', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                href={`https://www.instagram.com/?caption=${encodeURIComponent('Aproveite a sua próxima visita ♥ ' + inviteUrl)}`}
                target="_blank"
                rel="noreferrer"
              >Instagram</a>
            </div>
            <p style={{ fontSize: 13, margin: 0 }}>{inviteMsg}</p>
          </>
        )}
        <p style={{ fontSize: 12, margin: '10px 0 0' }}>
          <a href="/afiliado" style={{ color: theme.greenDark, fontWeight: 700 }}>{t.invitePanel ?? 'Painel completo do afiliado →'}</a>
        </p>
      </div>

      <div style={card}>
        <h3>{t.mapTitle}</h3>
        <p style={{ fontSize: 12 }}>{t.mapLegend}</p>
        <button style={btn} onClick={showMap}>{mapStatus === 'idle' ? t.showMap : t.updateMap}</button>
        {mapStatus === 'denied' && <p style={{ fontSize: 13 }}>{t.locationDenied}</p>}
        <div ref={mapRef} style={{ height: 320, marginTop: 12, borderRadius: 8, display: mapStatus === 'idle' ? 'none' : 'block' }} />
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>{t.transladoTitle ?? '🚐 Translado e proximidade'}</h3>
        <p style={{ fontSize: 12, marginTop: 0 }}>
          {t.transladoSub ?? 'Serviços de translado e veículos disponíveis agora na região.'}
        </p>
        <button style={btn} onClick={loadShuttle}>
          {shuttle.status === 'locating' ? (t.checking ?? 'Localizando...') : (t.transladoNear ?? 'Ver perto de mim')}
        </button>
        {shuttle.status === 'done' && (
          <>
            {shuttle.lat == null && !shuttle.err && (
              <p style={{ fontSize: 12, color: theme.textMuted, marginBottom: 0 }}>
                {t.transladoNoLoc ?? 'Listando tudo sem distâncias (localização não disponível).'}
              </p>
            )}
            {shuttle.err && <p style={{ color: '#B42318', margin: '10px 0 0' }}>{shuttle.err}</p>}
            {!shuttle.err && shuttle.services.length === 0 && shuttle.vehicles.length === 0 && (
              <p style={{ margin: '10px 0 0' }}>{t.transladoNone ?? 'Nenhum translado ativo por aqui no momento.'}</p>
            )}
            {!shuttle.err && shuttle.services.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <strong>{t.transladoServices ?? 'Serviços de translado'}</strong>
                {shuttle.services.map((s) => (
                  <div key={s.shuttleId} style={{
                    border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12, marginTop: 8, background: theme.bg,
                  }}>
                    <strong>{s.name}</strong>
                    {s.distanceKm != null && <span style={{ fontSize: 12, color: theme.textMuted }}> · {Number(s.distanceKm).toFixed(1)} km</span>}
                    <div style={{ fontSize: 12, color: theme.textMuted }}>{s.businessName} · {shuttleTypeLabel(s.serviceType, t)}</div>
                    {s.description && <div style={{ fontSize: 12, marginTop: 4 }}>{s.description}</div>}
                    <div style={{ fontSize: 12, marginTop: 4 }}>
                      {s.priceCents != null ? `R$ ${(s.priceCents / 100).toFixed(2)}` : (t.transladoPrice ?? 'Preço a combinar')}
                      {s.opensAt && s.closesAt && ` · ${s.opensAt}–${s.closesAt}`}
                      {Array.isArray(s.activeDays) && s.activeDays.length > 0 && ` · ${s.activeDays.join(', ')}`}
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button type="button" style={smallBtn} onClick={() => openBooking(s)}>
                        {t.reserveNow ?? 'Reservar'}
                      </button>
                      {!s.opensAt || !s.closesAt ? (
                        <span style={{ fontSize: 11, color: theme.textMuted }}>
                          {t.reserveNoWindow ?? 'sem horário definido — reserve e a empresa combina'}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: theme.textMuted }}>{t.reservePickWhen ?? 'escolha data e horário'}</span>
                      )}
                    </div>
                    {book && book.service && book.service.shuttleId === s.shuttleId && (
                      <div style={{ border: `1px solid ${theme.gold}`, borderRadius: 12, padding: 12, marginTop: 10, background: theme.goldLight }}>
                        <strong style={{ fontSize: 13 }}>{t.reserveTitle ?? 'Reservar translado'}</strong>
                        {!customerId ? (
                          <>
                            <p style={{ fontSize: 12, margin: '6px 0' }}>{t.noPasswordNote}</p>
                            <button type="button" style={smallBtn} onClick={finalizeRegistration}>
                              {t.identifyNow ?? 'Identificar-me agora'}
                            </button>
                          </>
                        ) : (
                          <>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                              <input
                                type="date"
                                style={{ ...input, margin: 0 }}
                                value={book.date}
                                onChange={(e) => setBookField({ date: e.target.value, time: '' })}
                              />
                              <input
                                type="number"
                                min={1}
                                max={20}
                                style={{ ...input, margin: 0, width: 90 }}
                                value={book.passengers}
                                onChange={(e) => setBookField({ passengers: e.target.value })}
                              />
                            </div>
                            {(() => {
                              const slots = bookingSlots(book.service, book.date, book.date === todayIso() ? nowMinutesLocal() : null);
                              if (!book.date) {
                                return <p style={{ fontSize: 12, margin: '8px 0 0' }}>{t.reservePickDate ?? 'Escolha a data.'}</p>;
                              }
                              if (slots.length === 0) {
                                return (
                                  <p style={{ fontSize: 12, margin: '8px 0 0', color: '#B42318' }}>
                                    {t.reserveNoSlots ?? 'Sem horários disponíveis nesta data para este serviço.'}
                                  </p>
                                );
                              }
                              return (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0 0' }}>
                                  {slots.map((h) => (
                                    <button
                                      key={h}
                                      type="button"
                                      style={{
                                        ...smallBtn,
                                        background: book.time === h ? theme.gold : theme.bg,
                                        color: book.time === h ? theme.greenDark : theme.text,
                                        border: `1px solid ${theme.border}`,
                                      }}
                                      onClick={() => setBookField({ time: h })}
                                    >{h}</button>
                                  ))}
                                </div>
                              );
                            })()}
                            <input
                              placeholder={t.reserveNotes ?? 'Observação (opcional)'}
                              style={{ ...input, width: '100%', margin: '8px 0 0' }}
                              value={book.notes}
                              onChange={(e) => setBookField({ notes: e.target.value })}
                            />
                            {bookErro && <p style={{ fontSize: 12, color: '#B42318', margin: '8px 0 0' }}>{bookErro}</p>}
                            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                              <button type="button" style={smallBtn} disabled={bookBusy} onClick={submitBooking}>
                                {bookBusy ? (t.checking ?? 'Enviando...') : (t.reserveConfirm ?? 'Confirmar reserva')}
                              </button>
                              <button type="button" style={{ ...smallBtn, background: theme.bg, color: theme.text, border: `1px solid ${theme.border}` }} onClick={closeBooking}>
                                {t.reserveClose ?? 'Fechar'}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {!shuttle.err && shuttle.vehicles.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <strong>{t.transladoVehicles ?? 'Veículos ao vivo'}</strong>
                {shuttle.vehicles.map((v) => (
                  <div key={v.driverId} style={{
                    border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12, marginTop: 8, background: theme.bg,
                  }}>
                    <strong>{v.driverName}</strong>
                    <div style={{ fontSize: 12, color: theme.textMuted }}>
                      {v.distanceKm != null && `${Number(v.distanceKm).toFixed(1)} km`}
                      {v.speedKmh != null && ` · ${Number(v.speedKmh)} km/h`}
                      {` · ${(t.vehicleUpdated ?? 'atualizado {time}').replace('{time}', timeAgo(v.recordedAt, t))}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {justBooked && (
        <div style={{ ...card, border: `2px solid ${theme.gold}` }}>
          <h3 style={{ marginTop: 0 }}>{t.reserveDoneTitle ?? 'Reserva enviada!'}</h3>
          <p style={{ fontSize: 13, margin: '0 0 6px' }}>
            <strong>{justBooked.serviceName || (t.transladoTitle ?? 'Translado')}</strong>
            {justBooked.businessName ? ` · ${justBooked.businessName}` : ''}
          </p>
          <p style={{ fontSize: 13, margin: 0 }}>
            {formatWhen(justBooked.scheduledFor, lang)} · {justBooked.passengers} {t.reservePassengers ?? 'passageiros'}
            {formatPrice(justBooked.priceCents)
              ? ` · ${formatPrice(justBooked.priceCents)}`
              : ` · ${t.transladoPrice ?? 'Preço a combinar'}`}
          </p>
          <p style={{ fontSize: 12, color: theme.textMuted, margin: '6px 0 0' }}>
            {t.reservePendingNote ?? 'A empresa confirma em breve. Acompanhe o status em "Minhas reservas".'}
          </p>
          {/* Telefone vem da RPC (businessPhone), nunca do browser. */}
          {justBooked.businessPhone && (
            <a
              href={buildWaLink({ phone: justBooked.businessPhone, message: reservationWaMessage(justBooked) })}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 12, padding: '9px 14px',
                borderRadius: 10, textDecoration: 'none', background: '#128C4A', color: '#fff',
                fontWeight: 700, fontSize: 13,
              }}
            >
              {t.reserveWhatsapp ?? 'Falar no WhatsApp'}
            </a>
          )}
        </div>
      )}

      {customerId && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>{t.myReservations ?? '📅 Minhas reservas'}</h3>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            {[
              { key: 'active', label: t.reserveFilterActive ?? 'Ativas' },
              { key: 'cancelled', label: t.reserveFilterCancelled ?? 'Canceladas' },
              { key: 'all', label: t.reserveFilterAll ?? 'Todas' },
            ].map((f) => (
              <button key={f.key} type="button" onClick={() => setResFilter(f.key)} style={{
                ...smallBtn,
                background: resFilter === f.key ? theme.gold : theme.bg,
                color: resFilter === f.key ? theme.greenDark : theme.text,
                border: `1px solid ${theme.border}`,
              }}>{f.label}</button>
            ))}
          </div>
          {reservationsErro ? (
            <p style={{ color: '#B42318', margin: 0 }}>{reservationsErro}</p>
          ) : (() => {
            const visible = reservations.filter((r) => {
              if (resFilter === 'all') return true;
              if (resFilter === 'active') return r.status === 'pending' || r.status === 'confirmed';
              return r.status === resFilter;
            });
            if (visible.length === 0) {
              return <p>{t.reserveNone ?? 'Você ainda não tem reservas de translado.'}</p>;
            }
            return visible.map((r) => (
              <div key={r.reservationId} style={{
                border: `1px solid ${theme.border}`, borderRadius: 12, padding: 12,
                marginBottom: 8, background: theme.bg,
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13, flex: 1, minWidth: 140 }}>
                    {r.serviceName || (t.transladoTitle ?? 'Translado')}
                  </strong>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
                    background: r.status === 'confirmed' ? theme.greenLight : (r.status === 'cancelled' || r.status === 'rejected' ? '#FDECEC' : theme.gold),
                    color: r.status === 'confirmed' ? theme.green : (r.status === 'cancelled' || r.status === 'rejected' ? '#B42318' : theme.greenDark),
                  }}>{reservationStatusLabel(r.status, t)}</span>
                </div>
                <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>
                  {formatWhen(r.scheduledFor, lang)} · {r.passengers} {t.reservePassengers ?? 'passageiros'}
                  {r.businessName ? ` · ${r.businessName}` : ''}
                </div>
                {r.reason && <div style={{ fontSize: 12, marginTop: 4 }}>{t.reserveReason ?? 'Motivo:'} {r.reason}</div>}
                {(r.status === 'pending' || r.status === 'confirmed') && (
                  <button
                    type="button"
                    style={{ ...smallBtn, marginTop: 8, background: theme.bg, color: '#B42318', border: `1px solid ${theme.border}` }}
                    disabled={bookBusy}
                    onClick={() => cancelReservation(r.reservationId)}
                  >
                    {bookBusy ? (t.checking ?? 'Aguarde...') : (t.reserveCancel ?? 'Cancelar reserva')}
                  </button>
                )}
              </div>
            ));
          })()}
        </div>
      )}

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

