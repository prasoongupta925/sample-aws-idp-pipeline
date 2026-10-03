// "How to get your free credit report": a help page for the DSA's customers,
// in English, Hindi and Marathi. Only well-known facts and the four credit
// bureaus' main sites; no menu or button names, which the bureaus' sites
// change. Rendered by ../components/CreditReportGuide at
// CREDIT_REPORT_HELP_PATH; linked from the eligibility page's CIBIL tab, and
// meant for the customer upload page too (creditReportHelpHref).

export const GUIDE_LANGS = ['en', 'hi', 'mr'] as const;
export type GuideLang = (typeof GUIDE_LANGS)[number];

/** Each language in its own script, for the language switch. */
export const GUIDE_LANG_NAMES: Record<GuideLang, string> = {
  en: 'English',
  hi: 'हिन्दी',
  mr: 'मराठी',
};

/** Route of the help page (routes/help/credit-report.tsx). */
export const CREDIT_REPORT_HELP_PATH = '/help/credit-report';

/** A guide language, else English. */
export function parseGuideLang(value: unknown): GuideLang {
  return GUIDE_LANGS.includes(value as GuideLang) ? (value as GuideLang) : 'en';
}

/** Link to the help page in a language (English by default). */
export function creditReportHelpHref(lang: GuideLang = 'en'): string {
  return lang === 'en'
    ? CREDIT_REPORT_HELP_PATH
    : `${CREDIT_REPORT_HELP_PATH}?lang=${lang}`;
}

export interface CreditBureau {
  name: string;
  /** The main site, as shown. */
  site: string;
  url: string;
}

/** The four credit bureaus in India, with their main sites only. */
export const CREDIT_BUREAUS: readonly CreditBureau[] = [
  {
    name: 'TransUnion CIBIL',
    site: 'cibil.com',
    url: 'https://www.cibil.com/',
  },
  { name: 'Experian', site: 'experian.in', url: 'https://www.experian.in/' },
  {
    name: 'Equifax',
    site: 'equifax.co.in',
    url: 'https://www.equifax.co.in/',
  },
  {
    name: 'CRIF High Mark',
    site: 'crifhighmark.com',
    url: 'https://www.crifhighmark.com/',
  },
];

export interface CreditReportGuideText {
  title: string;
  intro: string;
  factsTitle: string;
  facts: string[];
  stepsTitle: string;
  steps: string[];
  bureausTitle: string;
  cautionsTitle: string;
  cautions: string[];
  /** Accessible name of the language switch. */
  languageLabel: string;
}

