import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import { DEFAULT_LANG, resolveLanguage } from './languages';

const resources = {
  en: { translation: en },
};

const LANGUAGE_KEY = 'i18nextLng';

// Also replaces a stale 'ko' / 'ja' choice saved by an older build.
localStorage.setItem(
  LANGUAGE_KEY,
  resolveLanguage(localStorage.getItem(LANGUAGE_KEY) ?? navigator.language),
);

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LANG,
    lng: localStorage.getItem(LANGUAGE_KEY) || DEFAULT_LANG,
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage'],
      caches: ['localStorage'],
      lookupLocalStorage: LANGUAGE_KEY,
    },
  });

export default i18n;
