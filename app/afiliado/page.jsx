'use client';

// Modulo do afiliado (Modelo A - recompensa em cupom). Publico, sem sessao:
// o vinculo e por telefone, igual ao fluxo do cliente.
//
// Os textos desta tela ainda ficam em portugues literal. A nota antiga dizia
// que era por causa de uma alteracao em lib/i18n.js que ja terminou: as
// strings migram para t.* (pt/en/es) em um lote proprio, junto da folha
// impressa de divulgacao.

import { useEffect, useRef, useState } from 'react';
import Header from '../components/Header';
import ModuleSplash from '../components/ModuleSplash';
import { theme } from '../../lib/theme';

function loadQrCode() {
  return new Promise((resolve) => {
    if (window.QRCode) return resolve(window.QRCode);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/qrcodejs@1.0.0/qrcode.min.js';
    script.onload = () => resolve(window.QRCode);
    document.body.appendChild(script);
  });
}

const wrap = { maxWidth: 720, margin: '0 auto', padding: '20px 20px 80px', color: theme.text };
const card = { background: theme.card, color: theme.text, borderRadius: 14, padding: 20, marginBottom: 16, border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)' };
const input = { padding: 9, borderRadius: 8, border: `1px solid ${theme.border}`, marginRight: 8, marginBottom: 8, width: '100%', boxSizing: 'border-box' };
const btn = { padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: theme.gold, color: theme.greenDark, fontWeight: 700, marginRight: 8 };
const smallBtn = { ...btn, padding: '5px 12px', fontSize: 12 };

// O value das opcoes PRECISA ser o valor aceito pelo CHECK do banco
// (affiliates_kind_check: 'customer' | 'driver' | 'business'). Antes eram
// 'customer' | 'empresa' | 'motorista', e escolher empresa ou motorista
// rebentava o INSERT com violacao de check - o cadastro do afiliado simply
// nao acontecia. O texto da opcao continua em portugues para o usuario.
const KIND_LABEL = { customer: 'Cliente', driver: 'Motorista', business: 'Empresa' };