export const CREDIT_REPORT_GUIDE: Record<GuideLang, CreditReportGuideText> = {
  en: {
    title: 'How to get your free credit report',
    intro:
      'Your credit report lists your loans and credit cards, how you have repaid them, and your credit score. Banks and lenders read it before they approve a loan.',
    factsTitle: 'Good to know',
    facts: [
      'Every person can get one free full credit report every year from each credit bureau: TransUnion CIBIL, Experian, Equifax and CRIF High Mark.',
      'Checking your own credit report does not lower your credit score.',
      'As your loan agent (DSA), we cannot pull your credit report ourselves. Please download it yourself and upload it through the link we sent you.',
    ],
    stepsTitle: 'Steps',
    steps: [
      'Open the website of one credit bureau from the list below. Type the address yourself; do not open links from unknown messages.',
      'Find the free yearly credit report on the site and sign up with your details: name, mobile number, email and an ID such as your PAN.',
      'Confirm your identity with the OTP sent to your mobile number.',
      'Download or save the full report as a PDF.',
      'Upload the PDF through the upload link we sent you. If the PDF opens only with a password, keep it ready: the upload page asks for it.',
    ],
    bureausTitle: 'Credit bureau websites',
    cautionsTitle: 'Be careful',
    cautions: [
      'A bureau site may also offer paid plans. You do not need one: the free yearly report is enough for your loan file.',
      'Never tell anyone an OTP, not even us: we never ask for it on a call or in a message.',
    ],
    languageLabel: 'Language',
  },
  hi: {
    title: 'अपनी मुफ़्त क्रेडिट रिपोर्ट कैसे पाएँ',
    intro:
      'क्रेडिट रिपोर्ट में आपके लोन और क्रेडिट कार्ड, उनका भुगतान कैसे हुआ, और आपका क्रेडिट स्कोर होता है। लोन मंज़ूर करने से पहले बैंक और लोन कंपनियाँ इसे देखती हैं।',
    factsTitle: 'जानने लायक बातें',
    facts: [
      'हर व्यक्ति हर क्रेडिट ब्यूरो से साल में एक बार अपनी पूरी क्रेडिट रिपोर्ट मुफ़्त ले सकता है: TransUnion CIBIL, Experian, Equifax और CRIF High Mark।',
      'अपनी क्रेडिट रिपोर्ट खुद देखने से आपका क्रेडिट स्कोर कम नहीं होता।',
      'आपके लोन एजेंट (DSA) के रूप में हम आपकी क्रेडिट रिपोर्ट खुद नहीं निकाल सकते। कृपया रिपोर्ट खुद डाउनलोड करें और हमारे भेजे लिंक से अपलोड करें।',
    ],
    stepsTitle: 'तरीका',
    steps: [
      'नीचे दी गई सूची से किसी एक क्रेडिट ब्यूरो की वेबसाइट खोलें। पता खुद टाइप करें; अनजान मैसेज में आए लिंक न खोलें।',
      'वेबसाइट पर साल की मुफ़्त क्रेडिट रिपोर्ट ढूँढें और अपनी जानकारी से साइन अप करें: नाम, मोबाइल नंबर, ईमेल और PAN जैसा कोई पहचान पत्र।',
      'अपने मोबाइल नंबर पर आया OTP डालकर अपनी पहचान की पुष्टि करें।',
      'पूरी रिपोर्ट PDF के रूप में डाउनलोड या सेव करें।',
      'यह PDF हमारे भेजे अपलोड लिंक से अपलोड करें। अगर PDF पासवर्ड से खुलती है, तो पासवर्ड तैयार रखें: अपलोड पेज उसे पूछेगा।',
    ],
    bureausTitle: 'क्रेडिट ब्यूरो की वेबसाइटें',
    cautionsTitle: 'सावधान रहें',
    cautions: [
      'ब्यूरो की वेबसाइट पर पैसे वाले प्लान भी दिख सकते हैं। आपको उनकी ज़रूरत नहीं है: आपकी लोन फ़ाइल के लिए साल की मुफ़्त रिपोर्ट काफ़ी है।',
      'OTP किसी को न बताएँ, हमें भी नहीं: हम कॉल या मैसेज पर कभी OTP नहीं माँगते।',
    ],
    languageLabel: 'भाषा',
  },
  mr: {
    title: 'तुमचा मोफत क्रेडिट रिपोर्ट कसा मिळवायचा',
    intro:
      'क्रेडिट रिपोर्टमध्ये तुमची कर्जे आणि क्रेडिट कार्ड, त्यांची परतफेड कशी झाली आणि तुमचा क्रेडिट स्कोअर असतो. कर्ज मंजूर करण्यापूर्वी बँका आणि कर्ज देणाऱ्या संस्था तो पाहतात.',
    factsTitle: 'हे लक्षात ठेवा',
    facts: [
      'प्रत्येक व्यक्तीला प्रत्येक क्रेडिट ब्युरोकडून वर्षातून एकदा संपूर्ण क्रेडिट रिपोर्ट मोफत मिळू शकतो: TransUnion CIBIL, Experian, Equifax आणि CRIF High Mark.',
      'स्वतःचा क्रेडिट रिपोर्ट स्वतः पाहिल्याने तुमचा क्रेडिट स्कोअर कमी होत नाही.',
      'तुमचे कर्ज एजंट (DSA) म्हणून आम्ही तुमचा क्रेडिट रिपोर्ट स्वतः काढू शकत नाही. कृपया रिपोर्ट स्वतः डाउनलोड करा आणि आम्ही पाठवलेल्या लिंकवरून अपलोड करा.',
    ],
    stepsTitle: 'पायऱ्या',
    steps: [
      'खालील यादीतील कोणत्याही एका क्रेडिट ब्युरोची वेबसाइट उघडा. पत्ता स्वतः टाइप करा; अनोळखी मेसेजमधील लिंक उघडू नका.',
      'वेबसाइटवर वर्षाचा मोफत क्रेडिट रिपोर्ट शोधा आणि तुमची माहिती भरून साइन अप करा: नाव, मोबाइल नंबर, ईमेल आणि PAN सारखे ओळखपत्र.',
      'तुमच्या मोबाइल नंबरवर आलेला OTP टाकून तुमची ओळख पटवा.',
      'संपूर्ण रिपोर्ट PDF स्वरूपात डाउनलोड किंवा सेव्ह करा.',
      'ही PDF आम्ही पाठवलेल्या अपलोड लिंकवरून अपलोड करा. PDF पासवर्डने उघडत असेल तर पासवर्ड तयार ठेवा: अपलोड पेज तो विचारेल.',
    ],
    bureausTitle: 'क्रेडिट ब्युरोच्या वेबसाइट्स',
    cautionsTitle: 'काळजी घ्या',
    cautions: [
      'ब्युरोच्या वेबसाइटवर पैसे भरून घ्यायचे प्लॅनही दिसू शकतात. तुम्हाला त्यांची गरज नाही: तुमच्या कर्ज फाइलसाठी वर्षाचा मोफत रिपोर्ट पुरेसा आहे.',
      'OTP कोणालाही सांगू नका, आम्हालाही नाही: आम्ही कॉल किंवा मेसेजवर कधीही OTP मागत नाही.',
    ],
    languageLabel: 'भाषा',
  },
};
