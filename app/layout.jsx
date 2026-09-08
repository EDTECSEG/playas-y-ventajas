export const metadata = {
  title: 'Playas y Ventajas',
  description: 'Plataforma de cupons, benefícios e experiências',
  manifest: '/manifest.json',
};

export const viewport = {
  themeColor: '#0B6E4F',
};

import InstallPrompt from './components/InstallPrompt';
import { LanguageProvider } from '../lib/LanguageContext';

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#0B6E4F' }}>
        <LanguageProvider>
          <InstallPrompt />
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
