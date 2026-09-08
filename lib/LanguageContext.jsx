'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { getTranslations } from './i18n';

const LanguageContext = createContext({ lang: 'pt', setLang: () => {}, t: getTranslations('pt') });

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState('pt');

  useEffect(() => {
    const saved = localStorage.getItem('pyv_lang');
    if (saved) setLangState(saved);
  }, []);

  function setLang(l) {
    setLangState(l);
    localStorage.setItem('pyv_lang', l);
  }

  return (
    <LanguageContext.Provider value={{ lang, setLang, t: getTranslations(lang) }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
