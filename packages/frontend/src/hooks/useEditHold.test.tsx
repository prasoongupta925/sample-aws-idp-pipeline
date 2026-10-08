// @vitest-environment node
// The eligibility box keeps its height for a moment after a field is typed
// in: a timer ends that, never a focus change (a mouse press moves focus to
// its button before the click lands). The DOM comes from ../test/jsdom (the
// stock jsdom environment cannot start in this workspace); it must be
// imported before testing-library.
import '../test/jsdom';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useEditHold } from './useEditHold';

const MS = 80;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function add<K extends keyof HTMLElementTagNameMap>(tag: K) {
  return document.body.appendChild(document.createElement(tag));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useEditHold', () => {
  it('holds from a change typed into the focused field until it rests, wherever focus goes', async () => {
    const input = add('input');
    const button = add('button');
    const { result } = renderHook(() => useEditHold(MS));
    const first = result.current.onChange;
    expect(result.current.held).toBe(false);
    input.focus();
    act(() => result.current.onChange({ target: input }));
    expect(result.current.held).toBe(true);
    // A press on a button right after: focus moves to it, still held.
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(result.current.held).toBe(true);
    // Typed again: the rest starts again.
    await sleep(MS / 2);
    input.focus();
    act(() => result.current.onChange({ target: input }));
    await sleep(MS / 2 + 20);
    expect(result.current.held).toBe(true);
    await waitFor(() => expect(result.current.held).toBe(false));
    // The same handler on every render.
    expect(result.current.onChange).toBe(first);
  });

  it('holds for a field picked from too (a select), not for a change made elsewhere', () => {
    const input = add('input');
    const select = add('select');
    const button = add('button');
    const { result } = renderHook(() => useEditHold(MS));
    // A value set while another element has focus (a document's value, Use).
    button.focus();
    act(() => result.current.onChange({ target: input }));
    expect(result.current.held).toBe(false);
    // Not a field.
    act(() => result.current.onChange({ target: button }));
    expect(result.current.held).toBe(false);
    select.focus();
    act(() => result.current.onChange({ target: select }));
    expect(result.current.held).toBe(true);
  });

  it('leaves no timer behind when the page goes', () => {
    const input = add('input');
    const { result, unmount } = renderHook(() => useEditHold(MS));
    input.focus();
    const set = vi.spyOn(globalThis, 'setTimeout');
    act(() => result.current.onChange({ target: input }));
    const ends = set.mock.calls.findIndex(([, ms]) => ms === MS);
    expect(ends).toBeGreaterThan(-1);
    const timer = set.mock.results[ends].value;
    set.mockRestore();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    unmount();
    expect(clear).toHaveBeenCalledWith(timer);
    clear.mockRestore();
  });
});
