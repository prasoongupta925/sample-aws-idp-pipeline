// Talk modes of a voice bot call (ported from the voice web app's src/lib/talk.js; the server
// reads the `mode` query parameter):
//   'ptt'       hold to talk: the microphone is open only while the button (or Space) is held;
//   'handsfree' always listening, behind the server's stricter speech gate.
// While the button is up the capture worklet zeroes the samples (the same path as Mute): no
// microphone audio leaves the browser, but silent frames keep flowing, so the server's VAD ends
// the turn on release and the Transcribe stream does not time out between turns.

export type TalkMode = 'ptt' | 'handsfree';

export const TALK_MODES: readonly TalkMode[] = Object.freeze([
  'ptt',
  'handsfree',
]);
export const TALK_MODE_KEY = 'voicebot.talkMode';

type MatchMedia = (query: string) => { matches: boolean };

export function isTalkMode(value: unknown): value is TalkMode {
  return TALK_MODES.includes(value as TalkMode);
}

/** Hold to talk on a desktop (fine pointer that can hover), hands-free on phones and tablets. */
export function defaultTalkMode(matchMedia?: MatchMedia | null): TalkMode {
  try {
    if (
      typeof matchMedia === 'function' &&
      matchMedia('(pointer: fine)').matches &&
      matchMedia('(hover: hover)').matches
    ) {
      return 'ptt';
    }
  } catch {
    /* old browser: hands-free */
  }
  return 'handsfree';
}

/** The saved choice, else the device default. */
export function initialTalkMode(
  storage?: Pick<Storage, 'getItem'> | null,
  matchMedia?: MatchMedia | null,
): TalkMode {
  try {
    const saved = storage?.getItem(TALK_MODE_KEY);
    if (isTalkMode(saved)) return saved;
  } catch {
    /* storage blocked */
  }
  return defaultTalkMode(matchMedia);
}

/** Whether the capture worklet must send silence instead of the microphone. */
export function micSilenced(state: {
  muted: boolean;
  talkMode: TalkMode;
  held: boolean;
}): boolean {
  return state.muted || (state.talkMode === 'ptt' && !state.held);
}

interface KeyLike {
  code?: string;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?:
    | EventTarget
    | { tagName?: string; isContentEditable?: boolean }
    | null;
}

/** Space (not a repeat, not inside a text field) starts / ends hold to talk from the keyboard. */
export function isTalkKey(event: KeyLike | null | undefined): boolean {
  if (
    !event ||
    event.code !== 'Space' ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return false;
  const target = event.target as
    | { tagName?: string; isContentEditable?: boolean }
    | null
    | undefined;
  const tag = target?.tagName;
  if (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target?.isContentEditable
  )
    return false;
  return true;
}

interface PreventableKey extends KeyLike {
  preventDefault: () => void;
}

/**
 * Window key handlers for hold to talk: Space down opens the microphone, Space up closes it.
 * Both swallow Space so the page does not scroll and a focused button (End!) is not clicked.
 */
export function holdKeyHandlers(onHeld: (held: boolean) => void): {
  down: (event: PreventableKey) => void;
  up: (event: PreventableKey) => void;
} {
  return {
    down: (event) => {
      if (event.code === 'Space' && event.repeat) event.preventDefault();
      if (!isTalkKey(event)) return;
      event.preventDefault();
      onHeld(true);
    },
    up: (event) => {
      if (event.code !== 'Space') return;
      event.preventDefault();
      onHeld(false);
    },
  };
}

interface PointerLike {
  button: number;
  pointerId: number;
  currentTarget: { setPointerCapture?: (id: number) => void } | null;
}

/** Pointer handlers of the hold button: the primary button / a finger holds; any end releases. */
export function holdPointerHandlers(onHeld: (held: boolean) => void) {
  const release = () => onHeld(false);
  return {
    onPointerDown: (event: PointerLike) => {
      if (event.button !== 0) return;
      try {
        event.currentTarget?.setPointerCapture?.(event.pointerId);
      } catch {
        /* the pointer is already gone: pointerup follows */
      }
      onHeld(true);
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
  };
}
