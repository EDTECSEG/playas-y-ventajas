'use client';

import { useLanguage } from '../../lib/LanguageContext';
import { theme } from '../../lib/theme';

const LANGS = [['pt', 'PT'], ['en', 'EN'], ['es', 'ES']];

export default function LanguageMenu({ light = false, style }) {
  const { lang, setLang } = useLanguage();
  return (
    <div style={{
      display: 'flex', gap: 4, padding: 4, borderRadius: 20,
      background: light ? 'rgba(255,255,255,0.16)' : theme.greenLight,
      ...style,
    }}>
      {LANGS.map(([code, label]) => {
        const active = lang === code;
        return (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            style={{
              border: 'none', borderRadius: 16, padding: '4px 9px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: active ? theme.gold : 'transparent',
              color: active ? theme.greenDark : (light ? '#FFFFFF' : theme.green),
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
