// @vitest-environment node
// (The workspace's jsdom install cannot start.) The remembered layout is plain
// functions over a storage object, tested here with a fake storage.
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CHAT_LAYOUT_STORAGE_KEY,
  readChatLayoutMode,
  saveChatLayoutMode,
  useChatLayout,
} from './useChatLayout';

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
});
