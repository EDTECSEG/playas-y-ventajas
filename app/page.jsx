'use client';

import { useRouter } from 'next/navigation';
import { useLanguage } from '../lib/LanguageContext';
import { theme } from '../lib/theme';
import ModuleSplash from './components/ModuleSplash';

function LanguageMenu() {
  const { lang, setLang } = useLanguage();
  const langs = [['pt', 'PT'], ['en', 'EN'], ['es', 'ES']];
  return (
    <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 30, display: 'flex', gap: 4, background: theme.greenLight, borderRadius: 20, padding: 4 }}>
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
  const router = useRouter();
  return (
    <main style={{ position: 'relative', minHeight: '100vh', background: theme.bg }}>
      <LanguageMenu />
      <ModuleSplash onDone={() => router.replace('/cliente')} />
    </main>
  );
}