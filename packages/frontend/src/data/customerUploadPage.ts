// Text of the customer's upload page (/u#<token>), in the link's three
// languages. The page has no login and no app i18n (staff locales are
// en/ko/ja), so its strings live here, like the reminder templates.
// {{name}} placeholders are filled by pageText().
import type { UploadLinkLanguage } from './customerUpload';

/**
 * Version of the consent text below. It must equal CONSENT_VERSION of the
 * backend (app/upload_links.py): the consent call is refused otherwise.
 * Change both when the consent wording changes.
 */
export const CONSENT_VERSION = '2026-10-v1';

export const PAGE_LANGUAGE_NAMES: Record<UploadLinkLanguage, string> = {
  en: 'English',
  hi: 'हिन्दी',
  mr: 'मराठी',
};

export interface CustomerPageText {
  title: string;
  requestedBy: string;
  requestedList: string;
  validTill: string;
  loading: string;
  reopenTitle: string;
  reopenBody: string;
  invalidTitle: string;
  invalidBody: string;
  errorBody: string;
  retry: string;
  consentTitle: string;
  consentPurpose: string;
  consentWho: string;
  consentDeletion: string;
  consentWithdraw: string;
  consentCheckbox: string;
  consentContinue: string;
  consentReload: string;
  uploadTitle: string;
  takePhoto: string;
  chooseFiles: string;
  limits: string;
  filesLeft: string;
  noSlotsLeft: string;
  statusChecking: string;
  statusUploading: string;
  statusReceived: string;
  statusNotReceived: string;
  statusFailed: string;
  statusPassword: string;
  rejectType: string;
  rejectSize: string;
  rejectCount: string;
  rejectServer: string;
  passwordLabel: string;
  passwordHint: string;
  unlock: string;
  unlocking: string;
  wrongPassword: string;
  tooManyAttempts: string;
  unlockFailed: string;
  submit: string;
  submitHint: string;
  submitPasswordWarning: string;
  submitting: string;
  submitFailed: string;
  submittedTitle: string;
  submittedBody: string;
}

