import { useCallback, useEffect, useRef, useState } from 'react';
import { TYPING_HOLD_MS } from './useTypingHold';

/** What a person types or picks in: an input, a select, a textarea. */
function isField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

export interface EditHold {
  /** A field was changed less than `ms` ago. */
  held: boolean;
  /**
   * The change handler of the fields' container (their change events bubble
   * to it); the same function on every render.
   */
  onChange: (e: { target: EventTarget | null }) => void;
}

/**
 * Held for `ms` after the last change typed or picked into a field that has
 * focus. Only the timer ends it, never a focus change: a mouse press moves
 * focus to the button before its click lands, so the page stays as it was
 * for that click. A value set otherwise (a document's value, a button) is not
 * an edit. The effect depends on nothing; the handler on `ms` only.
 */
export function useEditHold(ms = TYPING_HOLD_MS): EditHold {
  const [held, setHeld] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const pending = timer;
    return () => clearTimeout(pending.current);
  }, []);

  const onChange = useCallback(
    (e: { target: EventTarget | null }) => {
      if (!isField(e.target) || e.target !== document.activeElement) return;
      clearTimeout(timer.current);
      setHeld(true);
      timer.current = setTimeout(() => setHeld(false), ms);
    },
    [ms],
  );

  return { held, onChange };
}
