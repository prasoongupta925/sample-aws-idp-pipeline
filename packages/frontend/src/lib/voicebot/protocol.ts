// Ported from the voice web app (voice/indic-voicebot/frontend/src/lib/protocol.js).
// Keep the two in step: the frames must stay byte-identical (see protocol.test.ts).
//
// WebSocket protocol of the voice server (backend/serializers.py BrowserJsonSerializer).
// Text frames, one JSON object each.
//
// Browser -> bot (the only message the serializer accepts):
//   {"event": "media", "data": "<base64 of 16 kHz mono PCM16 little-endian>"}
//   Hang up = close the WebSocket.
//
// Bot -> browser:
//   {"event": "media", "data": "<base64 PCM16 16 kHz mono>"}       bot voice
//   {"event": "interruption", "data": null}                       barge-in: drop queued audio
//   {"event": "user_transcript", "text": "..."}                   caption, one per caller turn
//   {"event": "bot_transcript", "text": "...", "interrupted": b}  caption, one per bot turn
//   {"event": "tool", "name": "file_status", "status": "started"} the bot is looking something up
//   {"event": "file_status", "verdict", "missing": [...], "mismatches": n}
//   {"event": "eligibility", "best_lender", "amount"}             indicative only
//   {"event": "reminder", "template", "language", "channel", "text", "placeholders"}
//   {"event": "language", "language": "hi"}                       the bot switched language
//   {"event": "call_started", "call_id", "language"} / {"event": "call_ended", "reason"}
//   {"event": "recording", ...}
//
// Connect: new WebSocket(<voiceBotUrl>?language=<en-IN|hi-IN|mr-IN>,
//                        ["voicebot.v1", "auth.<Cognito ID token>"])
// The token travels as a WebSocket subprotocol so it stays out of URLs and load-balancer logs
// (backend/auth.py token_from_websocket).

export const SUBPROTOCOL = 'voicebot.v1';
export const AUTH_PROTOCOL_PREFIX = 'auth.';

export const MessageType = Object.freeze({
  MEDIA: 'media',
  INTERRUPTION: 'interruption',
  USER_TRANSCRIPT: 'user_transcript',
  BOT_TRANSCRIPT: 'bot_transcript',
});

export type CallLanguage = 'en-IN' | 'hi-IN' | 'mr-IN';

export type ResultCard =
  | {
      type: 'file_status';
      verdict: string;
      missing: string[];
      mismatches: number;
    }
  | { type: 'eligibility'; bestLender: string; amount: string }
  | {
      type: 'reminder';
      text: string;
      language: CallLanguage | null;
      channel: string;
      template: string;
      placeholders: string[];
    };

export interface CaptionMessage {
  kind: 'caption';
  role: 'user' | 'bot';
  text: string;
  final: boolean;
  turn: boolean;
  interrupted: boolean;
}

export type ServerMessage =
  | { kind: 'media'; samples: Int16Array }
  | { kind: 'interruption' }
  | CaptionMessage
  | { kind: 'tool'; name: string; status: string }
  | { kind: 'result'; card: ResultCard }
  | { kind: 'language'; language: CallLanguage }
  | { kind: 'callStarted'; callId: string; language: CallLanguage | null }
  | { kind: 'callEnded'; reason: string }
  | { kind: 'recording'; status: string; documentId: string }
  | { kind: 'end'; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'unknown'; type: string }
  | { kind: 'ignored' }
  | { kind: 'invalid' };

type Json = Record<string, unknown>;

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Int16 samples -> little-endian bytes (no copy on little-endian platforms). */
export function int16ToBytesLE(samples: Int16Array): Uint8Array {
  if (LITTLE_ENDIAN)
    return new Uint8Array(
      samples.buffer,
      samples.byteOffset,
      samples.byteLength,
    );
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++)
    view.setInt16(i * 2, samples[i], true);
  return out;
}

