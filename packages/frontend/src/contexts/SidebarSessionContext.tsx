import {
  createContext,
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { ChatSession } from '../types/project';

export interface SidebarSessionContextValue {
  sessions: ChatSession[];
  currentSessionId: string;
  onSessionSelect: (sessionId: string) => void;
  onSessionRename: (sessionId: string, newName: string) => Promise<void>;
  onSessionDelete: (sessionId: string) => Promise<void>;
  onNewSession: () => void;
  hasMoreSessions: boolean;
  loadingMoreSessions: boolean;
  onLoadMoreSessions: () => void;
}

type SidebarSessionCallbacks = Pick<
  SidebarSessionContextValue,
  | 'onSessionSelect'
  | 'onSessionRename'
  | 'onSessionDelete'
  | 'onNewSession'
  | 'onLoadMoreSessions'
>;

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

// The value and its setter live in separate contexts: a page that publishes its
// sessions only reads the (stable) setter, so publishing never re-renders the page.
const SidebarSessionValueContext =
  createContext<SidebarSessionContextValue | null>(null);
const SidebarSessionSetterContext =
  createContext<Dispatch<SetStateAction<SidebarSessionContextValue | null>>>(
    noop,
  );

export function SidebarSessionProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<SidebarSessionContextValue | null>(null);
  return (
    <SidebarSessionSetterContext.Provider value={setValue}>
      <SidebarSessionValueContext.Provider value={value}>
        {children}
      </SidebarSessionValueContext.Provider>
    </SidebarSessionSetterContext.Provider>
  );
}

export function useSidebarSessions(): SidebarSessionContextValue | null {
  return useContext(SidebarSessionValueContext);
}

/** Callbacks with a fixed identity that call whatever `latest()` returns at call time. */
export function delegatingSidebarCallbacks(
  latest: () => SidebarSessionCallbacks | null,
): SidebarSessionCallbacks {
  return {
    onSessionSelect: (sessionId) => latest()?.onSessionSelect(sessionId),
    onSessionRename: (sessionId, newName) =>
      latest()?.onSessionRename(sessionId, newName) ?? Promise.resolve(),
    onSessionDelete: (sessionId) =>
      latest()?.onSessionDelete(sessionId) ?? Promise.resolve(),
    onNewSession: () => latest()?.onNewSession(),
    onLoadMoreSessions: () => latest()?.onLoadMoreSessions(),
  };
}

/**
 * Publishes the page's chat sessions to the left sidebar. A new value goes out only
 * when the session data changes; the callbacks are fixed wrappers around the page's
 * latest handlers, so handlers that change identity on every render cannot start a
 * render loop (React error #185).
 */
export function useSetSidebarSessions(
  v: SidebarSessionContextValue | null,
): void {
  const setValue = useContext(SidebarSessionSetterContext);
  const latest = useRef(v);
  useLayoutEffect(() => {
    latest.current = v;
  });
  // useState, not useMemo: the fixed identity is guaranteed, not a hint.
  const [callbacks] = useState(() =>
    delegatingSidebarCallbacks(() => latest.current),
  );
  // The value this hook published last; unmounting clears only that one.
  const publishedRef = useRef<SidebarSessionContextValue | null>(null);

  const published = v !== null;
  const sessions = v?.sessions;
  const currentSessionId = v?.currentSessionId;
  const hasMoreSessions = v?.hasMoreSessions;
  const loadingMoreSessions = v?.loadingMoreSessions;
  const value = useMemo<SidebarSessionContextValue | null>(
    () =>
      published
        ? {
            ...callbacks,
            sessions: sessions ?? [],
            currentSessionId: currentSessionId ?? '',
            hasMoreSessions: !!hasMoreSessions,
            loadingMoreSessions: !!loadingMoreSessions,
          }
        : null,
    [
      published,
      sessions,
      currentSessionId,
      hasMoreSessions,
      loadingMoreSessions,
      callbacks,
    ],
  );

  useEffect(() => {
    publishedRef.current = value;
    setValue(value);
  }, [value, setValue]);
  // On unmount the sidebar stops calling this page, and a value another page
  // published meanwhile stays.
  useEffect(
    () => () => {
      latest.current = null;
      setValue((cur) => (cur === publishedRef.current ? null : cur));
    },
    [setValue],
  );
}
