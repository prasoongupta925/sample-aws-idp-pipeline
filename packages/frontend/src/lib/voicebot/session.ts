// Ported from the voice web app (voice/indic-voicebot/frontend/src/audio/session.js).
//
// One voice call: microphone -> sd-capture worklet -> WebSocket (protocol.ts) and
// WebSocket -> sd-playback worklet -> speaker. No React in here.
//
// The main app's Cognito ID token (same user pool as the voice server) travels as the
// "auth.<token>" WebSocket subprotocol, never in the URL.

import workletUrl from './worklet.ts?worker&url';
import { WIRE_SAMPLE_RATE, int16ToFloat, levelToMeter } from './dsp';
import {
  AUTH_PROTOCOL_PREFIX,
  SUBPROTOCOL,
  buildSocketUrl,
  encodeMediaMessage,
  parseServerMessage,
  type CaptionMessage,
  type ServerMessage,
} from './protocol';
import { closeOutcome, type CallErrorKey, type CallOutcome } from './outcome';

const CHUNK_MS = 100; // 1600 samples / 3200 bytes per media message
const MAX_BUFFERED_BYTES = 1 << 20; // stop queueing audio if the network stalls (~25 s)
// The bot closes the socket right after sending its last audio, so the end of its goodbye is still
// in the jitter buffer: let it play out (normally ~0.1 s plus a 0.25 s tail), at most this long.
const DRAIN_MAX_MS = 2500;
// The bot has the same time cap and says goodbye when it is reached. The browser hangs up itself
// only this much later, so that goodbye is heard (it is the fallback for a bot that never ends).
const LIMIT_GRACE_S = 30;
/** A Cognito JWT: three base64url parts (also all a subprotocol token may contain). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type CallPhase = 'starting' | 'connecting' | 'live' | 'ending';

export type SessionEvent = Extract<
  ServerMessage,
  {
    kind:
      | 'tool'
      | 'result'
      | 'language'
      | 'callStarted'
      | 'callEnded'
      | 'recording';
  }
>;

export type SessionEnd = CallOutcome & { seconds: number };

export interface SessionCallbacks {
  phase?: (phase: CallPhase) => void;
  caption?: (caption: CaptionMessage) => void;
  interrupt?: () => void;
  event?: (event: SessionEvent) => void;
  speaking?: (speaking: boolean) => void;
  levels?: (levels: { mic: number; bot: number }) => void;
  audioSuspended?: (suspended: boolean) => void;
  end?: (end: SessionEnd) => void;
}

export interface SessionOptions {
  /** runtime config voiceBotUrl ("wss://host/ws") */
  websocketUrl: string;
  language: string;
  /** The main app's current Cognito ID token. */
  getToken: () => Promise<string | null | undefined>;
  maxCallSeconds?: number;
  pageHref: string;
  on: SessionCallbacks;
}

type AudioContextCtor = typeof AudioContext;

function audioContextClass(): AudioContextCtor | undefined {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext || w.webkitAudioContext;
}

/** Returns an error key if this browser/page cannot run a call, else null. */
export function checkSupport(): CallErrorKey | null {
  if (typeof window === 'undefined') return 'errUnsupported';
  if (!window.isSecureContext) return 'errInsecure';
  if (
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== 'function'
  )
    return 'errUnsupported';
  if (
    !audioContextClass() ||
    typeof window.AudioWorkletNode === 'undefined' ||
    typeof window.WebSocket === 'undefined'
  ) {
    return 'errUnsupported';
  }
  return null;
}

/** getUserMedia error -> the message key shown to the user. */
export function micErrorKey(error: unknown): CallErrorKey {
  const name =
    error && typeof error === 'object' ? (error as { name?: string }).name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'errMicDenied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'errMicMissing';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'errMicBusy';
    default:
      return 'errUnsupported';
  }
}

/** The subprotocols of the handshake, or null for a token that cannot be sent. */
export function handshakeProtocols(
  token: string | null | undefined,
): string[] | null {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  return [SUBPROTOCOL, AUTH_PROTOCOL_PREFIX + token];
}

class CallError extends Error {
  key: CallErrorKey;
  detail: string;
  constructor(key: CallErrorKey, detail = '') {
    super(key);
    this.key = key;
    this.detail = detail;
  }
}

async function openMicrophone(): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    if ((error as { name?: string })?.name === 'OverconstrainedError') {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      } catch (retryError) {
        throw new CallError(micErrorKey(retryError));
      }
    }
    throw new CallError(micErrorKey(error));
  }
}

export class VoiceSession {
  private options: SessionOptions;
  ended = false;
  private opened = false;
  /** the outcome, while the bot's last words play out after it hung up */
  private draining: CallOutcome | null = null;
  private muted = false;
  private assistantEnded = false;
  private endedBy = '';
  private serverError = '';
  private startedAt = 0;
  private levels = { mic: 0, bot: 0 };
  private timers: ReturnType<typeof setTimeout>[] = [];
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private playback: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private ws: WebSocket | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private onVisibility = () => this.handleVisibility();

