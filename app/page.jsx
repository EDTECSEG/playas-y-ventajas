'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { theme } from '../lib/theme';
import ModuleSplash from './components/ModuleSplash';
import LanguageMenu from './components/LanguageMenu';

const REF_RE = /^[A-Za-z0-9-]{1,32}$/;

export function captureReferralParam() {
  try {
    const ref = new URLSearchParams(window.location.search).get('ref');
    if (ref && REF_RE.test(ref)) {
      window.localStorage.setItem('pyv_ref', ref);
      return true;
    }
  } catch (e) { /* ambiente sem localStorage segue normal */ }
  return false;
}

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    // Guarda o ?ref= antes do redirect, para o fluxo de afiliado sobreviver
    // ao redirect da splash. O claim/identify do /cliente consomem depois.
    captureReferralParam();
  }, []);

  return (
    <main style={{ position: 'relative', minHeight: '100vh', background: theme.bg }}>
      <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 30 }}>
        <LanguageMenu />
      </div>
      <ModuleSplash onDone={() => router.replace('/cliente')} />
    </main>
  );
}