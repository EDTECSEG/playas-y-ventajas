'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLanguage } from '../../lib/LanguageContext';
import { theme } from '../../lib/theme';
import { consumeAdminModulesOrigin, ADMIN_MODULES_PATH } from '../../lib/adminModules';

export default function Header({ title, right }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [showBack, setShowBack] = useState(false);

  useEffect(() => {
    if (consumeAdminModulesOrigin()) setShowBack(true);
  }, []);

  return (
    <div style={{
      background: theme.green, color: '#FFFFFF', padding: '16px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'sticky', top: 0, zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        {showBack && (
          <button
            type="button"
            onClick={() => router.replace(ADMIN_MODULES_PATH)}
            style={{
              flexShrink: 0, cursor: 'pointer', border: '1px solid rgba(255,255,255,0.6)',
              background: 'rgba(255,255,255,0.14)', color: '#FFFFFF', borderRadius: 999,
              padding: '6px 12px', fontSize: 13, fontWeight: 600,
            }}
          >
            {t.backToModules}
          </button>
        )}
        <strong style={{ fontSize: 16, letterSpacing: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </strong>
      </div>
      <div style={{ flexShrink: 0 }}>{right}</div>
    </div>
  );
}
