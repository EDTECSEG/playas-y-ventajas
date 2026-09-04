'use client';

import { useEffect, useState } from 'react';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
      setInstalled(true);
    }
    const handler = (e) => { e.preventDefault(); setDeferredPrompt(e); };
    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', () => setInstalled(true));
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  if (installed) return null;

  const isIos = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

  async function handleClick() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      return;
    }
    if (isIos) { setShowIosHelp(true); return; }
    setShowIosHelp(true); // fallback generico se o navegador nao suportar o prompt automatico
  }

  return (
    <div style={{ background: '#F2C14E', color: '#0B6E4F', padding: '8px 16px', textAlign: 'center', fontSize: 13, fontWeight: 600 }}>
      📲 <button onClick={handleClick} style={{ background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', color: '#0B6E4F', fontWeight: 700, fontSize: 13 }}>
        Instalar app no celular
      </button>
      {showIosHelp && (
        <div style={{ marginTop: 6, fontWeight: 400 }}>
          {isIos
            ? 'No Safari: toque no ícone de Compartilhar (□↑) e depois em "Adicionar à Tela de Início".'
            : 'No menu do navegador (⋮), toque em "Instalar app" ou "Adicionar à tela inicial".'}
          {' '}
          <button onClick={() => setShowIosHelp(false)} style={{ background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', color: '#0B6E4F' }}>fechar</button>
        </div>
      )}
    </div>
  );
}
