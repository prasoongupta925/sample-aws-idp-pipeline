import { useCallback, useEffect, useMemo, useState } from 'react';

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

/** Layers that own Esc while open, most closing themselves from their own document
 * or window listener without marking the key handled: modal dialogs, full-screen
 * overlays (the modals, the Mermaid viewer) and the artifact viewer. The File Check,
 * Eligibility and DSA panels share the viewer's class but are regions, and leave a
 * handled Esc alone. */
const ESCAPE_LAYERS = [
  '[aria-modal="true"]',
  '[role="alertdialog"]',
  '.fixed.inset-0',
  '.artifact-viewer-container:not([role="region"])',
].join(', ');

/** True while such a layer is open; useModal also locks the page scroll. */
function escapeLayerOpen(): boolean {
  return (
    document.body.style.overflow === 'hidden' ||
    document.querySelector(ESCAPE_LAYERS) !== null
  );
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

  // Esc closes the drawer unless it is meant for something else: a dialog that
  // handled it (preventDefault) or a layer open when it was pressed, looked up
  // first (window, capture) before that layer can react and close. The decision
  // runs on <html>: after React's handlers, before the document and window
  // listeners of the modals, viewers and panels.
  useEffect(() => {
    if (!compact || !open) return;
    const root = document.documentElement;
    let layerOpen = false;
    const look = (event: KeyboardEvent) => {
      layerOpen = event.key === 'Escape' && escapeLayerOpen();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (event.defaultPrevented || layerOpen) return;
      // Handled: the File Check, Eligibility and DSA panels stay open.
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', look, true);
    root.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', look, true);
      root.removeEventListener('keydown', onKey);
    };
  }, [compact, open]);

  /** Opens the drawer when the chat is compact (a no-op when docked: the chat is already visible). */
  const reveal = useCallback(() => {
    if (compact) setOpen(true);
  }, [compact]);

  // Same object until the layout changes: callers list it in hook dependencies.
  return useMemo(
    () => ({ mode, compact, open, setOpen, setMode, reveal }),
    [mode, compact, open, setMode, reveal],
  );
}