/** Little-endian bytes -> Int16 samples (a trailing odd byte is ignored). */
export function bytesLEToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.length >> 1;
  if (LITTLE_ENDIAN && bytes.byteOffset % 2 === 0)
    return new Int16Array(bytes.buffer, bytes.byteOffset, n);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + STEP) as unknown as number[],
    );
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The exact text frame the server's serializer turns into an InputAudioRawFrame. */
export function encodeMediaMessage(samples: Int16Array): string {
  return JSON.stringify({
    event: MessageType.MEDIA,
    data: bytesToBase64(int16ToBytesLE(samples)),
  });
}

function cleanText(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
    .replace(/<\/?thinking>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_TEXT = 4000;

function clip(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Caption from one message. `turn` = the message is a whole turn (new bubble); otherwise it is a
 * part of a turn (interim/final segments, sentences) that joins the open bubble.
 */
function caption(
  role: 'user' | 'bot',
  msg: Json,
  style: string,
): CaptionMessage | { kind: 'ignored' } {
  const data = msg.data;
  let text = '';
  let final = true;
  let turn = false;
  let interrupted = false;
  if (typeof msg.text === 'string') {
    text = msg.text;
    turn = !('final' in msg);
    final = msg.final !== false;
    interrupted = msg.interrupted === true;
  } else if (typeof data === 'string') {
    text = data;
    turn = style !== 'rtvi';
  } else if (data && typeof data === 'object') {
    const d = data as Json;
    if (typeof d.text === 'string') text = d.text;
    else if (typeof d.content === 'string') text = d.content;
    const partial = 'final' in d || 'is_final' in d || 'interim' in d;
    if (d.final === false || d.is_final === false || d.interim === true)
      final = false;
    turn = style !== 'rtvi' && !partial;
    interrupted = d.interrupted === true;
  }
  text = cleanText(text).slice(0, MAX_TEXT);
  if (!text) return { kind: 'ignored' };
  return { kind: 'caption', role, text, final, turn, interrupted };
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as Json;
    if (typeof v.reason === 'string') return v.reason;
    if (typeof v.message === 'string') return v.message;
  }
  return '';
}

const LANGUAGE_ALIASES: Record<string, CallLanguage> = {
  hi: 'hi-IN',
  'hi-in': 'hi-IN',
  hindi: 'hi-IN',
  hinglish: 'hi-IN',
  en: 'en-IN',
  'en-in': 'en-IN',
  english: 'en-IN',
  mr: 'mr-IN',
  'mr-in': 'mr-IN',
  marathi: 'mr-IN',
};

/** 'hi' | 'hi-IN' | 'hindi' -> 'hi-IN' (null if not one of the three call languages). */
export function callLanguage(value: unknown): CallLanguage | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, v)
    ? LANGUAGE_ALIASES[v]
    : null;
}

function stringList(value: unknown, maxItems = 20): string[] {
  return Array.isArray(value)
    ? value
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .slice(0, maxItems)
        .map((x) => clip(x.trim()))
    : [];
}

function resultCard(
  type: 'file_status' | 'eligibility' | 'reminder',
  msg: Json,
): { kind: 'result'; card: ResultCard } | { kind: 'ignored' } {
  if (type === 'file_status') {
    const mismatches = msg.mismatches;
    return {
      kind: 'result',
      card: {
        type,
        verdict: clip(msg.verdict, 40),
        missing: stringList(msg.missing),
        mismatches:
          typeof mismatches === 'number' && Number.isFinite(mismatches)
            ? mismatches
            : Array.isArray(mismatches)
              ? mismatches.length
              : 0,
      },
    };
  }
  if (type === 'eligibility') {
    return {
      kind: 'result',
      card: {
        type,
        bestLender: clip(msg.best_lender, 120),
        amount:
          typeof msg.amount === 'number'
            ? String(msg.amount)
            : clip(msg.amount, 60),
      },
    };
  }
  const text = clip(msg.text, MAX_TEXT);
  if (!text) return { kind: 'ignored' };
  const placeholders = msg.placeholders;
  return {
    kind: 'result',
    card: {
      type: 'reminder',
      text,
      language: callLanguage(msg.language),
      channel: clip(msg.channel, 20) || 'whatsapp',
      template: clip(msg.template, 40),
      placeholders: Array.isArray(placeholders)
        ? stringList(placeholders, 10)
        : placeholders && typeof placeholders === 'object'
          ? Object.keys(placeholders)
              .slice(0, 10)
              .map((k) => clip(k, 60))
          : [],
    },
  };
}

