'use client';

import Link from 'next/link';
import { theme } from '../../lib/theme';

export default function Header({ title, right }) {
  return (
    <div style={{
      background: theme.green, color: '#FFFFFF', padding: '16px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'sticky', top: 0, zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link href="/" style={{ color: '#FFFFFF', textDecoration: 'none', fontSize: 14, opacity: 0.9 }}>← Voltar ao menu</Link>
        <strong style={{ fontSize: 16, letterSpacing: 0.5 }}>{title}</strong>
      </div>
      <div>{right}</div>
    </div>
  );
}
