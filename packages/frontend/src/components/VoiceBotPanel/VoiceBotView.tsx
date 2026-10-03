import { useRef, useState } from 'react';
import { Copy, Check, Mic, PhoneOff, X } from 'lucide-react';
import type { TimelineItem } from '../../lib/voicebot/captions';
import {
  htmlLang,
  LANGUAGES,
  vt,
  type StringKey,
} from '../../lib/voicebot/i18n';
import { NO_CALL_ERRORS } from '../../lib/voicebot/outcome';
import type { CallLanguage, ResultCard } from '../../lib/voicebot/protocol';
import type { SessionEnd } from '../../lib/voicebot/session';
import { copyText } from '../../lib/clipboard';
import type { PanelPhase } from './useVoiceBotCall';

const TOOL_LABEL: Record<string, StringKey> = {
  file_status: 'toolFileStatus',
  eligibility: 'toolEligibility',
  reminder: 'toolReminder',
  switch_language: 'toolSwitchLanguage',
  end_call: 'toolEndCall',
  transfer_to_human: 'toolTransfer',
};

const END_REASON: Record<string, StringKey> = {
  time_cap: 'reasonTimeCap',
  silence: 'reasonSilence',
  transferred: 'reasonTransferred',
  transfer: 'reasonTransferred',
  end_call: 'reasonEnded',
  bot_ended: 'reasonEnded',
  completed: 'reasonEnded',
};

