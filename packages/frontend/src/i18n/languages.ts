/** UI languages. The app ships English only; customer-facing Hindi and
 * Marathi text (reminders, voice) lives with those features, not here. */
export const SUPPORTED_LANGS = ['en'] as const;

export type UiLanguage = (typeof SUPPORTED_LANGS)[number];

export const DEFAULT_LANG: UiLanguage = 'en';

/** Maps a stored or browser language to a supported one. A value left over
 * from an older build (for example 'ko' or 'ja') falls back to English. */
export function resolveLanguage(lang: string | null | undefined): UiLanguage {
  const base = (lang ?? '').split('-')[0].toLowerCase();
  return (SUPPORTED_LANGS as readonly string[]).includes(base)
    ? (base as UiLanguage)
    : DEFAULT_LANG;
}
