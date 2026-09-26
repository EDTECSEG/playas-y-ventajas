'use client';

import { useEffect, useState } from 'react';

export default function ModuleSplash({ visible = true, onDone, duration = 1600 }) {
  const [animated, setAnimated] = useState(false);
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setFaded(false);
    const t1 = setTimeout(() => setAnimated(true), 80);
    const t2 = setTimeout(() => setFaded(true), duration);
    const t3 = setTimeout(() => { onDone?.(); }, duration + 500);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [visible]);

  if (!visible) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#FFFFFF', zIndex: 20,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      opacity: faded ? 0 : 1, transition: 'opacity 0.5s ease',
    }}>
      <img
        src="/logo.png" alt="Playas y Ventajas"
        style={{
          width: 200, height: 200,
          transform: animated ? 'scale(1)' : 'scale(0.7)',
          opacity: animated ? 1 : 0,
          transition: 'transform 0.6s cubic-bezier(0.34,1.56,0.64,1), opacity 0.6s ease',
        }}
      />
    </div>
  );
}