// @vitest-environment node
// The eligibility panel's background check: debounced, never the same key
// twice (but on Try again), late answers ignored, nothing without a key, a
// failure reported. The DOM comes from
// ../test/jsdom (the stock jsdom environment cannot start in this
// workspace); it must be imported before testing-library.
import '../test/jsdom';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePrecheck } from './usePrecheck';
import type { EligibilityResult } from '../types/eligibility';

const DELAY = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function answer(tag: string): EligibilityResult {
  return { applicant: tag } as EligibilityResult;
}

interface Call {
  signal: AbortSignal;
  resolve: (r: EligibilityResult) => void;
  reject: (e: unknown) => void;
}

/** A run whose answers the test gives, call by call. */
function controlledRun() {
  const calls: Call[] = [];
  const run = vi.fn(
    (signal: AbortSignal) =>
      new Promise<EligibilityResult>((resolve, reject) => {
        calls.push({ signal, resolve, reject });
      }),
  );
  return { run, calls };
}

type Props = { scope: string; requestKey: string | null };

/** No answer, no failure. */
const IDLE = { failed: false, error: null, retry: expect.any(Function) };

function setup(first: Props) {
  const { run, calls } = controlledRun();
  const hook = renderHook(
    (props: Props) =>
      // A new run on every render, as the panel's closure over the inputs.
      usePrecheck({ ...props, run: (s) => run(s), delayMs: DELAY }),
    { initialProps: first },
  );
  return { ...hook, run, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePrecheck', () => {
  it('checks at once when the panel opens, then after the inputs rest', async () => {
    const { result, rerender, run, calls } = setup({
      scope: 'A',
      requestKey: 'k1',
    });
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await act(async () => calls[0].resolve(answer('k1')));
    expect(result.current).toEqual({
      result: answer('k1'),
      key: 'k1',
      at: expect.any(Number),
      checking: false,
      ...IDLE,
    });

    // Three edits in a row: one check, for the last.
    rerender({ scope: 'A', requestKey: 'k2' });
    rerender({ scope: 'A', requestKey: 'k3' });
    rerender({ scope: 'A', requestKey: 'k4' });
    expect(result.current.checking).toBe(true);
    // The last answer stays while the next check is due.
    expect(result.current.key).toBe('k1');
    await sleep(DELAY / 2);
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await act(async () => calls[1].resolve(answer('k4')));
    expect(result.current.key).toBe('k4');
    await sleep(DELAY * 2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never checks the same key twice', async () => {
    const { result, rerender, run, calls } = setup({
      scope: 'A',
      requestKey: 'k1',
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await act(async () => calls[0].resolve(answer('k1')));
    // Renders with the same key (a new run each time, e.g. the name typed).
    for (let i = 0; i < 5; i += 1) rerender({ scope: 'A', requestKey: 'k1' });
    // A value in red pauses the check; fixed back: the answer is still good.
    rerender({ scope: 'A', requestKey: null });
    rerender({ scope: 'A', requestKey: 'k1' });
    await sleep(DELAY * 3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ key: 'k1', checking: false });
  });

  it('ignores a late answer and aborts its request', async () => {
    const { result, rerender, run, calls } = setup({
      scope: 'A',
      requestKey: 'k1',
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    rerender({ scope: 'A', requestKey: 'k2' });
    expect(calls[0].signal.aborted).toBe(true);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    // k1's answer comes after k2 was asked: not shown.
    await act(async () => calls[0].resolve(answer('k1')));
    expect(result.current).toEqual({
      result: null,
      key: null,
      at: null,
      checking: true,
      ...IDLE,
    });
    await act(async () => calls[1].resolve(answer('k2')));
    expect(result.current).toMatchObject({
      result: answer('k2'),
      key: 'k2',
      checking: false,
    });
  });

  it('sends nothing without a key, and nothing once unmounted', async () => {
    const idle = setup({ scope: 'A', requestKey: null });
    await sleep(DELAY * 2);
    expect(idle.run).not.toHaveBeenCalled();
    expect(idle.result.current).toEqual({
      result: null,
      key: null,
      at: null,
      checking: false,
      ...IDLE,
    });
    idle.unmount();

    // Closed while a check is due, or on its way.
    const due = setup({ scope: 'A', requestKey: 'k1' });
    due.unmount();
    await sleep(DELAY * 2);
    expect(due.run).not.toHaveBeenCalled();
    const sent = setup({ scope: 'A', requestKey: 'k1' });
    await waitFor(() => expect(sent.run).toHaveBeenCalledTimes(1));
    sent.unmount();
    expect(sent.calls[0].signal.aborted).toBe(true);
  });

  it('reports a failed check, keeps the last answer and waits for new inputs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result, rerender, run, calls } = setup({
      scope: 'A',
      requestKey: 'k1',
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await act(async () => calls[0].resolve(answer('k1')));
    rerender({ scope: 'A', requestKey: 'k2' });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    const refused = Object.assign(new Error('API error: 422'), {
      status: 422,
    });
    await act(async () => calls[1].reject(refused));
    expect(result.current).toEqual({
      // The last good answer stays (for other inputs).
      result: answer('k1'),
      key: 'k1',
      at: expect.any(Number),
      checking: false,
      failed: true,
      error: refused,
      retry: expect.any(Function),
    });
    // Only the status is logged (a 422 may quote a value typed).
    expect(warn).toHaveBeenCalledWith(
      'Background eligibility check failed',
      422,
    );
    rerender({ scope: 'A', requestKey: 'k2' });
    await sleep(DELAY * 2);
    expect(run).toHaveBeenCalledTimes(2);
    // Other inputs: checked, and the failure is no longer theirs.
    rerender({ scope: 'A', requestKey: 'k3' });
    expect(result.current).toMatchObject({ failed: false, error: null });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  });

  it('tries the same inputs again at once on retry, with the same function every render', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result, rerender, run, calls } = setup({
      scope: 'A',
      requestKey: 'k1',
    });
    const retry = result.current.retry;
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await act(async () => calls[0].reject(new Error('API error: 503')));
    expect(result.current).toMatchObject({ failed: true, checking: false });
    rerender({ scope: 'A', requestKey: 'k1' });
    expect(result.current.retry).toBe(retry);

    const asked = performance.now();
    act(() => result.current.retry());
    expect(result.current).toMatchObject({
      failed: false,
      error: null,
      checking: true,
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    // At once, not after the delay.
    expect(performance.now() - asked).toBeLessThan(DELAY * 4);
    await act(async () => calls[1].resolve(answer('k1')));
    expect(result.current).toMatchObject({
      result: answer('k1'),
      key: 'k1',
      failed: false,
      checking: false,
    });
  });

  it("never shows another applicant's answer", async () => {
    const { result, rerender, run, calls } = setup({
      scope: 'A',
      requestKey: 'A|k1',
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await act(async () => calls[0].resolve(answer('A')));
    rerender({ scope: 'B', requestKey: 'B|k1' });
    expect(result.current).toEqual({
      result: null,
      key: null,
      at: null,
      checking: true,
      ...IDLE,
    });
    // B's first check starts at once too.
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await act(async () => calls[1].resolve(answer('B')));
    expect(result.current.result).toEqual(answer('B'));
  });
});
