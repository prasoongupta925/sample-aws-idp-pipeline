// Ported from the voice web app (voice/indic-voicebot/frontend/src/lib/outcome.js).

export type CallErrorKey =
  | 'errAuth'
  | 'errBusy'
  | 'errRejected'
  | 'errConnect'
  | 'errServer'
  | 'errDropped'
  | 'errMicDenied'
  | 'errMicMissing'
  | 'errMicBusy'
  | 'errInsecure'
  | 'errUnsupported'
  | 'errAudio';

export type CallOutcome =
  | { error: CallErrorKey; detail?: string }
  | { reason: 'assistant' | 'user' | 'limit' | 'unmount'; detail?: string };

export interface CloseState {
  opened?: boolean;
  assistantEnded?: boolean;
  endedBy?: string;
  serverError?: string;
}

/**
 * Maps a WebSocket close to the call outcome. The server accepts first and then checks the token,
 * so 4001 can arrive after "open". Codes: 4001 sign in again, 4003 origin not allowed,
 * 1013 busy (all call slots taken), 1008 policy (e.g. unsupported pipeline), 1011 server error.
 */
export function closeOutcome(
  code: number,
  reason: string,
  state?: CloseState,
): CallOutcome {
  const {
    opened = false,
    assistantEnded = false,
    endedBy = '',
    serverError = '',
  } = state || {};
  if (code === 4001) return { error: 'errAuth' };
  if (code === 1013) return { error: 'errBusy' };
  if (code === 4003)
    return {
      error: 'errRejected',
      detail: reason || 'this website is not on the allowed list',
    };
  if (code === 1008)
    return { error: 'errRejected', detail: reason || serverError || 'policy' };
  if (!opened) return { error: 'errConnect' };
  if (code === 1011) return { error: 'errServer' };
  if (assistantEnded || code === 1000 || code === 1001 || code === 1005)
    return { reason: 'assistant', detail: endedBy };
  return { error: 'errDropped' };
}

/** Outcomes after which no post-call note is shown (no conversation took place). */
export const NO_CALL_ERRORS: readonly CallErrorKey[] = Object.freeze([
  'errAuth',
  'errBusy',
  'errRejected',
  'errConnect',
  'errMicDenied',
  'errMicMissing',
  'errMicBusy',
  'errInsecure',
  'errUnsupported',
  'errAudio',
]);