export default function AfiliadoPage() {
  const [splashDone, setSplashDone] = useState(false);
  const [affiliate, setAffiliate] = useState(null); // { affiliateId, referralCode, name, phone, kind }
  const [form, setForm] = useState({ name: '', phone: '', email: '', kind: 'customer' });
  const [busy, setBusy] = useState(false);
  const [dash, setDash] = useState(null);
  const [msg, setMsg] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const qrRef = useRef(null);

  useEffect(() => {
    setShareUrl(`${window.location.origin}/?ref=${encodeURIComponent((affiliate && affiliate.referralCode) || '')}`);
  }, [affiliate]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('pyv_affiliate');
      if (saved) {
        const a = JSON.parse(saved);
        setAffiliate(a);
        loadDash(a);
      }
    } catch (e) { /* sem afiliado salvo */ }
  }, []);

  useEffect(() => {
    if (!shareUrl || !qrRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const QRCode = await loadQrCode();
        if (cancelled || !qrRef.current) return;
        qrRef.current.innerHTML = '';
        new QRCode(qrRef.current, { text: shareUrl, width: 180, height: 180 });
      } catch (e) { /* QR opcional */ }
    })();
    return () => { cancelled = true; };
  }, [shareUrl]);

  async function register() {
    if (!form.name.trim()) { setMsg('Informe seu nome.'); return; }
    if (!form.phone.trim()) { setMsg('Informe seu telefone.'); return; }
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/.netlify/functions/affiliates', {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim() || undefined, kind: form.kind }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg(`Erro: ${data.error}`); return; }
      const a = { affiliateId: data.affiliateId, referralCode: data.referralCode, name: form.name.trim(), phone: form.phone.trim(), kind: form.kind };
      setAffiliate(a);
      try { localStorage.setItem('pyv_affiliate', JSON.stringify(a)); } catch (e) { /* sem storage */ }
      setMsg('💚 Cadastro criado! Compartilhe seu link abaixo.');
      loadDash(a);
    } catch (err) {
      setMsg(`Erro: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadDash(a) {
    const aff = a || affiliate;
    if (!aff) return;
    try {
      const res = await fetch(`/.netlify/functions/affiliates?affiliateId=${encodeURIComponent(aff.affiliateId)}&phone=${encodeURIComponent(aff.phone)}`);
      const data = await res.json();
      if (res.ok && data && data.affiliateId) setDash(data);
    } catch (e) { /* dashboard opcional: nao derruba a tela */ }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setMsg('Link copiado!');
    } catch (e) {
      setMsg('Não foi possível copiar. Selecione e copie o link abaixo.');
    }
  }

  function shareWhatsApp() {
    const text = encodeURIComponent(`Ganhe desconto e aproveite Cabo Frio: ${shareUrl}`);
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  }

  function shareInstagram() {
    const text = encodeURIComponent(`Aproveite a sua próxima visita ♥ ${shareUrl}`);
    window.open(`https://www.instagram.com/?caption=${text}`, '_blank');
  }

  return (
    <main style={{ background: theme.bg, minHeight: '100vh' }}>
      <ModuleSplash visible={!splashDone} onDone={() => setSplashDone(true)} />
      <Header title="🤝 Afiliados — Playas y Ventajas" />
      <div style={wrap}>

        {!affiliate ? (
          <div style={card}>
            <h3 style={{ marginTop: 0 }}>Quero ganhar com indicações</h3>
            <p style={{ fontSize: 13, marginTop: 0 }}>
              Cadastre-se, ganhe seu link exclusivo e compartilhe. A cada amigo que se cadastrar e resgatar um cupom,
              você recebe uma recompensa em cupom de cortesia — sem precisar de login.
            </p>
            <input style={input} placeholder="seu nome" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input style={input} placeholder="(00) 00000-0000" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input style={input} placeholder="seu e-mail (opcional)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <select style={input} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="customer">Sou cliente do programa</option>
              <option value="business">Represento uma empresa parceira</option>
              <option value="driver">Sou motorista parceiro</option>
            </select>
            <button style={btn} onClick={register} disabled={busy}>{busy ? 'Cadastrando…' : 'Criar meu link de indicação'}</button>
          </div>
        ) : (
          <>
          <div style={{ ...card, border: `2px solid ${theme.gold}` }}>
            <h3 style={{ marginTop: 0 }}>Olá, {affiliate.name} 👋</h3>
            <p style={{ fontSize: 13, marginTop: 0 }}>
              Seu código: <strong style={{ fontFamily: 'monospace', letterSpacing: 1 }}>{affiliate.referralCode}</strong>
              <button style={smallBtn} onClick={() => navigator.clipboard?.writeText(affiliate.referralCode) && setMsg('Código copiado.')}>Copiar</button>
            </p>
            <p style={{ fontSize: 13 }}>Compartilhe seu link:</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <input readOnly style={{ ...input, flex: 1, minWidth: 220, background: theme.bg }} value={shareUrl} onFocus={(e) => e.target.select()} />
              <button style={btn} onClick={copyLink}>Copiar link</button>
              <button style={{ ...btn, background: '#128C4A', color: '#fff' }} onClick={shareWhatsApp}>WhatsApp</button>
              <button style={{ ...btn, background: '#E4405F', color: '#fff' }} onClick={shareInstagram}>Instagram</button>
            </div>
            <div ref={qrRef} style={{ display: 'flex', justifyContent: 'center', margin: '6px 0' }} />
            <p style={{ fontSize: 12, color: theme.textMuted, margin: '6px 0 0' }}>
              Quem entra pelo seu link e resgata um cupom pela primeira vez também ganha um bônus de boas-vindas.
            </p>
            <button style={{ ...smallBtn, background: theme.border, color: theme.text }} onClick={() => { setAffiliate(null); setDash(null); try { localStorage.removeItem('pyv_affiliate'); } catch (e) { /* sem storage */ } setForm({ name: '', phone: '', email: '', kind: 'customer' }); }}>
              Sair deste perfil
            </button>
          </div>

          {dash && (
            <div style={card}>
              <h3 style={{ marginTop: 0 }}>Painel de indicações</h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                {[
                  ['Linkadas', dash.totalReferrals ?? 0],
                  ['Convertidas', dash.converted ?? 0],
                  ['Pendentes', dash.pending ?? 0],
                  ['Premiadas', dash.rewardCoupons ?? 0],
                ].map(([label, value]) => (
                  <div key={label} style={{ flex: '1 1 90px', background: theme.bg, borderRadius: 10, padding: 10, textAlign: 'center', border: `1px solid ${theme.border}` }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: theme.greenDark }}>{value}</div>
                    <div style={{ fontSize: 12, color: theme.textMuted }}>{label}</div>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12, color: theme.textMuted, marginTop: 0 }}>
                Recompensa: {dash.rewardStatus === 'active' ? 'ativa' : dash.rewardStatus || '—'} · Afiliado desde {new Date(dash.createdAt).toLocaleDateString('pt-BR')}
              </p>
              {(dash.referrals || []).length === 0 ? (
                <p style={{ fontSize: 13 }}>Nenhuma indicação ainda. Compartilhe seu link para começar!</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
                  {(dash.referrals || []).map((r) => (
                    <li key={r.id}>
                      {r.referredName || r.referredPhone || 'Anônimo'} — {r.status === 'converted' ? '✅ convertido' : r.status === 'pending' ? '⏳ pendente' : r.status}
                      {r.convertedAt ? ` · ${new Date(r.convertedAt).toLocaleDateString('pt-BR')}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          </>
        )}

        {msg && <p style={{ fontSize: 13, color: theme.greenDark, fontWeight: 600 }}>{msg}</p>}
      </div>
    </main>
  );
}