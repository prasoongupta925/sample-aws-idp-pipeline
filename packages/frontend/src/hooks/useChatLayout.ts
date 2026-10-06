import { useCallback, useEffect, useState } from 'react';

/** Where the project page shows the chat (per browser).
 * - "compact" (default): documents, file check and eligibility get the full width; the chat opens
 *   from a small "Ask AI" button as a drawer on the right.
 * - "docked": the earlier layout, chat and documents side by side. */
export type ChatLayoutMode = 'compact' | 'docked';

export const CHAT_LAYOUT_STORAGE_KEY = 'idp-chat-layout-v1';

type ModeStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): ModeStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The remembered layout; "compact" when nothing (or nothing readable) is stored. */
export function readChatLayoutMode(
  storage: ModeStorage | undefined = browserStorage(),
): ChatLayoutMode {
  try {
    return storage?.getItem(CHAT_LAYOUT_STORAGE_KEY) === 'docked'
      ? 'docked'
      : 'compact';
  } catch {
    return 'compact';
  }
}

/** Remembers the layout; a blocked storage keeps it for this page only. */
export function saveChatLayoutMode(
  mode: ChatLayoutMode,
  storage: ModeStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(CHAT_LAYOUT_STORAGE_KEY, mode);
  } catch {
    // private mode or blocked storage
  }
}

export function useChatLayout() {
  const [mode, setModeState] = useState<ChatLayoutMode>(() =>
    readChatLayoutMode(),
  );
  const [open, setOpen] = useState(false);

  const setMode = useCallback((next: ChatLayoutMode) => {
    setModeState(next);
    setOpen(false);
    saveChatLayoutMode(next);
  }, []);

  const compact = mode === 'compact';

  // Esc closes the drawer.
  useEffect(() => {
    if (!compact || !open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, open]);

  /** Opens the drawer when the chat is compact (a no-op when docked: the chat is already visible). */
  const reveal = useCallback(() => {
    if (compact) setOpen(true);
  }, [compact]);

  return { mode, compact, open, setOpen, setMode, reveal };
}
