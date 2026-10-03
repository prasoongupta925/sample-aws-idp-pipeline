// Customer upload links: what staff can request and how each request is
// named to the customer (en / hi / mr). The backend accepts any code of
// [A-Z0-9_]{1,40} (app/upload_links.py ITEM_CODE_PATTERN); the codes below
// are the ones the web app names. OTHER is named by its note.
import {
  REMINDER_DOC_NAMES,
  REMINDER_LANGUAGES,
  type ReminderDocCode,
  type ReminderLanguage,
} from './reminderTemplates';

export type UploadLinkLanguage = ReminderLanguage;
export const UPLOAD_LINK_LANGUAGES = REMINDER_LANGUAGES;

export type UploadItemCode = ReminderDocCode | 'CREDIT_REPORT' | 'OTHER';

/** The picker's order. */
export const UPLOAD_ITEM_CODES: UploadItemCode[] = [
  'PAN_COPY',
  'AADHAAR_MASKED',
  'SALARY_SLIP',
  'BANK_STATEMENT',
  'FORM16_ITR',
  'APPLICATION_FORM',
  'ADDRESS_PROOF',
  'EMPLOYMENT_PROOF',
  'GST_RETURNS',
  'CREDIT_REPORT',
  'OTHER',
];

const EXTRA_NAMES: Record<
  'CREDIT_REPORT' | 'OTHER',
  Record<UploadLinkLanguage, string>
> = {
  CREDIT_REPORT: {
    en: 'credit report (free copy from a credit bureau)',
    hi: 'credit report (credit bureau से मुफ़्त copy)',
    mr: 'क्रेडिट रिपोर्ट (क्रेडिट ब्युरोकडून मोफत प्रत)',
  },
  OTHER: { en: 'other document', hi: 'अन्य document', mr: 'इतर कागदपत्र' },
};

/** The customer-facing name of a requested item; unknown codes show as OTHER. */
export function uploadItemName(
  code: string,
  language: UploadLinkLanguage,
): string {
  if (code in REMINDER_DOC_NAMES) {
    return REMINDER_DOC_NAMES[code as ReminderDocCode].whatsapp[language];
  }
  if (code === 'CREDIT_REPORT') return EXTRA_NAMES.CREDIT_REPORT[language];
  return EXTRA_NAMES.OTHER[language];
}

// Limits of app/upload_links.py (the backend enforces them).
export const UPLOAD_LINK_DEFAULT_HOURS = 72;
export const UPLOAD_LINK_MAX_HOURS = 7 * 24;
export const UPLOAD_LINK_MAX_ITEMS = 20;
export const UPLOAD_LINK_MAX_NOTE = 120;
export const UPLOAD_LINK_MAX_FILES = 20;
export const UPLOAD_LINK_MAX_FILE_MB = 15;

/** Expiry choices in hours (UPLOAD_LINK_DEFAULT_HOURS preselected). */
export const UPLOAD_LINK_EXPIRY_HOURS = [24, 48, 72, 120, 168];

/** The ready-made message sent with the link ({{...}} filled by lib/uploadLinks). */
export const UPLOAD_LINK_MESSAGES: Record<UploadLinkLanguage, string> = {
  en: 'Hi, this is {{dsa_name}}. For your loan application please upload: {{documents}}. Use this secure link (no app or login needed): {{link}} It works till {{expiry}}.',
  hi: 'नमस्ते, {{dsa_name}} की ओर से। आपके loan आवेदन के लिए कृपया upload करें: {{documents}}। यह सुरक्षित link खोलें (कोई app या login नहीं चाहिए): {{link}} यह {{expiry}} तक चलेगा।',
  mr: 'नमस्कार, {{dsa_name}} कडून. तुमच्या कर्ज अर्जासाठी कृपया अपलोड करा: {{documents}}. ही सुरक्षित लिंक उघडा (कोणतेही app किंवा login नको): {{link}} ती {{expiry}} पर्यंत चालेल.',
};
