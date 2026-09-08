'use client';

import { useEffect, useState } from 'react';
import { getSupabasePublicClient } from '../lib/supabase';
import { useLanguage } from '../lib/LanguageContext';
import { theme } from '../lib/theme';

function CouponLink({ href, icon, title, subtitle }) {
  return (
    <a
      href={href}
      style={{
        display: 'block', position: 'relative', textDecoration: 'none',
        background: theme.card, color: theme.text, borderRadius: 16,
        border: `2px solid ${theme.border}`, padding: '20px 22px', marginBottom: 16,
        boxShadow: '0 2px 10px rgba(11,110,79,0.08)', transition: 'transform 0.15s ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.02)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{
          fontSize: 26, background: theme.gold, color: theme.greenDark, width: 46, height: 46,
          borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>{icon}</span>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
          <div style={{ fontSize: 13, color: theme.textMuted }}>{subtitle}</div>
        </div>
        <span style={{ marginLeft: 'auto', fontSize: 20, color: theme.green, fontWeight: 900 }}>→</span>
      </div>
    </a>
  );
}

function LanguageMenu() {
  const { lang, setLang } = useLanguage();
  const langs = [['pt', 'PT'], ['en', 'EN'], ['es', 'ES']];
  return (
    <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 4, background: theme.greenLight, borderRadius: 20, padding: 4 }}>
      {langs.map(([code, label]) => (
        <button
          key={code}
          onClick={() => setLang(code)}
          style={{
            border: 'none', borderRadius: 16, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            background: lang === code ? theme.gold : 'transparent',
            color: lang === code ? theme.greenDark : theme.green,
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
  const [splashVisible, setSplashVisible] = useState(true);
  const [logoAnimated, setLogoAnimated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setLogoAnimated(true), 80);
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
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return (
    <main style={{ position: 'relative', minHeight: '100vh', background: theme.bg, overflow: 'hidden' }}>
      {splashVisible && (
        <div style={{
          position: 'fixed', inset: 0, background: '#FFFFFF', zIndex: 20,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24,
          opacity: logoAnimated ? 1 : 0, transition: 'opacity 0.4s ease',
        }}>
          <img
            src="/logo.png" alt="Playas y Ventajas"
            style={{
              width: 220, height: 220, marginBottom: 40,
              transform: logoAnimated ? 'scale(1)' : 'scale(0.7)',
              opacity: logoAnimated ? 1 : 0,
              transition: 'transform 0.6s cubic-bezier(0.34,1.56,0.64,1), opacity 0.6s ease',
            }}
          />
          <button
            onClick={() => setSplashVisible(false)}
            style={{
              background: theme.gold, color: theme.greenDark, border: 'none', borderRadius: 999,
              padding: '14px 56px', fontSize: 16, fontWeight: 800, cursor: 'pointer',
              boxShadow: '0 6px 18px rgba(242,193,78,0.5)',
              transform: logoAnimated ? 'translateY(0)' : 'translateY(20px)',
              opacity: logoAnimated ? 1 : 0,
              transition: 'transform 0.6s ease 0.2s, opacity 0.6s ease 0.2s',
            }}
          >
            {t.start || 'Comenzar'}
          </button>
        </div>
      )}

      <LanguageMenu />
      <div style={{ maxWidth: 460, margin: '0 auto', padding: '64px 24px 60px', textAlign: 'center' }}>
        <img src="/logo.png" alt="Playas y Ventajas" style={{ width: 110, height: 110, borderRadius: 20, marginBottom: 12, boxShadow: '0 6px 16px rgba(11,110,79,0.18)' }} />
        <h1 style={{ color: theme.green, fontSize: 24, margin: '4px 0 2px' }}>Playas y Ventajas</h1>
        <p style={{ color: theme.textMuted, fontSize: 14, marginBottom: 32 }}>{t.tagline}</p>

        <div style={{ textAlign: 'left' }}>
          <CouponLink href="/cliente" icon="🎟️" title={t.client} subtitle={t.clientSub} />
          <CouponLink href="/empresa" icon="🏪" title={t.business} subtitle={t.businessSub} />
          <CouponLink href="/admin" icon="🛠️" title={t.admin} subtitle={t.adminSub} />
        </div>

        <p style={{ marginTop: 28, fontSize: 12, color: theme.textMuted }}>
          {health.status === 'ok' ? t.online : health.status === 'checking' ? t.checking : t.unstable}
        </p>
      </div>
    </main>
  );
}
