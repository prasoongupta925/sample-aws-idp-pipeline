// On-screen text of the voice panel in the three call languages (from the voice web app's
// src/lib/i18n.js, so both clients say the same). The panel follows the call language, not the
// app language: the caller may switch to Hindi or Marathi.

import type { CallLanguage } from './protocol';

export const LANGUAGES: readonly {
  code: CallLanguage;
  label: string;
  html: string;
}[] = Object.freeze([
  { code: 'en-IN', label: 'English', html: 'en' },
  { code: 'hi-IN', label: 'हिन्दी', html: 'hi' },
  { code: 'mr-IN', label: 'मराठी', html: 'mr' },
]);

const en = {
  title: 'Voice assistant',
  close: 'Close',
  notice: 'AI assistant · this call is recorded',
  noticeDetail:
    'The recording goes to Telecaller QA and is deleted within 7 days. Answers are indicative only; the lender decides.',
  language: 'Call language',
  call: 'Call',
  end: 'End',
  callAria: 'Start the call',
  endAria: 'End the call',
  statusIdle: 'Tap Call and speak after the greeting',
  statusAllowMic: 'Allow the microphone when the browser asks',
  statusStarting: 'Starting…',
  statusConnecting: 'Connecting…',
  statusListening: 'Listening… speak now',
  statusSpeaking: 'Assistant is speaking…',
  statusEnding: 'Ending the call…',
  resumeAudio: 'Tap to resume audio',
  captions: 'Live captions',
  you: 'You',
  assistant: 'Assistant',
  interrupted: 'interrupted',
  callEnded: 'Call ended',
  assistantEnded: 'The assistant ended the call',
  duration: 'Duration',
  postCall:
    'The recording is uploaded to Telecaller QA in Document AI and scored automatically.',
  openQa: 'Open Telecaller QA',
  headphones: 'Tip: earphones work best in a noisy place.',
  errInsecure:
    'The microphone works only on a secure page. Open this app with https://',
  errUnsupported:
    'This browser cannot run the voice assistant. Use a recent Chrome, Safari, Edge or Firefox.',
  errMicDenied:
    'The microphone is blocked. Allow the microphone for this site (lock icon in the address bar), then call again.',
  errMicMissing: 'No microphone was found on this device.',
  errMicBusy:
    'The microphone is busy in another app (for example a phone call). Close it and call again.',
  errAuth: 'Your login has expired. Sign out and sign in again.',
  errConnect:
    'Could not reach the voice assistant. Check the internet connection and call again. If it keeps failing, sign out and sign in again.',
  errRejected: 'The voice assistant refused the call: {reason}',
  errBusy:
    'The assistant is busy with other calls. Please call again in a minute.',
  errServer:
    'The assistant had a problem and ended the call. Please call again.',
  errDropped: 'The connection dropped. Please call again.',
  errAudio: 'Audio could not start on this device: {reason}',
  timeLimit: 'Calls are limited to {min} minutes, so this one was ended.',
  toolFileStatus: 'Checking the file…',
  toolEligibility: 'Working out the indicative eligibility…',
  toolReminder: 'Drafting the reminder…',
  toolSwitchLanguage: 'Switching language…',
  toolEndCall: 'Ending the call…',
  toolTransfer: 'Transferring to a telecaller…',
  toolOther: 'Looking it up…',
  cardFileStatus: 'File check',
  verdictReady: 'READY',
  verdictNotReady: 'NOT READY',
  missingTitle: 'Still missing',
  nothingMissing: 'Nothing is missing',
  mismatchesCount: '{n} detail(s) do not match: the team will clarify',
  cardEligibility: 'Indicative eligibility',
  eligibilityBest: '{amount} with {lender}',
  eligibilityNone: 'No lender is eligible on the current details',
  eligibilityNote: 'Indicative only. The lender decides.',
  cardReminder: '{channel} reminder · draft, not sent',
  reminderTeam: 'The team checks it and sends it.',
  placeholdersNote: 'Fill in before sending: {list}',
  copy: 'Copy',
  copied: 'Copied',
  languageSwitched: 'Language: {language}',
  reasonTimeCap: 'time limit reached',
  reasonSilence: 'no reply from the caller',
  reasonTransferred: 'transferred to a telecaller',
  reasonEnded: 'the conversation was complete',
};

