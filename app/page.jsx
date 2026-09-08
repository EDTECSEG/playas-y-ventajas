'use client';

import { useEffect, useState } from 'react';
import { getSupabasePublicClient } from '../lib/supabase';
import { useLanguage } from '../lib/LanguageContext';

const COLORS = { green: '#0B6E4F', greenDark: '#084D38', gold: '#F2C14E', cream: '#FFFDF7' };

function CouponLink({ href, icon, title, subtitle }) {
  return (
    <a
      href={href}
      style={{
        display: 'block', position: 'relative', textDecoration: 'none',
        background: COLORS.cream, color: COLORS.green, borderRadius: 16,
        border: `3px dashed ${COLORS.gold}`, padding: '22px 24px', marginBottom: 18,
        boxShadow: '0 4px 14px rgba(0,0,0,0.15)', transition: 'transform 0.15s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.02)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
    >
      <div style={{ position: 'absolute', left: -14, top: '50%', transform: 'translateY(-50%)', width: 24, height: 24, borderRadius: '50%', background: COLORS.greenDark }} />
      <div style={{ position: 'absolute', right: -14, top: '50%', transform: 'translateY(-50%)', width: 24, height: 24, borderRadius: '50%', background: COLORS.greenDark }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontSize: 34 }}>{icon}</span>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{title}</div>
          <div style={{ fontSize: 13, opacity: 0.75 }}>{subtitle}</div>
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 22, color: COLORS.gold, fontWeight: 900 }}>→</span>
      </div>
    </a>
  );
}

function LanguageMenu() {
  const { lang, setLang } = useLanguage();
  const langs = [['pt', 'PT'], ['en', 'EN'], ['es', 'ES']];
  return (
    <div style={{
      position: 'absolute', top: 16, right: 16, display: 'flex', gap: 4,
      background: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: 4,
    }}>
      {langs.map(([code, label]) => (
        <button
          key={code}
          onClick={() => setLang(code)}
          style={{
            border: 'none', borderRadius: 16, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            background: lang === code ? COLORS.gold : 'transparent',
            color: lang === code ? COLORS.greenDark : COLORS.cream,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function Home() {
  const { t } = useLanguage();
  const [health, setHealth] = useState({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = getSupabasePublicClient();
        const { error } = await supabase.from('tenants').select('id', { count: 'exact', head: true });
        if (!cancelled) setHealth(error ? { status: 'error' } : { status: 'ok' });
      } catch {
        if (!cancelled) setHealth({ status: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <main style={{
      position: 'relative', minHeight: '100vh', background: `radial-gradient(circle at top, ${COLORS.green}, ${COLORS.greenDark})`,
      display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 24px 60px',
    }}>
      <LanguageMenu />
      <img src="/logo.png" alt="Playas y Ventajas" style={{ width: 180, height: 180, borderRadius: 24, marginBottom: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }} />
      <h1 style={{ color: COLORS.cream, fontSize: 26, margin: '8px 0 2px', textAlign: 'center' }}>Playas y Ventajas</h1>
      <p style={{ color: COLORS.gold, fontSize: 14, marginBottom: 36, textAlign: 'center' }}>{t.tagline}</p>

      <div style={{ width: '100%', maxWidth: 420 }}>
        <CouponLink href="/cliente" icon="🎟️" title={t.client} subtitle={t.clientSub} />
        <CouponLink href="/empresa" icon="🏪" title={t.business} subtitle={t.businessSub} />
        <CouponLink href="/admin" icon="🛠️" title={t.admin} subtitle={t.adminSub} />
      </div>

      <p style={{ marginTop: 32, fontSize: 12, color: COLORS.cream, opacity: 0.6 }}>
        {health.status === 'ok' ? t.online : health.status === 'checking' ? t.checking : t.unstable}
      </p>
    </main>
  );
}
