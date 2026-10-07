// @vitest-environment node
// Guards the 6 Oct render loop (React #185): the project page re-rendered forever because
// useChatLayout's whole return object, new on every render, sat in the dependency list of
// the sidebar handlers. jsdom cannot start in this workspace, so the guard reads the source.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Every [...] list that closes a call: hook dependency lists and the like. */
function closingLists(src: string): string[] {
  return [...src.matchAll(/\[([^[\]]*)\]\s*,?\s*\)/g)].map((m) => m[1]);
}

describe('chat layout in hook dependencies', () => {
  it('the project page never lists the whole chatLayout object', () => {
    const page = read('../routes/projects/$projectId.tsx');
    const bare = closingLists(page).filter((deps) =>
      /\bchatLayout\b(?!\s*\.)/.test(deps),
    );
    expect(bare).toEqual([]);
  });

  it('useChatLayout returns the same object until the layout changes', () => {
    expect(read('./useChatLayout.ts')).toMatch(/return useMemo\(/);
  });
});
