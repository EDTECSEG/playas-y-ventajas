// Service worker minimo - necessario para o Chrome considerar o site "instalavel" (PWA).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', () => {}); // no-op, sem cache customizado por enquanto
