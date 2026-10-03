import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  captionsReducer,
  initialCaptions,
  type CaptionsState,
} from '../../lib/voicebot/captions';
import type { CallLanguage } from '../../lib/voicebot/protocol';
import {
  VoiceSession,
  type CallPhase,
  type SessionEnd,
} from '../../lib/voicebot/session';

export type PanelPhase = 'idle' | CallPhase | 'ended';

export interface VoiceBotCall {
  phase: PanelPhase;
  /** The language the call runs in now (the bot may switch it). */
  callLanguage: CallLanguage | null;
  captions: CaptionsState;
  speaking: boolean;
  audioSuspended: boolean;
  end: SessionEnd | null;
  /** The bot reported the recording upload ("recording" event). */
  recorded: boolean;
  start: (language: CallLanguage) => void;
  stop: () => void;
  resumeAudio: () => void;
}

/**
 * One voice bot call at a time. `start` must run inside the click handler
 * (browsers unlock audio only there). The call ends when the panel unmounts.
 */
export function useVoiceBotCall(
  voiceBotUrl: string,
  getToken: () => Promise<string | null | undefined>,
): VoiceBotCall {
  const [phase, setPhase] = useState<PanelPhase>('idle');
  const [callLanguage, setCallLanguage] = useState<CallLanguage | null>(null);
  const [captions, dispatch] = useReducer(captionsReducer, initialCaptions);
  const [speaking, setSpeaking] = useState(false);
  const [audioSuspended, setAudioSuspended] = useState(false);
  const [end, setEnd] = useState<SessionEnd | null>(null);
  const [recorded, setRecorded] = useState(false);
  const sessionRef = useRef<VoiceSession | null>(null);
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const start = useCallback(
    (language: CallLanguage) => {
      if (sessionRef.current && !sessionRef.current.ended) return;
      dispatch({ type: 'reset' });
      setEnd(null);
      setRecorded(false);
      setSpeaking(false);
      setAudioSuspended(false);
      setCallLanguage(language);
      const session = new VoiceSession({
        websocketUrl: voiceBotUrl,
        language,
        getToken: () => getTokenRef.current(),
        pageHref: window.location.href,
        on: {
          phase: (p) => setPhase(p),
          caption: (c) => dispatch({ type: 'caption', ...c }),
          interrupt: () => dispatch({ type: 'interrupt' }),
          event: (m) => {
            if (m.kind === 'tool') dispatch({ type: 'tool', name: m.name });
            else if (m.kind === 'result')
              dispatch({ type: 'card', card: m.card });
            else if (m.kind === 'language') setCallLanguage(m.language);
            else if (m.kind === 'recording') setRecorded(true);
          },
          speaking: setSpeaking,
          audioSuspended: setAudioSuspended,
          end: (result) => {
            if (sessionRef.current === session) sessionRef.current = null;
            dispatch({ type: 'end' });
            setSpeaking(false);
            setAudioSuspended(false);
            setEnd(result);
            setPhase('ended');
          },
        },
      });
      sessionRef.current = session;
      session.start();
    },
    [voiceBotUrl],
  );

  const stop = useCallback(() => sessionRef.current?.stop('user'), []);
  const resumeAudio = useCallback(() => sessionRef.current?.resumeAudio(), []);

  // Closing the panel (or leaving the page) hangs up.
  useEffect(
    () => () => {
      sessionRef.current?.stop('unmount');
      sessionRef.current = null;
    },
    [],
  );

  return {
    phase,
    callLanguage,
    captions,
    speaking,
    audioSuspended,
    end,
    recorded,
    start,
    stop,
    resumeAudio,
  };
}
