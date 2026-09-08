'use client';

import { theme } from '../../lib/theme';

export default function Header({ title, right }) {
  return (
    <div style={{
      background: theme.green, color: '#FFFFFF', padding: '16px 20px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'sticky', top: 0, zIndex: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    }}>
      <strong style={{ fontSize: 16, letterSpacing: 0.5 }}>{title}</strong>
      <div>{right}</div>
    </div>
  );
}
