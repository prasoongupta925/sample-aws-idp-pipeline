import { useEffect, useRef, useState } from 'react';

/** How long a free-text field rests before what it causes is shown. */
export const TYPING_HOLD_MS = 2000;

/**
 * True while the element `id` is being typed in: it has focus and `value`
 * changed less than `ms` ago. It ends when the field loses focus or rests for
 * `ms`, so half a company name typed never shows the banks' answer to it. A
 * value set otherwise (a document's value, a suggestion picked) is not typing.
 * The effects depend on the strings and the number given only.
 */
export function useTypingHold(
  value: string,
  id: string,
  ms = TYPING_HOLD_MS,
): boolean {
  const [typing, setTyping] = useState(false);
  const last = useRef(value);

  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    if (document.activeElement?.id !== id) {
      setTyping(false);
      return;
    }
    setTyping(true);
    const timer = setTimeout(() => setTyping(false), ms);
    return () => clearTimeout(timer);
  }, [value, id, ms]);

  useEffect(() => {
    if (!typing) return;
    const onFocusOut = (e: FocusEvent) => {
      if (e.target instanceof Element && e.target.id === id) setTyping(false);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => document.removeEventListener('focusout', onFocusOut);
  }, [typing, id]);

  return typing;
}