  constructor(options: SessionOptions) {
    this.options = options;
  }

  private emit<K extends keyof SessionCallbacks>(
    name: K,
    ...args: Parameters<NonNullable<SessionCallbacks[K]>>
  ): void {
    const fn = this.options.on[name] as ((...a: unknown[]) => void) | undefined;
    if (!fn) return;
    try {
      fn(...args);
    } catch (error) {
      console.error(`voice session callback ${name} failed`, error);
    }
  }

  /** Call this synchronously inside the click handler: iOS unlocks audio only in the gesture. */
  start(): void {
    const unsupported = checkSupport();
    if (unsupported) {
      this.finish({ error: unsupported });
      return;
    }
    const AC = audioContextClass() as AudioContextCtor;
    try {
      this.ctx = new AC({ latencyHint: 'interactive' });
    } catch (error) {
      this.finish({ error: 'errAudio', detail: (error as Error)?.message });
      return;
    }
    this.ctx.resume().catch(() => undefined);
    try {
      // Safari 16.4+: tell iOS this is a two-way call (keeps the loudspeaker and echo cancelling).
      const nav = navigator as unknown as { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'play-and-record';
    } catch {
      /* not supported */
    }
    this.emit('phase', 'starting');
    this.run().catch((error) => {
      if (this.ended) return;
      if (error instanceof CallError)
        this.finish({ error: error.key, detail: error.detail });
      else
        this.finish({
          error: 'errAudio',
          detail: (error && (error as Error).message) || String(error),
        });
    });
  }

  private async run(): Promise<void> {
    const ctx = this.ctx as AudioContext;
    this.stream = await openMicrophone();
    if (this.ended) return this.cleanup();

    await ctx.audioWorklet.addModule(workletUrl);
    if (this.ended) return this.cleanup();

    this.capture = new AudioWorkletNode(ctx, 'sd-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        targetRate: WIRE_SAMPLE_RATE,
        chunkSamples: Math.round((WIRE_SAMPLE_RATE * CHUNK_MS) / 1000),
      },
    });
    this.playback = new AudioWorkletNode(ctx, 'sd-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sourceRate: WIRE_SAMPLE_RATE, prebufferMs: 80 },
    });
    this.source = ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.capture);
    this.capture.connect(ctx.destination); // silent output: keeps the capture node running
    this.playback.connect(ctx.destination);
    this.capture.port.onmessage = (event) => this.handleCapture(event.data);
    this.playback.port.onmessage = (event) => this.handlePlayback(event.data);
    if (this.muted)
      this.capture.port.postMessage({ type: 'mute', value: true });
    ctx.onstatechange = () => {
      const state = ctx.state;
      this.emit(
        'audioSuspended',
        !this.ended && state !== 'running' && state !== 'closed',
      );
    };
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (!this.ended && !this.draining) this.finish({ error: 'errMicBusy' });
      });
    }

    this.emit('phase', 'connecting');
    let token: string | null | undefined;
    try {
      token = await this.options.getToken();
    } catch {
      token = null;
    }
    if (this.ended) return this.cleanup();
    const protocols = handshakeProtocols(token);
    if (!protocols) throw new CallError('errAuth');
    const url = buildSocketUrl(
      this.options.websocketUrl,
      { language: this.options.language },
      this.options.pageHref,
    );
    // Token as a subprotocol: it never appears in the URL (load-balancer and proxy logs).
    const ws = new WebSocket(url, protocols);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => this.handleOpen();
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onclose = (event) => this.handleClose(event);
    ws.onerror = () => undefined; // the close event that follows carries the details
  }

  private handleOpen(): void {
    if (this.ended) return;
    this.opened = true;
    this.startedAt = performance.now();
    this.emit('phase', 'live');
    const limit =
      (Math.max(60, Number(this.options.maxCallSeconds) || 600) +
        LIMIT_GRACE_S) *
      1000;
    this.timers.push(setTimeout(() => this.stop('limit'), limit));
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.acquireWakeLock();
    if (this.ctx && this.ctx.state !== 'running')
      this.ctx.resume().catch(() => undefined);
  }

  private handleCapture(message: {
    type?: string;
    pcm?: ArrayBuffer;
    value?: number;
  }): void {
    if (!message) return;
    if (message.type === 'chunk' && message.pcm) {
      const ws = this.ws;
      if (
        ws &&
        ws.readyState === WebSocket.OPEN &&
        ws.bufferedAmount < MAX_BUFFERED_BYTES
      ) {
        ws.send(encodeMediaMessage(new Int16Array(message.pcm)));
      }
    } else if (message.type === 'level') {
      this.levels = { ...this.levels, mic: levelToMeter(message.value ?? 0) };
      this.emit('levels', this.levels);
    }
  }

  private handlePlayback(message: {
    type?: string;
    value?: number | boolean;
  }): void {
    if (!message) return;
    if (message.type === 'level') {
      this.levels = {
        ...this.levels,
        bot: levelToMeter(Number(message.value) || 0),
      };
      this.emit('levels', this.levels);
    } else if (message.type === 'speaking') {
      this.emit('speaking', !!message.value);
    } else if (message.type === 'drained' && this.draining) {
      this.finish(this.draining);
    }
  }

  private handleMessage(data: unknown): void {
    if (this.ended || this.draining) return;
    const message = parseServerMessage(data);
    switch (message.kind) {
      case 'media':
        if (this.playback && message.samples.length) {
          const samples = int16ToFloat(message.samples);
          this.playback.port.postMessage(
            { type: 'audio', samples: samples.buffer },
            [samples.buffer],
          );
        }
        break;
      case 'interruption':
        if (this.playback) this.playback.port.postMessage({ type: 'clear' });
        this.emit('interrupt');
        break;
      case 'caption':
        this.emit('caption', message);
        break;
      case 'tool':
      case 'result':
      case 'language':
      case 'callStarted':
      case 'recording':
        this.emit('event', message);
        break;
      case 'callEnded':
        this.assistantEnded = true;
        this.endedBy = message.reason;
        this.emit('event', message);
        break;
      case 'end':
        this.assistantEnded = true;
        break;
      case 'error':
        this.serverError = message.message;
        break;
      default:
        break;
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.ended || this.draining) return;
    const outcome = closeOutcome(event.code, event.reason, {
      opened: this.opened,
      assistantEnded: this.assistantEnded,
      endedBy: this.endedBy,
      serverError: this.serverError,
    });
    if ('reason' in outcome && outcome.reason === 'assistant' && this.playback)
      this.drain(outcome);
    else this.finish(outcome);
  }

  /**
   * The bot hung up (normal close after its goodbye). The microphone stops now; the speaker plays
   * what is left of the goodbye, then the call ends ("drained", or after DRAIN_MAX_MS).
   */
  private drain(outcome: CallOutcome): void {
    this.draining = outcome;
    if (this.capture) this.capture.port.postMessage({ type: 'stop' });
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    this.playback?.port.postMessage({ type: 'drain' });
    this.timers.push(
      setTimeout(
        () => this.draining && this.finish(this.draining),
        DRAIN_MAX_MS,
      ),
    );
    this.emit('phase', 'ending');
  }

  private handleVisibility(): void {
    if (this.ended || document.visibilityState !== 'visible') return;
    if (this.ctx && this.ctx.state !== 'running')
      this.ctx.resume().catch(() => undefined);
    if (!this.wakeLock || this.wakeLock.released) void this.acquireWakeLock();
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      if (navigator.wakeLock && document.visibilityState === 'visible') {
        this.wakeLock = await navigator.wakeLock.request('screen');
        if (this.ended) this.wakeLock.release().catch(() => undefined);
      }
    } catch {
      /* the screen may sleep: not fatal */
    }
  }

  /** Resume audio after iOS interrupted it (must be called from a tap). */
  resumeAudio(): void {
    if (this.ctx && this.ctx.state !== 'closed')
      this.ctx.resume().catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    this.muted = !!muted;
    if (this.capture)
      this.capture.port.postMessage({ type: 'mute', value: this.muted });
  }

  get seconds(): number {
    return this.opened ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** Ends the call: 'user' (End button), 'limit' (max duration) or 'unmount'. */
  stop(reason: 'user' | 'limit' | 'unmount' = 'user'): void {
    if (this.ended) return;
    if (this.draining) {
      this.finish(this.draining); // the bot had already hung up: keep its outcome
      return;
    }
    const ws = this.ws;
    if (
      ws &&
      (ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN)
    ) {
      try {
        ws.close(1000, reason === 'limit' ? 'time limit' : 'caller hung up');
      } catch {
        /* already closing */
      }
    }
    this.finish({ reason });
  }

  private finish(result: CallOutcome): void {
    if (this.ended) return;
    const seconds = this.seconds;
    this.ended = true;
    this.draining = null;
    this.cleanup();
    this.emit('end', { ...result, seconds });
  }

  private cleanup(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.wakeLock && !this.wakeLock.released)
      this.wakeLock.release().catch(() => undefined);
    this.wakeLock = null;
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (
        ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN
      ) {
        try {
          ws.close(1000, 'caller hung up');
        } catch {
          /* ignore */
        }
      }
    }
    for (const node of [this.capture, this.playback]) {
      if (!node) continue;
      try {
        node.port.postMessage({ type: 'stop' });
        node.port.onmessage = null;
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.stream) for (const track of this.stream.getTracks()) track.stop();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.onstatechange = null;
      this.ctx.close().catch(() => undefined);
    }
    this.capture = this.playback = this.source = this.stream = null;
  }
}