/** Parses one text frame from the bot. */
export function parseServerMessage(raw: unknown): ServerMessage {
  if (typeof raw !== 'string') return { kind: 'ignored' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return { kind: 'invalid' };
  const msg = parsed as Json;
  const style =
    typeof msg.event === 'string'
      ? 'event'
      : typeof msg.type === 'string'
        ? 'rtvi'
        : '';
  const type =
    style === 'event'
      ? (msg.event as string)
      : style === 'rtvi'
        ? (msg.type as string)
        : '';
  const data = msg.data;
  switch (type) {
    case MessageType.MEDIA:
      if (typeof data !== 'string') return { kind: 'invalid' };
      try {
        return { kind: 'media', samples: bytesLEToInt16(base64ToBytes(data)) };
      } catch {
        return { kind: 'invalid' };
      }
    case MessageType.INTERRUPTION:
    case 'stop':
    case 'clear':
      return { kind: 'interruption' };
    case MessageType.USER_TRANSCRIPT:
    case 'user_transcription':
    case 'user-transcription':
      return caption('user', msg, style);
    case MessageType.BOT_TRANSCRIPT:
    case 'bot_transcription':
    case 'bot-transcription':
      return caption('bot', msg, style);
    case 'transcript': {
      const role = data && typeof data === 'object' ? (data as Json).role : '';
      if (role === 'user') return caption('user', msg, style);
      if (role === 'assistant' || role === 'bot')
        return caption('bot', msg, style);
      return { kind: 'ignored' };
    }
    case 'tool':
      return {
        kind: 'tool',
        name: clip(msg.name, 60),
        status: clip(msg.status, 20) || 'started',
      };
    case 'file_status':
    case 'eligibility':
    case 'reminder':
      return resultCard(type, msg);
    case 'language': {
      const language = callLanguage(msg.language ?? data);
      return language ? { kind: 'language', language } : { kind: 'ignored' };
    }
    case 'call_started':
      return {
        kind: 'callStarted',
        callId: clip(msg.call_id, 80),
        language: callLanguage(msg.language),
      };
    case 'call_ended':
      return {
        kind: 'callEnded',
        reason: clip(asText(msg.reason ?? data), 80),
      };
    case 'recording':
      return {
        kind: 'recording',
        status: clip(msg.status, 40) || 'uploaded',
        documentId: clip(msg.document_id ?? msg.documentId, 80),
      };
    case 'end_call':
    case 'hangup':
      return { kind: 'end', reason: asText(data) };
    case 'error':
      return { kind: 'error', message: asText(data ?? msg.message) };
    default:
      return { kind: 'unknown', type };
  }
}

/** Resolves a configured socket URL ("wss://host/ws", or "/ws" on the page's own host). */
export function resolveSocketUrl(value: string, pageHref: string): URL {
  const url = new URL(value, pageHref);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error(
      `voiceBotUrl must be a ws:// or wss:// address, got ${url.protocol}`,
    );
  }
  return url;
}

/** Connect URL with the query parameters the server reads (empty values are left out). */
export function buildSocketUrl(
  websocketUrl: string,
  params: Record<string, string | number | null | undefined>,
  pageHref: string,
): string {
  const url = resolveSocketUrl(websocketUrl, pageHref);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  }
  return url.toString();
}
