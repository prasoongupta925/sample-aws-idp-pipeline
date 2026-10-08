// @vitest-environment node
// "No alarms while typing": a free-text field (the company) is being typed in
// while it has focus and changed less than a moment ago. The DOM comes from
// ../test/jsdom (the stock jsdom environment cannot start in this
// workspace); it must be imported before testing-library.
import '../test/jsdom';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useTypingHold } from './useTypingHold';

const MS = 80;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The field, in the document so that it can have focus. */
function field(id: string): HTMLInputElement {
  const input = document.body.appendChild(document.createElement('input'));
  input.id = id;
  return input;
}

function setup(id = 'company') {
  return renderHook(
    ({ value }: { value: string }) => useTypingHold(value, id, MS),
    { initialProps: { value: '' } },
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useTypingHold', () => {
  it('holds while the field is typed in, until it rests', async () => {
    const input = field('company');
    const { result, rerender } = setup();
    expect(result.current).toBe(false);
    input.focus();
    // Focus alone is not typing.
    rerender({ value: '' });
    expect(result.current).toBe(false);
    rerender({ value: 'Unh' });
    expect(result.current).toBe(true);
    await sleep(MS / 2);
    rerender({ value: 'Unheard' });
    // The rest starts again with each change.
    await sleep(MS / 2 + 20);
    expect(result.current).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));
    expect(document.activeElement).toBe(input);
  });

  it('ends as soon as the field loses focus', () => {
    const input = field('company');
    const other = field('pincode');
    const { result, rerender } = setup();
    input.focus();
    rerender({ value: 'Unheard' });
    expect(result.current).toBe(true);
    // Another field's blur does not end it.
    act(() => {
      other.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(result.current).toBe(true);
    act(() => input.blur());
    expect(result.current).toBe(false);
  });

  it('is not typing when the value comes from elsewhere', () => {
    field('company');
    const button = document.body.appendChild(document.createElement('button'));
    const { result, rerender } = setup();
    // "Use" under the field, a suggestion picked, the documents' value.
    button.focus();
    rerender({ value: 'Unheard Of Traders Pvt Ltd' });
    expect(result.current).toBe(false);
  });
});
