// @vitest-environment node
// The DOM comes from ../test/jsdom (the stock jsdom environment cannot start in
// this workspace); it must be imported before testing-library.
// Context values and hook results that callers read through context or list
// whole in hook dependencies keep one object until something in them changes.
import '../test/jsdom';
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { ToastProvider, useToast } from '../components/Toast';
import { WebSocketProvider, useWebSocket } from '../contexts/WebSocketContext';
import { useAudioCapture } from './useAudioCapture';
import { useAudioPlayback } from './useAudioPlayback';

// Signed out, no socket endpoint: the provider never connects.
vi.mock('react-oidc-context', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('./useRuntimeConfig', () => ({
  useRuntimeConfig: () => ({ cognitoProps: undefined, websocketUrl: '' }),
}));
vi.mock('@aws-sdk/credential-provider-cognito-identity', () => ({
  fromCognitoIdentityPool: vi.fn(),
}));
vi.mock('../lib/websocket-signer', () => ({
  createSignedWebSocketUrl: vi.fn(),
}));

describe('stable values', () => {
  it('a toast does not re-render the useToast callers', async () => {
    let renders = 0;
    let toast: ReturnType<typeof useToast> | undefined;
    function Caller() {
      renders += 1;
      toast = useToast();
      return null;
    }
    render(
      <ToastProvider>
        <Caller />
      </ToastProvider>,
    );
    const first = toast;

    act(() => toast?.showToast('success', 'Saved', 10));
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(renders).toBe(1);
    expect(toast).toBe(first);
    await waitFor(() => expect(screen.queryByText('Saved')).toBeNull());
  });

  it('the WebSocket value stays while the status does', () => {
    const seen: ReturnType<typeof useWebSocket>[] = [];
    function Caller() {
      seen.push(useWebSocket());
      return null;
    }
    const page = () => (
      <WebSocketProvider>
        <Caller />
      </WebSocketProvider>
    );
    const { rerender } = render(page());
    rerender(page());

    expect(seen).toHaveLength(2);
    expect(seen[0].status).toBe('disconnected');
    expect(seen[1]).toBe(seen[0]);
  });

  it('the audio hooks return one object across renders', () => {
    const capture = renderHook(
      ({ onAudioChunk }) => useAudioCapture({ onAudioChunk }),
      { initialProps: { onAudioChunk: vi.fn() } },
    );
    const playback = renderHook(() => useAudioPlayback());
    const first = [capture.result.current, playback.result.current];

    // useVoiceChat passes a new chunk callback on every render.
    capture.rerender({ onAudioChunk: vi.fn() });
    playback.rerender();
    expect(capture.result.current).toBe(first[0]);
    expect(playback.result.current).toBe(first[1]);
  });
});
