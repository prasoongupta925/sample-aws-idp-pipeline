// @vitest-environment node
// The DOM comes from ../test/jsdom (the stock jsdom environment cannot start in
// this workspace); it must be imported before testing-library. The remembered
// layout is plain functions over a storage object, tested with a fake storage.
import '../test/jsdom';
import {
  act,
  createEvent,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CHAT_LAYOUT_STORAGE_KEY,
  readChatLayoutMode,
  saveChatLayoutMode,
  useChatLayout,
} from './useChatLayout';
import { useModal } from './useModal';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

// Elements and listeners a test puts on the page, removed after it.
const undo: (() => void)[] = [];

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  undo.splice(0).forEach((fn) => fn());
});

describe('chat layout', () => {
  it('is compact when nothing is stored', () => {
    expect(readChatLayoutMode(fakeStorage())).toBe('compact');
    expect(readChatLayoutMode(undefined)).toBe('compact');
  });

  it('remembers the docked layout', () => {
    const storage = fakeStorage();
    saveChatLayoutMode('docked', storage);
    expect(storage.data[CHAT_LAYOUT_STORAGE_KEY]).toBe('docked');
    expect(readChatLayoutMode(storage)).toBe('docked');
    saveChatLayoutMode('compact', storage);
    expect(readChatLayoutMode(storage)).toBe('compact');
  });

  it('a blocked storage falls back to compact and never throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readChatLayoutMode(broken)).toBe('compact');
    expect(() => saveChatLayoutMode('docked', broken)).not.toThrow();
  });

  it('starts compact with the drawer closed', () => {
    let seen: ReturnType<typeof useChatLayout> | undefined;
    function Probe() {
      seen = useChatLayout();
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(seen?.compact).toBe(true);
    expect(seen?.open).toBe(false);
  });

  // The 6 Oct render loop: callers list the object in hook dependencies.
  it('returns the same object until the layout changes', () => {
    const { result, rerender } = renderHook(() => useChatLayout());
    const closed = result.current;
    rerender();
    expect(result.current).toBe(closed);

    act(() => result.current.reveal());
    const opened = result.current;
    expect(opened.open).toBe(true);
    expect(opened).not.toBe(closed);
    expect(opened.reveal).toBe(closed.reveal);
    expect(opened.setMode).toBe(closed.setMode);
    rerender();
    expect(result.current).toBe(opened);
  });
});

/** Presses Escape in `target` (the page body: nothing has focus). */
function pressEscape(target: Element = document.body, init = {}) {
  const event = createEvent.keyDown(target, { key: 'Escape', ...init });
  fireEvent(target, event);
  return event;
}

function openDrawer() {
  const { result } = renderHook(() => useChatLayout());
  act(() => result.current.reveal());
  expect(result.current.open).toBe(true);
  return result;
}

/**
 * Puts a layer on the page that closes itself on Escape from a listener on `on`,
 * like the app's modals, viewers and side panels. Only the panels honor a
 * handled key (`honorsHandled`).
 */
function layer(
  className: string,
  on: EventTarget,
  {
    role,
    honorsHandled = false,
  }: { role?: string; honorsHandled?: boolean } = {},
) {
  const el = document.createElement('div');
  el.className = className;
  if (role) el.setAttribute('role', role);
  document.body.append(el);
  const close = vi.fn(() => el.remove());
  const onKey = (event: Event) => {
    const key = event as KeyboardEvent;
    if (key.key !== 'Escape' || !el.isConnected) return;
    if (honorsHandled && key.defaultPrevented) return;
    close();
  };
  on.addEventListener('keydown', onKey);
  undo.push(() => {
    on.removeEventListener('keydown', onKey);
    el.remove();
  });
  return close;
}

describe('Esc and the chat drawer', () => {
  it('closes the open drawer and marks the key handled', () => {
    const drawer = openDrawer();
    // Esc that ends an input method's composition belongs to it.
    expect(
      pressEscape(document.body, { isComposing: true }).defaultPrevented,
    ).toBe(false);
    expect(drawer.current.open).toBe(true);

    expect(pressEscape().defaultPrevented).toBe(true);
    expect(drawer.current.open).toBe(false);
    // Closed: the next Esc is left alone.
    expect(pressEscape().defaultPrevented).toBe(false);
  });

  it('a modal takes Esc first, then the drawer closes', () => {
    const drawer = openDrawer();
    const closeModal = vi.fn();
    // The real hook every modal uses (document listener, no preventDefault).
    const modal = renderHook(
      ({ isOpen }) => useModal({ isOpen, onClose: closeModal }),
      { initialProps: { isOpen: true } },
    );

    pressEscape();
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(drawer.current.open).toBe(true);

    modal.rerender({ isOpen: false });
    pressEscape();
    expect(drawer.current.open).toBe(false);
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it.each([
    // A portal; its listener is on the document.
    {
      viewer: 'the Mermaid viewer',
      className: 'fixed inset-0 z-50',
      on: document,
    },
    // Over the documents; its listener is on the window.
    {
      viewer: 'the artifact viewer',
      className: 'artifact-viewer-container absolute inset-0',
      on: window,
    },
  ])('$viewer takes Esc first, then the drawer closes', ({ className, on }) => {
    const drawer = openDrawer();
    const closeViewer = layer(className, on);

    pressEscape();
    expect(closeViewer).toHaveBeenCalledTimes(1);
    expect(drawer.current.open).toBe(true);

    pressEscape();
    expect(drawer.current.open).toBe(false);
    expect(closeViewer).toHaveBeenCalledTimes(1);
  });

  it('a layer that closed before the drawer saw the key still counts', () => {
    // In a browser React commits between listeners, so a modal closed by an
    // earlier listener can be gone from the page by the time the drawer looks.
    const drawer = openDrawer();
    const closeModal = layer('fixed inset-0 z-50', document.body);

    pressEscape();
    expect(closeModal).toHaveBeenCalledTimes(1);
    expect(drawer.current.open).toBe(true);
  });

  it('a dialog that handled Esc keeps the drawer open', () => {
    const drawer = openDrawer();
    const closeList = vi.fn();
    // Like the chat's @-mention list or the reminder box.
    render(
      <div
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          closeList();
        }}
      >
        <input aria-label="Mention a document" />
      </div>,
    );

    pressEscape(screen.getByLabelText('Mention a document'));
    expect(closeList).toHaveBeenCalledTimes(1);
    expect(drawer.current.open).toBe(true);
  });

  it('closes before the File Check panel, which stays open', () => {
    const drawer = openDrawer();
    const closePanel = layer(
      'artifact-viewer-container absolute inset-0',
      document,
      { role: 'region', honorsHandled: true },
    );

    pressEscape();
    expect(drawer.current.open).toBe(false);
    expect(closePanel).not.toHaveBeenCalled();

    pressEscape();
    expect(closePanel).toHaveBeenCalledTimes(1);
  });
});
