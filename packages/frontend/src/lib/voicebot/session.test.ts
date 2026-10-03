// @vitest-environment node
// The call against fake browser audio and a fake WebSocket: the handshake carries the main
// app's ID token as a subprotocol (never in the URL), mic frames go out only once the socket is
// open, and every failure ends the call with a message key the panel can show.
import { encodeMediaMessage } from './protocol';
import {
  VoiceSession,
  handshakeProtocols,
  micErrorKey,
  type SessionEnd,
} from './session';

vi.mock('./worklet.ts?worker&url', () => ({ default: '/assets/worklet.js' }));

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJ0b2tlbl91c2UiOiJpZCJ9.c2lnbmF0dXJl';

class FakePort {
  sent: unknown[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  postMessage(message: unknown) {
    this.sent.push(message);
  }
}

class FakeNode {
  static all: FakeNode[] = [];
  port = new FakePort();
  constructor(
    _ctx: unknown,
    public name: string,
    public options?: AudioWorkletNodeOptions,
  ) {
    FakeNode.all.push(this);
  }
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeContext {
  state = 'running';
  onstatechange: (() => void) | null = null;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
}

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = 'blob';
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

const track = { addEventListener: vi.fn(), stop: vi.fn() };
let getUserMedia: ReturnType<typeof vi.fn>;
let secure = true;

beforeEach(() => {
  FakeNode.all = [];
  FakeSocket.all = [];
  secure = true;
  getUserMedia = vi.fn(async () => ({
    getAudioTracks: () => [track],
    getTracks: () => [track],
  }));
  vi.stubGlobal('window', {
    get isSecureContext() {
      return secure;
    },
    AudioContext: FakeContext,
    AudioWorkletNode: FakeNode,
    WebSocket: FakeSocket,
  });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function startCall(getToken: () => Promise<string | null> = async () => TOKEN) {
  const ends: SessionEnd[] = [];
  const events = { interrupt: 0, phases: [] as string[] };
  const session = new VoiceSession({
    websocketUrl: 'wss://voice.example.in/ws',
    language: 'hi-IN',
    getToken,
    pageHref: 'https://d1wto5gdh1yonf.cloudfront.net/projects/p1',
    on: {
      end: (e) => ends.push(e),
      interrupt: () => events.interrupt++,
      phase: (p) => events.phases.push(p),
    },
  });
  session.start();
  return { session, ends, events };
}

describe('handshake', () => {
  it('sends the ID token as the auth.<token> subprotocol, not in the URL', async () => {
    const { events } = startCall();
    await flush();
    expect(FakeSocket.all).toHaveLength(1);
    const ws = FakeSocket.all[0];
    expect(ws.url).toBe('wss://voice.example.in/ws?language=hi-IN');
    expect(ws.url).not.toContain(TOKEN);
    expect(ws.protocols).toEqual(['voicebot.v1', `auth.${TOKEN}`]);
    expect(events.phases).toEqual(['starting', 'connecting']);
    ws.open();
    expect(events.phases.at(-1)).toBe('live');
  });

  it('accepts only a JWT-shaped token', () => {
    expect(handshakeProtocols(TOKEN)).toEqual(['voicebot.v1', `auth.${TOKEN}`]);
    for (const bad of [
      null,
      undefined,
      '',
      'abc',
      'a.b',
      'a.b.c d',
      'a.b.c,evil',
      'a.b.c\r\n',
    ]) {
      expect(handshakeProtocols(bad)).toBeNull();
    }
  });

  it('ends with errAuth (no socket) when there is no token', async () => {
    const { ends } = startCall(async () => null);
    await flush();
    expect(FakeSocket.all).toHaveLength(0);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ error: 'errAuth', seconds: 0 });
    expect(track.stop).toHaveBeenCalled();
  });

  it('maps a 4001 close after open to errAuth (sign in again)', async () => {
    const { ends } = startCall();
    await flush();
    const ws = FakeSocket.all[0];
    ws.open();
    ws.onclose?.({ code: 4001, reason: 'token' });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ error: 'errAuth' });
  });

  it('maps a 4003 close (origin not allowed) to errRejected with the reason', async () => {
    const { ends } = startCall();
    await flush();
    FakeSocket.all[0].onclose?.({ code: 4003, reason: '' });
    expect(ends[0]).toMatchObject({
      error: 'errRejected',
      detail: 'this website is not on the allowed list',
    });
  });
});

describe('streaming', () => {
  it('sends 16 kHz mic chunks as media frames only while the socket is open', async () => {
    startCall();
    await flush();
    const ws = FakeSocket.all[0];
    const capture = FakeNode.all.find(
      (n) => n.name === 'sd-capture',
    ) as FakeNode;
    expect(capture).toBeDefined();
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    capture.port.onmessage?.({
      data: { type: 'chunk', pcm: pcm.slice().buffer },
    });
    expect(ws.sent).toHaveLength(0); // still connecting
    ws.open();
    capture.port.onmessage?.({
      data: { type: 'chunk', pcm: pcm.slice().buffer },
    });
    expect(ws.sent).toEqual([encodeMediaMessage(pcm)]);
  });

  it('asks for 100 ms chunks at the 16 kHz wire rate', async () => {
    startCall();
    await flush();
    expect(FakeNode.all.map((n) => n.name)).toEqual([
      'sd-capture',
      'sd-playback',
    ]);
    expect(FakeNode.all[0].options?.processorOptions).toEqual({
      targetRate: 16000,
      chunkSamples: 1600,
    });
    expect(FakeNode.all[1].options?.processorOptions).toMatchObject({
      sourceRate: 16000,
    });
  });

  it('drops the queued bot voice on an interruption (barge-in)', async () => {
    const { events } = startCall();
    await flush();
    const ws = FakeSocket.all[0];
    ws.open();
    const playback = FakeNode.all.find(
      (n) => n.name === 'sd-playback',
    ) as FakeNode;
    ws.onmessage?.({
      data: JSON.stringify({ event: 'interruption', data: null }),
    });
    expect(playback.port.sent).toContainEqual({ type: 'clear' });
    expect(events.interrupt).toBe(1);
  });

  it('hangs up with a normal close on End', async () => {
    const { session, ends } = startCall();
    await flush();
    const ws = FakeSocket.all[0];
    ws.open();
    session.stop('user');
    expect(ws.close).toHaveBeenCalledWith(1000, 'caller hung up');
    expect(ends[0]).toMatchObject({ reason: 'user' });
  });
});

describe('microphone and browser errors', () => {
  it('shows the blocked-microphone message when permission is denied', async () => {
    getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
    const { ends } = startCall();
    await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ error: 'errMicDenied', seconds: 0 });
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('needs a secure page', () => {
    secure = false;
    const { ends } = startCall();
    expect(ends).toEqual([{ error: 'errInsecure', seconds: 0 }]);
  });

  it('maps getUserMedia errors to message keys', () => {
    const err = (name: string) => Object.assign(new Error(name), { name });
    expect(micErrorKey(err('NotAllowedError'))).toBe('errMicDenied');
    expect(micErrorKey(err('SecurityError'))).toBe('errMicDenied');
    expect(micErrorKey(err('NotFoundError'))).toBe('errMicMissing');
    expect(micErrorKey(err('NotReadableError'))).toBe('errMicBusy');
    expect(micErrorKey(err('Whatever'))).toBe('errUnsupported');
    expect(micErrorKey(null)).toBe('errUnsupported');
  });
});
