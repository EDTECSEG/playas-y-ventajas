export const ADMIN_MODULES_PATH = '/admin/modulos';

export const ADMIN_ORIGIN_KEY = 'pyv_admin_origin';
export const ADMIN_ORIGIN_VALUE = 'admin-modulos';
// Sessão do admin vive SÓ em memória (não em sessionStorage): sobrevive à
// navegação entre telas, mas um reload/F5 volta para o login.
export const ADMIN_SESSION_GLOBAL = '__pyvAdminSession';

export const ADMIN_MODULES = [
  { id: 'cliente', href: '/cliente', icon: '🏖️', titleKey: 'client', subKey: 'clientSub' },
  { id: 'empresa', href: '/empresa', icon: '🏢', titleKey: 'business', subKey: 'businessSub' },
  { id: 'motorista', href: '/motorista', icon: '🚗', titleKey: 'motoristaTitle', subKey: 'motoristaSub' },
  { id: 'afiliado', href: '/afiliado', icon: '🤝', titleKey: 'affiliateTitle', subKey: 'affiliateSub' },
  { id: 'admin', href: '/admin', icon: '🛠️', titleKey: 'admin', subKey: 'adminSub' },
];

export function isAdminRole(role) {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

export function markAdminModulesOrigin() {
  try {
    window.sessionStorage.setItem(ADMIN_ORIGIN_KEY, ADMIN_ORIGIN_VALUE);
  } catch (e) {
    // sessionStorage indisponível: o botão Volver simplesmente não aparece
  }
}

export function consumeAdminModulesOrigin() {
  try {
    const value = window.sessionStorage.getItem(ADMIN_ORIGIN_KEY);
    window.sessionStorage.removeItem(ADMIN_ORIGIN_KEY);
    return value === ADMIN_ORIGIN_VALUE;
  } catch (e) {
    return false;
  }
}

export function saveAdminSession(data) {
  if (typeof window === 'undefined') return;
  window[ADMIN_SESSION_GLOBAL] = data || null;
}

export function loadAdminSession() {
  if (typeof window === 'undefined') return null;
  return window[ADMIN_SESSION_GLOBAL] || null;
}

export function clearAdminSession() {
  if (typeof window === 'undefined') return;
  window[ADMIN_SESSION_GLOBAL] = null;
}
