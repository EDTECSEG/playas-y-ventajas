'use client';

import { useState } from 'react';
import { theme } from '../../lib/theme';

export default function PasswordInput({ style, ...props }) {
  const [show, setShow] = useState(false);
  const { marginRight, marginBottom, ...rest } = style || {};
  const inputStyle = { ...rest, paddingRight: 36, boxSizing: 'border-box' };
  return (
    <span style={{ position: 'relative', display: 'inline-block', verticalAlign: 'middle', marginRight, marginBottom }}>
      <input {...props} type={show ? 'text' : 'password'} style={inputStyle} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
        title={show ? 'Ocultar senha' : 'Mostrar senha'}
        style={{
          position: 'absolute', top: 0, right: 0, height: '100%', width: 34,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: 15, lineHeight: 1, color: theme.textMuted,
        }}
      >
        {show ? '🙈' : '👁'}
      </button>
    </span>
  );
}
