'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '../../../lib/LanguageContext';
import Header from '../../components/Header';
import { theme } from '../../../lib/theme';
import { ADMIN_MODULES, isAdminRole, loadAdminSession, markAdminModulesOrigin } from '../../../lib/adminModules';

const wrap = { maxWidth: 780, margin: '0 auto', padding: '20px 20px 80px', color: theme.text };
const card = {
  display: 'flex', alignItems: 'center', gap: 14, width: '100%', textAlign: 'left',
  background: theme.card, color: theme.text, borderRadius: 14, padding: 18, marginBottom: 14,
  border: `1px solid ${theme.border}`, boxShadow: '0 2px 8px rgba(11,110,79,0.06)', cursor: 'pointer',
};

export default function AdminModulesPage() {
  const { t } = useLanguage();
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = loadAdminSession();
    if (!saved || !isAdminRole(saved.role)) {
      router.replace('/admin');
      return;
    }
    setReady(true);
  }, []);

  function openModule(href) {
    markAdminModulesOrigin();
    router.push(href);
  }

  if (!ready) return null;

  return (
    <main style={{ background: theme.bg, minHeight: '100vh' }}>
      <Header title={t.adminModulesTitle} />
      <div style={wrap}>
        {ADMIN_MODULES.map((m) => (
          <button key={m.id} type="button" style={card} onClick={() => openModule(m.href)}>
            <span style={{ fontSize: 30, lineHeight: 1 }}>{m.icon}</span>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <strong style={{ fontSize: 16 }}>{t[m.titleKey]}</strong>
              <span style={{ fontSize: 13, color: theme.textMuted }}>{t[m.subKey]}</span>
            </span>
          </button>
        ))}
      </div>
    </main>
  );
}