export interface VoiceBotViewProps {
  /** Picker value (also the language of the next call). */
  language: CallLanguage;
  onLanguageChange: (language: CallLanguage) => void;
  phase: PanelPhase;
  /** The language the running call uses (the bot may switch it). */
  callLanguage: CallLanguage | null;
  items: TimelineItem[];
  speaking: boolean;
  audioSuspended: boolean;
  end: SessionEnd | null;
  /** Link to the Telecaller QA project ('' when it is not found). */
  qaHref: string;
  maxCallMinutes: number;
  onCall: () => void;
  onEnd: () => void;
  onResumeAudio: () => void;
  onOpenQa: () => void;
  onClose: () => void;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The error text of a call outcome, or '' when the call ended normally. */
export function endMessage(
  lang: CallLanguage,
  end: SessionEnd | null,
  maxCallMinutes: number,
): string {
  if (!end) return '';
  if ('error' in end) return vt(lang, end.error, { reason: end.detail || '' });
  if (end.reason === 'limit')
    return vt(lang, 'timeLimit', { min: maxCallMinutes });
  return '';
}

/** Whether a conversation took place (then the post-call note with the QA link is shown). */
export function showPostCall(end: SessionEnd | null): boolean {
  if (!end || end.seconds < 1) return false;
  return !('error' in end && NO_CALL_ERRORS.includes(end.error));
}

function CopyButton({ text, lang }: { text: string; lang: CallLanguage }) {
  const [copied, setCopied] = useState(false);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const onCopy = async () => {
    const outcome = await copyText(text, fallbackRef.current);
    if (outcome === 'copied') {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-white/20 px-2 py-0.5 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/10"
      >
        {copied ? (
          <Check className="w-3 h-3" aria-hidden="true" />
        ) : (
          <Copy className="w-3 h-3" aria-hidden="true" />
        )}
        {copied ? vt(lang, 'copied') : vt(lang, 'copy')}
      </button>
      <textarea
        ref={fallbackRef}
        value={text}
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />
    </>
  );
}

function verdictLabel(verdict: string): [string, StringKey | null] {
  const v = (verdict || '').toUpperCase().replace(/[_-]/g, ' ');
  if (v === 'READY')
    return [
      'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
      'verdictReady',
    ];
  if (v === 'NOT READY')
    return [
      'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
      'verdictNotReady',
    ];
  return [
    'bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-slate-200',
    null,
  ];
}

export function ResultCardView({
  card,
  lang,
}: {
  card: ResultCard;
  lang: CallLanguage;
}) {
  const box =
    'rounded-xl border border-slate-200 dark:border-white/15 bg-white/80 dark:bg-slate-800/80 p-3 text-sm space-y-1.5';
  const note = 'text-xs text-slate-500 dark:text-slate-400';
  if (card.type === 'file_status') {
    const [cls, key] = verdictLabel(card.verdict);
    return (
      <section className={box} data-card="file_status">
        <header className="flex items-center justify-between gap-2">
          <h4 className="font-semibold">{vt(lang, 'cardFileStatus')}</h4>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}
          >
            {key ? vt(lang, key) : card.verdict}
          </span>
        </header>
        {card.missing.length ? (
          <div>
            <p className={note}>{vt(lang, 'missingTitle')}</p>
            <ul className="list-disc pl-5">
              {card.missing.map((item, i) => (
                <li key={`${i}-${item}`}>{item}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p>{vt(lang, 'nothingMissing')}</p>
        )}
        {card.mismatches > 0 ? (
          <p className={note}>
            {vt(lang, 'mismatchesCount', { n: card.mismatches })}
          </p>
        ) : null}
      </section>
    );
  }
  if (card.type === 'eligibility') {
    return (
      <section className={box} data-card="eligibility">
        <h4 className="font-semibold">{vt(lang, 'cardEligibility')}</h4>
        <p>
          {card.amount && card.bestLender
            ? vt(lang, 'eligibilityBest', {
                amount: card.amount,
                lender: card.bestLender,
              })
            : card.amount || vt(lang, 'eligibilityNone')}
        </p>
        <p className={note}>{vt(lang, 'eligibilityNote')}</p>
      </section>
    );
  }
  const channel = card.channel === 'sms' ? 'SMS' : 'WhatsApp';
  return (
    <section className={box} data-card="reminder">
      <header className="flex items-center justify-between gap-2">
        <h4 className="font-semibold">
          {vt(lang, 'cardReminder', { channel })}
        </h4>
        <CopyButton text={card.text} lang={lang} />
      </header>
      <p
        className="whitespace-pre-wrap"
        lang={card.language ? htmlLang(card.language) : undefined}
      >
        {card.text}
      </p>
      {card.placeholders.length ? (
        <p className={note}>
          {vt(lang, 'placeholdersNote', { list: card.placeholders.join(', ') })}
        </p>
      ) : null}
      <p className={note}>{vt(lang, 'reminderTeam')}</p>
    </section>
  );
}

function TimelineEntry({
  item,
  lang,
}: {
  item: TimelineItem;
  lang: CallLanguage;
}) {
  if (item.role === 'card')
    return <ResultCardView card={item.card} lang={lang} />;
  if (item.role === 'tool') {
    return (
      <p className="text-xs italic text-slate-500 dark:text-slate-400">
        {vt(lang, TOOL_LABEL[item.name] || 'toolOther')}
      </p>
    );
  }
  const user = item.role === 'user';
  return (
    <div className={`flex ${user ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
          user
            ? 'bg-blue-600 text-white'
            : 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100'
        }`}
      >
        <span className="sr-only">
          {vt(lang, user ? 'you' : 'assistant')}:{' '}
        </span>
        {item.text}
        {user && item.interim ? (
          <span className="opacity-70"> {item.interim}</span>
        ) : null}
        {item.role === 'bot' && item.interrupted ? (
          <span className="ml-1 text-xs opacity-70">
            ({vt(lang, 'interrupted')})
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default function VoiceBotView({
  language,
  onLanguageChange,
  phase,
  callLanguage,
  items,
  speaking,
  audioSuspended,
  end,
  qaHref,
  maxCallMinutes,
  onCall,
  onEnd,
  onResumeAudio,
  onOpenQa,
  onClose,
}: VoiceBotViewProps) {
  const inCall = phase !== 'idle' && phase !== 'ended';
  const lang = (inCall && callLanguage) || language;
  const error = phase === 'ended' ? endMessage(lang, end, maxCallMinutes) : '';
  const postCall = phase === 'ended' && showPostCall(end);
  const endReason =
    end && 'reason' in end && end.reason === 'assistant' && end.detail
      ? END_REASON[end.detail]
      : undefined;
  let status: string;
  if (phase === 'starting') status = vt(lang, 'statusAllowMic');
  else if (phase === 'connecting') status = vt(lang, 'statusConnecting');
  else if (phase === 'live')
    status = vt(lang, speaking ? 'statusSpeaking' : 'statusListening');
  else if (phase === 'ending') status = vt(lang, 'statusEnding');
  else status = vt(lang, 'statusIdle');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="voicebot-title"
        lang={htmlLang(lang)}
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-[#e8ecf4] dark:bg-slate-900 shadow-xl border border-white/60 dark:border-white/20"
      >
        <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-black/[0.06] dark:border-white/10">
          <div>
            <h2
              id="voicebot-title"
              className="text-base font-semibold text-slate-800 dark:text-slate-100"
            >
              {vt(lang, 'title')}
            </h2>
            <p className="text-xs font-medium text-purple-700 dark:text-purple-300">
              {vt(lang, 'notice')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={vt(lang, 'close')}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </header>

        <div className="flex flex-wrap items-center gap-3 px-5 py-3">
          <fieldset className="flex items-center gap-1" disabled={inCall}>
            <legend className="sr-only">{vt(lang, 'language')}</legend>
            {LANGUAGES.map((l) => (
              <label
                key={l.code}
                lang={l.html}
                className={`cursor-pointer rounded-lg px-2.5 py-1 text-sm ${
                  language === l.code
                    ? 'bg-purple-600 text-white'
                    : 'bg-white/70 dark:bg-white/10 text-slate-700 dark:text-slate-200'
                } ${inCall ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="voicebot-language"
                  value={l.code}
                  checked={language === l.code}
                  onChange={() => onLanguageChange(l.code)}
                  className="sr-only"
                />
                {l.label}
              </label>
            ))}
          </fieldset>
          {inCall ? (
            <button
              type="button"
              onClick={onEnd}
              aria-label={vt(lang, 'endAria')}
              className="ml-auto inline-flex items-center gap-2 rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
            >
              <PhoneOff className="w-4 h-4" aria-hidden="true" />
              {vt(lang, 'end')}
            </button>
          ) : (
            <button
              type="button"
              onClick={onCall}
              aria-label={vt(lang, 'callAria')}
              className="ml-auto inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              <Mic className="w-4 h-4" aria-hidden="true" />
              {vt(lang, 'call')}
            </button>
          )}
        </div>

        <p
          className="px-5 pb-2 text-sm text-slate-600 dark:text-slate-300"
          aria-live="polite"
        >
          {status}
        </p>
        {audioSuspended ? (
          <div className="px-5 pb-2">
            <button
              type="button"
              onClick={onResumeAudio}
              className="rounded-lg bg-amber-100 px-3 py-1.5 text-sm text-amber-900"
            >
              {vt(lang, 'resumeAudio')}
            </button>
          </div>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="mx-5 mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
          >
            {error}
          </p>
        ) : null}

        <section
          aria-label={vt(lang, 'captions')}
          aria-live="polite"
          className="flex-1 min-h-[8rem] overflow-y-auto space-y-2 px-5 py-2"
        >
          {items.map((item) => (
            <TimelineEntry key={item.id} item={item} lang={lang} />
          ))}
        </section>

        {postCall && end ? (
          <div className="mx-5 my-3 rounded-xl bg-white/80 dark:bg-slate-800/80 p-3 text-sm space-y-1">
            <p className="font-semibold">
              {vt(
                lang,
                end && 'reason' in end && end.reason === 'assistant'
                  ? 'assistantEnded'
                  : 'callEnded',
              )}
              {' · '}
              {vt(lang, 'duration')} {formatDuration(end.seconds)}
            </p>
            {endReason ? <p>{vt(lang, endReason)}</p> : null}
            <p>{vt(lang, 'postCall')}</p>
            {qaHref ? (
              <a
                href={qaHref}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenQa();
                }}
                className="inline-block font-medium text-blue-700 underline dark:text-blue-300"
              >
                {vt(lang, 'openQa')}
              </a>
            ) : null}
          </div>
        ) : null}

        <footer className="px-5 py-2 text-xs text-slate-500 dark:text-slate-400 border-t border-black/[0.06] dark:border-white/10">
          {vt(lang, 'noticeDetail')} {vt(lang, 'headphones')}
        </footer>
      </div>
    </div>
  );
}