export type StringKey = keyof typeof en;

const hi: Record<StringKey, string> = {
  title: 'वॉइस असिस्टेंट',
  close: 'बंद करें',
  notice: 'AI सहायक · यह कॉल रिकॉर्ड की जा रही है',
  noticeDetail:
    'रिकॉर्डिंग Telecaller QA में जाती है और 7 दिन के अंदर डिलीट हो जाती है। जवाब सिर्फ़ अनुमान हैं; फ़ैसला लेंडर करता है।',
  language: 'कॉल की भाषा',
  call: 'कॉल करें',
  end: 'कॉल खत्म',
  callAria: 'कॉल शुरू करें',
  endAria: 'कॉल खत्म करें',
  statusIdle: 'कॉल दबाएँ और अभिवादन के बाद बोलें',
  statusAllowMic: 'ब्राउज़र पूछे तो माइक्रोफ़ोन की अनुमति दें',
  statusStarting: 'शुरू हो रहा है…',
  statusConnecting: 'कनेक्ट हो रहा है…',
  statusListening: 'सुन रही हूँ… अब बोलिए',
  statusSpeaking: 'सहायक बोल रही है…',
  statusEnding: 'कॉल खत्म हो रही है…',
  resumeAudio: 'आवाज़ फिर से चालू करने के लिए टैप करें',
  captions: 'लाइव कैप्शन',
  you: 'आप',
  assistant: 'सहायक',
  interrupted: 'बीच में रोका',
  callEnded: 'कॉल खत्म हुई',
  assistantEnded: 'सहायक ने कॉल खत्म की',
  duration: 'अवधि',
  postCall:
    'रिकॉर्डिंग Document AI के Telecaller QA में अपलोड होती है और अपने-आप स्कोर होती है।',
  openQa: 'Telecaller QA खोलें',
  headphones: 'सुझाव: शोर वाली जगह पर ईयरफ़ोन सबसे अच्छे रहते हैं।',
  errInsecure:
    'माइक्रोफ़ोन सिर्फ़ सुरक्षित पेज पर चलता है। यह ऐप https:// से खोलें।',
  errUnsupported:
    'यह ब्राउज़र वॉइस असिस्टेंट नहीं चला सकता। नया Chrome, Safari, Edge या Firefox इस्तेमाल करें।',
  errMicDenied:
    'माइक्रोफ़ोन ब्लॉक है। इस साइट के लिए माइक्रोफ़ोन की अनुमति दें (एड्रेस बार में ताले का आइकन), फिर दोबारा कॉल करें।',
  errMicMissing: 'इस डिवाइस पर कोई माइक्रोफ़ोन नहीं मिला।',
  errMicBusy:
    'माइक्रोफ़ोन किसी दूसरे ऐप (जैसे फ़ोन कॉल) में चल रहा है। उसे बंद करके दोबारा कॉल करें।',
  errAuth: 'आपका लॉगिन खत्म हो गया है। साइन आउट करके फिर से साइन इन करें।',
  errConnect:
    'वॉइस असिस्टेंट से कनेक्ट नहीं हो पाया। इंटरनेट देखकर दोबारा कॉल करें। बार-बार ऐसा हो तो साइन आउट करके फिर से साइन इन करें।',
  errRejected: 'वॉइस असिस्टेंट ने कॉल स्वीकार नहीं की: {reason}',
  errBusy: 'सहायक अभी दूसरी कॉल पर व्यस्त है। एक मिनट बाद फिर से कॉल करें।',
  errServer:
    'असिस्टेंट में दिक्कत आई और कॉल खत्म हो गई। कृपया फिर से कॉल करें।',
  errDropped: 'कनेक्शन टूट गया। कृपया फिर से कॉल करें।',
  errAudio: 'इस डिवाइस पर आवाज़ शुरू नहीं हो पाई: {reason}',
  timeLimit:
    'एक कॉल ज़्यादा से ज़्यादा {min} मिनट की हो सकती है, इसलिए यह कॉल खत्म कर दी गई।',
  toolFileStatus: 'फ़ाइल चेक हो रही है…',
  toolEligibility: 'अनुमानित पात्रता निकाली जा रही है…',
  toolReminder: 'रिमाइंडर तैयार हो रहा है…',
  toolSwitchLanguage: 'भाषा बदल रही है…',
  toolEndCall: 'कॉल खत्म हो रही है…',
  toolTransfer: 'टेलीकॉलर को ट्रांसफ़र हो रहा है…',
  toolOther: 'जानकारी देखी जा रही है…',
  cardFileStatus: 'फ़ाइल चेक',
  verdictReady: 'तैयार',
  verdictNotReady: 'अधूरी',
  missingTitle: 'अभी बाकी',
  nothingMissing: 'कुछ बाकी नहीं है',
  mismatchesCount: '{n} जानकारी मेल नहीं खाती: टीम साफ़ करेगी',
  cardEligibility: 'अनुमानित पात्रता',
  eligibilityBest: '{lender} से {amount}',
  eligibilityNone: 'मौजूदा जानकारी पर कोई लेंडर पात्र नहीं है',
  eligibilityNote: 'सिर्फ़ अनुमान। फ़ैसला लेंडर करता है।',
  cardReminder: '{channel} रिमाइंडर · ड्राफ़्ट, भेजा नहीं गया',
  reminderTeam: 'टीम इसे देखकर भेजेगी।',
  placeholdersNote: 'भेजने से पहले भरें: {list}',
  copy: 'कॉपी',
  copied: 'कॉपी हो गया',
  languageSwitched: 'भाषा: {language}',
  reasonTimeCap: 'समय सीमा पूरी हुई',
  reasonSilence: 'कॉलर से जवाब नहीं मिला',
  reasonTransferred: 'टेलीकॉलर को ट्रांसफ़र की गई',
  reasonEnded: 'बातचीत पूरी हुई',
};

