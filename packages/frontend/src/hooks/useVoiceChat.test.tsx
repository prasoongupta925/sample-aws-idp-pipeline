// @vitest-environment node
// (The workspace's jsdom install cannot start.) The hook runs once in a
// server render: its callbacks are real, effects do not run and state
// updates are dropped, so these tests check what it returns and calls.
import { renderToStaticMarkup } from 'react-dom/server';
import { useVoiceChat } from './useVoiceChat';

// The runtime config of the build: bidiAgentRuntimeArn exists only where the
// built-in voice chat (BidiAgent) is deployed, not in the Mumbai build.
const aws = vi.hoisted(() => ({
  bidiAgentRuntimeArn: undefined as string | undefined,
  getCredentials: vi.fn(),
}));
const signer = vi.hoisted(() => ({ createSignedWebSocketUrl: vi.fn() }));

vi.mock('./useAwsClient', () => ({ useAwsClient: () => aws }));
vi.mock('../lib/websocket-signer', () => signer);
vi.mock('./useAudioCapture', () => ({
  useAudioCapture: () => ({
    isCapturing: false,
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    audioLevel: 0,
  }),
}));
vi.mock('./useAudioPlayback', () => ({
  useAudioPlayback: () => ({
    isPlaying: false,
    enqueueAudio: vi.fn(),
    stop: vi.fn(),
    audioLevel: 0,
  }),
}));

function hookOnce() {
  let value: ReturnType<typeof useVoiceChat> | undefined;
  function Probe() {
    value = useVoiceChat({ sessionId: 's-1', projectId: 'p-1', userId: 'u-1' });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!value) throw new Error('the hook did not run');
  return value;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  aws.getCredentials.mockReset();
  signer.createSignedWebSocketUrl.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useVoiceChat', () => {
  it('is not available without a voice chat runtime (the Mumbai build)', async () => {
    aws.bidiAgentRuntimeArn = undefined;
    const voiceChat = hookOnce();

    expect(voiceChat.available).toBe(false);
    expect(voiceChat.state.status).toBe('idle');
    // connect() does nothing: no credentials, no signed socket, no error.
    await voiceChat.connect({ modelType: 'nova_sonic' });
    expect(aws.getCredentials).not.toHaveBeenCalled();
    expect(signer.createSignedWebSocketUrl).not.toHaveBeenCalled();
  });

  it('is available where the build has the BidiAgent runtime', () => {
    aws.bidiAgentRuntimeArn =
      'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/bidi_agent-AbCdEf1234';
    expect(hookOnce().available).toBe(true);
  });
});