export const CUSTOMER_PAGE_TEXT: Record<UploadLinkLanguage, CustomerPageText> =
  {
    en: {
      title: 'Upload your documents',
      requestedBy: '{{dsa}} has asked you for these documents:',
      requestedList: 'Documents requested',
      validTill: 'This link works till {{date}}.',
      loading: 'Opening your secure link…',
      reopenTitle: 'Open your link again',
      reopenBody:
        'For your safety this page does not keep your link. Open it again from the message your loan advisor sent you (SMS or WhatsApp).',
      invalidTitle: 'This link does not work any more',
      invalidBody:
        'It has expired, was already submitted, or was cancelled. Ask your loan advisor for a new link.',
      errorBody:
        'Something went wrong. Check your internet connection and try again.',
      retry: 'Try again',
      consentTitle: 'Your consent',
      consentPurpose:
        'Purpose: {{dsa}} will use the documents you upload here only to check and process your loan application.',
      consentWho:
        'Who sees them: only {{dsa}} and its staff working on your application. The files are stored and processed on Amazon Web Services servers in Mumbai, India.',
      consentDeletion:
        'Deletion: your files are deleted automatically within 7 days.',
      consentWithdraw:
        'Withdrawing: you can withdraw your consent at any time by telling {{dsa}}. Your files are then deleted.',
      consentCheckbox:
        'I have read this and I agree that {{dsa}} may use my documents for my loan application.',
      consentContinue: 'Agree and continue',
      consentReload:
        'This page is out of date. Reload it to see the current text.',
      uploadTitle: 'Add your documents',
      takePhoto: 'Take a photo',
      chooseFiles: 'Choose files',
      limits:
        'PDF files or photos (JPG, PNG, WebP), up to {{mb}} MB each, at most {{max}} files.',
      filesLeft: 'You can add {{count}} more file(s).',
      noSlotsLeft: 'No more files can be added to this link.',
      statusChecking: 'Checking…',
      statusUploading: 'Uploading {{percent}}%',
      statusReceived: 'Received',
      statusNotReceived: 'Not received. Please add it again.',
      statusFailed: 'Upload failed. Please add it again.',
      statusPassword: 'Password needed',
      rejectType: 'Only PDF files and photos (JPG, PNG, WebP) can be added.',
      rejectSize: 'This file is larger than {{mb}} MB.',
      rejectCount: 'No more files can be added to this link.',
      rejectServer: 'This file could not be added.',
      passwordLabel: 'PDF password',
      passwordHint:
        'This PDF is protected with a password (bank statements often are). Enter it so your advisor can read the file. The password is used once and never stored.',
      unlock: 'Unlock',
      unlocking: 'Unlocking…',
      wrongPassword: 'Wrong password. {{left}} tries left.',
      tooManyAttempts:
        'Too many tries. Your loan advisor will ask you for the password.',
      unlockFailed: 'The file could not be unlocked. Please try again.',
      submit: 'Submit documents',
      submitHint: 'After you submit, this link stops working.',
      submitPasswordWarning:
        'Some PDFs still need a password. You can submit anyway: your advisor will ask you for it.',
      submitting: 'Submitting…',
      submitFailed: 'Could not submit. Please try again.',
      submittedTitle: 'Thank you!',
      submittedBody:
        '{{count}} file(s) sent to {{dsa}}. You can close this page.',
    },
    hi: {
      title: 'अपने दस्तावेज़ upload करें',
      requestedBy: '{{dsa}} ने आपसे ये दस्तावेज़ माँगे हैं:',
      requestedList: 'माँगे गए दस्तावेज़',
      validTill: 'यह link {{date}} तक चलेगा।',
      loading: 'आपका सुरक्षित link खुल रहा है…',
      reopenTitle: 'अपना link फिर से खोलें',
      reopenBody:
        'आपकी सुरक्षा के लिए यह page आपका link याद नहीं रखता। आपके loan advisor ने जो message (SMS या WhatsApp) भेजा है, उसी से link फिर से खोलें।',
      invalidTitle: 'यह link अब काम नहीं करता',
      invalidBody:
        'इसकी समय-सीमा खत्म हो गई है, यह पहले ही submit हो चुका है, या रद्द कर दिया गया है। अपने loan advisor से नया link माँगें।',
      errorBody: 'कुछ गड़बड़ हुई। अपना internet देखें और फिर से कोशिश करें।',
      retry: 'फिर से कोशिश करें',
      consentTitle: 'आपकी सहमति',
      consentPurpose:
        'उद्देश्य: {{dsa}} यहाँ upload किए गए दस्तावेज़ों का उपयोग केवल आपके loan आवेदन की जाँच और प्रक्रिया के लिए करेगा।',
      consentWho:
        'कौन देखेगा: केवल {{dsa}} और आपके आवेदन पर काम करने वाला उसका स्टाफ़। फ़ाइलें मुंबई, भारत में Amazon Web Services के servers पर रखी और process की जाती हैं।',
      consentDeletion:
        'हटाना: आपकी फ़ाइलें 7 दिनों के अंदर अपने-आप हटा दी जाती हैं।',
      consentWithdraw:
        'सहमति वापस लेना: आप कभी भी {{dsa}} को बताकर अपनी सहमति वापस ले सकते हैं। तब आपकी फ़ाइलें हटा दी जाती हैं।',
      consentCheckbox:
        'मैंने यह पढ़ लिया है और मैं सहमत हूँ कि {{dsa}} मेरे loan आवेदन के लिए मेरे दस्तावेज़ों का उपयोग कर सकता है।',
      consentContinue: 'सहमत हूँ, आगे बढ़ें',
      consentReload:
        'यह page पुराना है। नया text देखने के लिए इसे reload करें।',
      uploadTitle: 'अपने दस्तावेज़ जोड़ें',
      takePhoto: 'फ़ोटो लें',
      chooseFiles: 'फ़ाइलें चुनें',
      limits:
        'PDF फ़ाइलें या फ़ोटो (JPG, PNG, WebP), हर एक {{mb}} MB तक, ज़्यादा से ज़्यादा {{max}} फ़ाइलें।',
      filesLeft: 'आप {{count}} और फ़ाइलें जोड़ सकते हैं।',
      noSlotsLeft: 'इस link में अब और फ़ाइलें नहीं जोड़ी जा सकतीं।',
      statusChecking: 'जाँच हो रही है…',
      statusUploading: 'Upload हो रहा है {{percent}}%',
      statusReceived: 'मिल गया',
      statusNotReceived: 'नहीं मिला। कृपया फिर से जोड़ें।',
      statusFailed: 'Upload नहीं हुआ। कृपया फिर से जोड़ें।',
      statusPassword: 'Password चाहिए',
      rejectType:
        'केवल PDF फ़ाइलें और फ़ोटो (JPG, PNG, WebP) जोड़ी जा सकती हैं।',
      rejectSize: 'यह फ़ाइल {{mb}} MB से बड़ी है।',
      rejectCount: 'इस link में अब और फ़ाइलें नहीं जोड़ी जा सकतीं।',
      rejectServer: 'यह फ़ाइल नहीं जोड़ी जा सकी।',
      passwordLabel: 'PDF password',
      passwordHint:
        'यह PDF password से सुरक्षित है (bank statement अक्सर होते हैं)। इसे डालें ताकि आपका advisor फ़ाइल पढ़ सके। Password एक बार उपयोग होता है और कभी रखा नहीं जाता।',
      unlock: 'Unlock करें',
      unlocking: 'Unlock हो रहा है…',
      wrongPassword: 'गलत password। {{left}} कोशिशें बाकी।',
      tooManyAttempts:
        'बहुत ज़्यादा कोशिशें। आपका loan advisor आपसे password माँगेगा।',
      unlockFailed: 'फ़ाइल unlock नहीं हो सकी। कृपया फिर से कोशिश करें।',
      submit: 'दस्तावेज़ submit करें',
      submitHint: 'Submit करने के बाद यह link काम करना बंद कर देगा।',
      submitPasswordWarning:
        'कुछ PDF को अभी भी password चाहिए। आप फिर भी submit कर सकते हैं: आपका advisor आपसे password माँगेगा।',
      submitting: 'Submit हो रहा है…',
      submitFailed: 'Submit नहीं हो सका। कृपया फिर से कोशिश करें।',
      submittedTitle: 'धन्यवाद!',
      submittedBody:
        '{{count}} फ़ाइलें {{dsa}} को भेज दी गईं। आप यह page बंद कर सकते हैं।',
    },
    mr: {
      title: 'तुमची कागदपत्रे अपलोड करा',
      requestedBy: '{{dsa}} यांनी तुमच्याकडे ही कागदपत्रे मागितली आहेत:',
      requestedList: 'मागितलेली कागदपत्रे',
      validTill: 'ही लिंक {{date}} पर्यंत चालेल.',
      loading: 'तुमची सुरक्षित लिंक उघडत आहे…',
      reopenTitle: 'तुमची लिंक पुन्हा उघडा',
      reopenBody:
        'तुमच्या सुरक्षिततेसाठी हे पेज तुमची लिंक लक्षात ठेवत नाही. तुमच्या लोन सल्लागाराने पाठवलेल्या मेसेजमधून (SMS किंवा WhatsApp) लिंक पुन्हा उघडा.',
      invalidTitle: 'ही लिंक आता चालत नाही',
      invalidBody:
        'तिची मुदत संपली आहे, ती आधीच सबमिट झाली आहे किंवा रद्द केली आहे. तुमच्या लोन सल्लागाराकडे नवी लिंक मागा.',
      errorBody: 'काहीतरी चुकले. तुमचे इंटरनेट तपासा आणि पुन्हा प्रयत्न करा.',
      retry: 'पुन्हा प्रयत्न करा',
      consentTitle: 'तुमची संमती',
      consentPurpose:
        'उद्देश: {{dsa}} इथे अपलोड केलेली कागदपत्रे फक्त तुमच्या कर्ज अर्जाची तपासणी आणि प्रक्रिया करण्यासाठी वापरतील.',
      consentWho:
        'कोण पाहील: फक्त {{dsa}} आणि तुमच्या अर्जावर काम करणारे त्यांचे कर्मचारी. फाइल्स मुंबई, भारत येथील Amazon Web Services च्या सर्व्हरवर ठेवल्या आणि प्रक्रिया केल्या जातात.',
      consentDeletion:
        'हटवणे: तुमच्या फाइल्स 7 दिवसांच्या आत आपोआप हटवल्या जातात.',
      consentWithdraw:
        'संमती मागे घेणे: तुम्ही कधीही {{dsa}} यांना सांगून तुमची संमती मागे घेऊ शकता. मग तुमच्या फाइल्स हटवल्या जातात.',
      consentCheckbox:
        'मी हे वाचले आहे आणि {{dsa}} माझ्या कर्ज अर्जासाठी माझी कागदपत्रे वापरू शकतात याला मी संमती देतो/देते.',
      consentContinue: 'संमती देऊन पुढे जा',
      consentReload: 'हे पेज जुने आहे. सध्याचा मजकूर पाहण्यासाठी ते रीलोड करा.',
      uploadTitle: 'तुमची कागदपत्रे जोडा',
      takePhoto: 'फोटो काढा',
      chooseFiles: 'फाइल्स निवडा',
      limits:
        'PDF फाइल्स किंवा फोटो (JPG, PNG, WebP), प्रत्येकी {{mb}} MB पर्यंत, जास्तीत जास्त {{max}} फाइल्स.',
      filesLeft: 'तुम्ही आणखी {{count}} फाइल्स जोडू शकता.',
      noSlotsLeft: 'या लिंकमध्ये आणखी फाइल्स जोडता येत नाहीत.',
      statusChecking: 'तपासत आहे…',
      statusUploading: 'अपलोड होत आहे {{percent}}%',
      statusReceived: 'मिळाले',
      statusNotReceived: 'मिळाले नाही. कृपया पुन्हा जोडा.',
      statusFailed: 'अपलोड झाले नाही. कृपया पुन्हा जोडा.',
      statusPassword: 'पासवर्ड हवा',
      rejectType: 'फक्त PDF फाइल्स आणि फोटो (JPG, PNG, WebP) जोडता येतात.',
      rejectSize: 'ही फाइल {{mb}} MB पेक्षा मोठी आहे.',
      rejectCount: 'या लिंकमध्ये आणखी फाइल्स जोडता येत नाहीत.',
      rejectServer: 'ही फाइल जोडता आली नाही.',
      passwordLabel: 'PDF पासवर्ड',
      passwordHint:
        'ही PDF पासवर्डने सुरक्षित आहे (बँक स्टेटमेंट बहुतेक असतात). तुमच्या सल्लागाराला फाइल वाचता यावी म्हणून तो टाका. पासवर्ड एकदाच वापरला जातो आणि कधीही ठेवला जात नाही.',
      unlock: 'अनलॉक करा',
      unlocking: 'अनलॉक होत आहे…',
      wrongPassword: 'चुकीचा पासवर्ड. {{left}} प्रयत्न बाकी.',
      tooManyAttempts:
        'खूप प्रयत्न झाले. तुमचे लोन सल्लागार तुमच्याकडे पासवर्ड मागतील.',
      unlockFailed: 'फाइल अनलॉक झाली नाही. कृपया पुन्हा प्रयत्न करा.',
      submit: 'कागदपत्रे सबमिट करा',
      submitHint: 'सबमिट केल्यानंतर ही लिंक चालणे बंद होईल.',
      submitPasswordWarning:
        'काही PDF ना अजूनही पासवर्ड हवा आहे. तरीही तुम्ही सबमिट करू शकता: तुमचे सल्लागार तुमच्याकडे तो मागतील.',
      submitting: 'सबमिट होत आहे…',
      submitFailed: 'सबमिट झाले नाही. कृपया पुन्हा प्रयत्न करा.',
      submittedTitle: 'धन्यवाद!',
      submittedBody:
        '{{count}} फाइल्स {{dsa}} यांना पाठवल्या. तुम्ही हे पेज बंद करू शकता.',
    },
  };

/** One string of the page with its {{placeholders}} filled. */
export function pageText(
  language: UploadLinkLanguage,
  key: keyof CustomerPageText,
  vars: Record<string, string | number> = {},
): string {
  const template =
    CUSTOMER_PAGE_TEXT[language]?.[key] ?? CUSTOMER_PAGE_TEXT.en[key];
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