const mr: Record<StringKey, string> = {
  title: 'व्हॉइस असिस्टंट',
  close: 'बंद करा',
  notice: 'AI सहाय्यक · हा कॉल रेकॉर्ड केला जात आहे',
  noticeDetail:
    'रेकॉर्डिंग Telecaller QA मध्ये जाते आणि 7 दिवसांच्या आत डिलीट होते. उत्तरे फक्त अंदाजे आहेत; निर्णय लेंडर घेतो.',
  language: 'कॉलची भाषा',
  call: 'कॉल करा',
  end: 'कॉल संपवा',
  callAria: 'कॉल सुरू करा',
  endAria: 'कॉल संपवा',
  statusIdle: 'कॉल दाबा आणि स्वागतानंतर बोला',
  statusAllowMic: 'ब्राउझरने विचारल्यावर मायक्रोफोनला परवानगी द्या',
  statusStarting: 'सुरू होत आहे…',
  statusConnecting: 'कनेक्ट होत आहे…',
  statusListening: 'ऐकत आहे… आता बोला',
  statusSpeaking: 'सहाय्यक बोलत आहे…',
  statusEnding: 'कॉल संपत आहे…',
  resumeAudio: 'आवाज पुन्हा सुरू करण्यासाठी टॅप करा',
  captions: 'लाइव्ह कॅप्शन',
  you: 'तुम्ही',
  assistant: 'सहाय्यक',
  interrupted: 'मध्येच थांबवले',
  callEnded: 'कॉल संपला',
  assistantEnded: 'सहाय्यकाने कॉल संपवला',
  duration: 'कालावधी',
  postCall:
    'रेकॉर्डिंग Document AI मधील Telecaller QA मध्ये अपलोड होते आणि आपोआप स्कोअर होते.',
  openQa: 'Telecaller QA उघडा',
  headphones: 'सूचना: गोंगाटाच्या ठिकाणी इअरफोन सर्वात चांगले.',
  errInsecure: 'मायक्रोफोन फक्त सुरक्षित पेजवर चालतो. हे ॲप https:// ने उघडा.',
  errUnsupported:
    'या ब्राउझरमध्ये व्हॉइस असिस्टंट चालत नाही. नवीन Chrome, Safari, Edge किंवा Firefox वापरा.',
  errMicDenied:
    'मायक्रोफोन ब्लॉक आहे. या साइटसाठी मायक्रोफोनला परवानगी द्या (ॲड्रेस बारमधील कुलपाचा आयकॉन) आणि पुन्हा कॉल करा.',
  errMicMissing: 'या डिव्हाइसवर मायक्रोफोन सापडला नाही.',
  errMicBusy:
    'मायक्रोफोन दुसऱ्या ॲपमध्ये (उदा. फोन कॉल) वापरात आहे. ते बंद करून पुन्हा कॉल करा.',
  errAuth: 'तुमचे लॉगिन संपले आहे. साइन आउट करून पुन्हा साइन इन करा.',
  errConnect:
    'व्हॉइस असिस्टंटशी कनेक्ट होता आले नाही. इंटरनेट तपासून पुन्हा कॉल करा. वारंवार असे झाल्यास साइन आउट करून पुन्हा साइन इन करा.',
  errRejected: 'व्हॉइस असिस्टंटने कॉल स्वीकारला नाही: {reason}',
  errBusy:
    'सहाय्यक सध्या दुसऱ्या कॉलवर व्यस्त आहे. एका मिनिटाने पुन्हा कॉल करा.',
  errServer: 'असिस्टंटमध्ये अडचण आली आणि कॉल संपला. कृपया पुन्हा कॉल करा.',
  errDropped: 'कनेक्शन तुटले. कृपया पुन्हा कॉल करा.',
  errAudio: 'या डिव्हाइसवर आवाज सुरू होऊ शकला नाही: {reason}',
  timeLimit:
    'एक कॉल जास्तीत जास्त {min} मिनिटांचा असू शकतो, म्हणून हा कॉल संपवला.',
  toolFileStatus: 'फाइल तपासत आहे…',
  toolEligibility: 'अंदाजे पात्रता काढत आहे…',
  toolReminder: 'रिमाइंडर तयार होत आहे…',
  toolSwitchLanguage: 'भाषा बदलत आहे…',
  toolEndCall: 'कॉल संपत आहे…',
  toolTransfer: 'टेलिकॉलरकडे ट्रान्सफर होत आहे…',
  toolOther: 'माहिती पाहत आहे…',
  cardFileStatus: 'फाइल तपासणी',
  verdictReady: 'तयार',
  verdictNotReady: 'अपूर्ण',
  missingTitle: 'अजून बाकी',
  nothingMissing: 'काहीही बाकी नाही',
  mismatchesCount: '{n} माहिती जुळत नाही: टीम स्पष्ट करेल',
  cardEligibility: 'अंदाजे पात्रता',
  eligibilityBest: '{lender} कडून {amount}',
  eligibilityNone: 'सध्याच्या माहितीवर कोणताही लेंडर पात्र नाही',
  eligibilityNote: 'फक्त अंदाज. निर्णय लेंडर घेतो.',
  cardReminder: '{channel} रिमाइंडर · मसुदा, पाठवलेला नाही',
  reminderTeam: 'टीम तो तपासून पाठवेल.',
  placeholdersNote: 'पाठवण्यापूर्वी भरा: {list}',
  copy: 'कॉपी',
  copied: 'कॉपी झाले',
  languageSwitched: 'भाषा: {language}',
  reasonTimeCap: 'वेळेची मर्यादा संपली',
  reasonSilence: 'कॉलरकडून उत्तर आले नाही',
  reasonTransferred: 'टेलिकॉलरकडे ट्रान्सफर केला',
  reasonEnded: 'संभाषण पूर्ण झाले',
};

const STRINGS: Record<CallLanguage, Record<StringKey, string>> = {
  'en-IN': en,
  'hi-IN': hi,
  'mr-IN': mr,
};

export function isCallLanguage(code: unknown): code is CallLanguage {
  return LANGUAGES.some((l) => l.code === code);
}

export function htmlLang(code: CallLanguage): string {
  return LANGUAGES.find((l) => l.code === code)?.html ?? 'en';
}

/** Translates `key` for `lang`, falling back to English; `{name}` placeholders come from `vars`. */
export function vt(
  lang: CallLanguage,
  key: StringKey,
  vars?: Record<string, string | number>,
): string {
  const text = STRINGS[lang]?.[key] ?? en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] === undefined ? '' : String(vars[name]),
  );
}
