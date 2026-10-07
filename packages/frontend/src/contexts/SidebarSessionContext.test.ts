// @vitest-environment node
// The sidebar publishes fixed callback wrappers so a page whose handlers change on
// every render cannot loop. The wrappers are plain functions, tested here without a
// DOM; SidebarSessionContext.render.test.tsx renders the provider and pages.
import { delegatingSidebarCallbacks } from './SidebarSessionContext';

function handlers(tag: string, calls: string[]) {
  return {
    onSessionSelect: (id: string) => {
      calls.push(`${tag}:select:${id}`);
    },
    onSessionRename: async (id: string, name: string) => {
      calls.push(`${tag}:rename:${id}:${name}`);
    },
    onSessionDelete: async (id: string) => {
      calls.push(`${tag}:delete:${id}`);
    },
    onNewSession: () => {
      calls.push(`${tag}:new`);
    },
    onLoadMoreSessions: () => {
      calls.push(`${tag}:more`);
    },
  };
}

describe('sidebar session callbacks', () => {
  it('call the page latest handlers, whatever their identity', async () => {
    const calls: string[] = [];
    let current = handlers('first', calls);
    const callbacks = delegatingSidebarCallbacks(() => current);

    callbacks.onSessionSelect('s1');
    current = handlers('second', calls);
    callbacks.onSessionSelect('s2');
    callbacks.onNewSession();
    callbacks.onLoadMoreSessions();
    await callbacks.onSessionRename('s2', 'Salary check');
    await callbacks.onSessionDelete('s2');

    expect(calls).toEqual([
      'first:select:s1',
      'second:select:s2',
      'second:new',
      'second:more',
      'second:rename:s2:Salary check',
      'second:delete:s2',
    ]);
  });

  it('tolerate a missing publisher', async () => {
    const callbacks = delegatingSidebarCallbacks(() => null);
    expect(() => callbacks.onSessionSelect('s1')).not.toThrow();
    expect(() => callbacks.onNewSession()).not.toThrow();
    expect(() => callbacks.onLoadMoreSessions()).not.toThrow();
    await expect(callbacks.onSessionRename('s1', 'x')).resolves.toBeUndefined();
    await expect(callbacks.onSessionDelete('s1')).resolves.toBeUndefined();
  });
});
