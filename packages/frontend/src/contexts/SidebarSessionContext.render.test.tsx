// @vitest-environment node
// The provider, the sidebar and project pages rendered for real (the 6 Oct render
// loop, React #185, came from publishing pages). The DOM comes from ../test/jsdom
// (the stock jsdom environment cannot start in this workspace); it must be
// imported before react-dom.
import '../test/jsdom';
import { StrictMode, act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatSession } from '../types/project';
import {
  SidebarSessionProvider,
  useSetSidebarSessions,
  useSidebarSessions,
  type SidebarSessionContextValue,
} from './SidebarSessionContext';

// More page renders than this is a render loop: throw, so the test fails fast
// instead of hanging.
const LOOP_LIMIT = 40;

let pageRenders = 0;
let sidebarRenders = 0;
let calls: string[] = [];
let seen: SidebarSessionContextValue | null = null;
// What the sidebar rendered with, in order, without repeats.
let shown: (SidebarSessionContextValue | null)[] = [];

const chatSession = (session_id: string): ChatSession => ({
  session_id,
  session_type: 'chat',
  created_at: '2026-10-06T09:00:00Z',
  updated_at: '2026-10-06T09:00:00Z',
  session_name: null,
});

/** A project page whose sidebar handlers are new on every render. */
function Page({ project, tick = 0 }: { project: string; tick?: number }) {
  pageRenders += 1;
  if (pageRenders > LOOP_LIMIT) {
    throw new Error(`render loop: ${pageRenders} page renders`);
  }
  const sessions = useMemo(() => [chatSession(`${project}-1`)], [project]);
  const from = `${project}#${tick}`;
  useSetSidebarSessions({
    sessions,
    currentSessionId: `${project}-1`,
    onSessionSelect: (id) => {
      calls.push(`${from} select ${id}`);
    },
    onSessionRename: async (id, name) => {
      calls.push(`${from} rename ${id} ${name}`);
    },
    onSessionDelete: async (id) => {
      calls.push(`${from} delete ${id}`);
    },
    onNewSession: () => {
      calls.push(`${from} new`);
    },
    hasMoreSessions: false,
    loadingMoreSessions: false,
    onLoadMoreSessions: () => {
      calls.push(`${from} more`);
    },
  });
  return null;
}

function Sidebar() {
  sidebarRenders += 1;
  seen = useSidebarSessions();
  if (shown.at(-1) !== seen) shown.push(seen);
  return null;
}
// One element for every render: only the context re-renders the sidebar.
const sidebar = <Sidebar />;

function sidebarValue(): SidebarSessionContextValue {
  if (!seen) throw new Error('the sidebar shows no sessions');
  return seen;
}

/** Calls every sidebar callback once. */
async function callAll(value: SidebarSessionContextValue, id: string) {
  value.onSessionSelect(id);
  value.onNewSession();
  value.onLoadMoreSessions();
  await value.onSessionRename(id, 'Salary check');
  await value.onSessionDelete(id);
}

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete actEnv.IS_REACT_ACT_ENVIRONMENT;
});

interface PageSlot {
  /** The React key: a new slot is a new page instance. */
  slot: string;
  project: string;
  tick?: number;
}

describe.each([
  ['', false],
  [' in StrictMode', true],
])('sidebar sessions from a page%s', (_, strict) => {
  // StrictMode calls a component twice for each render.
  const rendersPerPass = strict ? 2 : 1;
  let root: Root;
  let errors: string[];

  beforeEach(() => {
    pageRenders = 0;
    sidebarRenders = 0;
    calls = [];
    seen = null;
    shown = [];
    errors = [];
    root = createRoot(document.createElement('div'), {
      onUncaughtError: (error) => {
        errors.push(String(error));
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  /** Renders the provider with the sidebar and these pages. */
  async function show(pages: PageSlot[]) {
    const tree = (
      <SidebarSessionProvider>
        {sidebar}
        {pages.map(({ slot, ...page }) => (
          <Page key={slot} {...page} />
        ))}
      </SidebarSessionProvider>
    );
    await act(async () =>
      root.render(strict ? <StrictMode>{tree}</StrictMode> : tree),
    );
    // A render loop ends in the page's throw: an uncaught error.
    expect(errors).toEqual([]);
  }

  it('publishes without re-rendering the page', async () => {
    await show([{ slot: 'page', project: 'A' }]);

    expect(pageRenders).toBe(rendersPerPass);
    expect(sidebarValue().sessions).toEqual([chatSession('A-1')]);
    expect(sidebarValue().currentSessionId).toBe('A-1');
    expect(sidebarValue().hasMoreSessions).toBe(false);
    await callAll(sidebarValue(), 'A-1');
    expect(calls).toEqual([
      'A#0 select A-1',
      'A#0 new',
      'A#0 more',
      'A#0 rename A-1 Salary check',
      'A#0 delete A-1',
    ]);
  });

  it('calls the newest handlers after an unrelated page re-render', async () => {
    await show([{ slot: 'page', project: 'A' }]);
    const first = sidebarValue();
    const before = { page: pageRenders, sidebar: sidebarRenders };

    await show([{ slot: 'page', project: 'A', tick: 1 }]);

    expect(pageRenders - before.page).toBe(rendersPerPass);
    // Same sessions: nothing new for the sidebar.
    expect(sidebarRenders).toBe(before.sidebar);
    expect(seen).toBe(first);
    await callAll(first, 'A-1');
    expect(calls).toEqual([
      'A#1 select A-1',
      'A#1 new',
      'A#1 more',
      'A#1 rename A-1 Salary check',
      'A#1 delete A-1',
    ]);
  });

  it('shows project B with no empty sidebar in between, from the same page', async () => {
    await show([{ slot: 'page', project: 'A' }]);
    const a = sidebarValue();
    const from = shown.length;

    await show([{ slot: 'page', project: 'B' }]);

    expect(shown.slice(from)).toEqual([sidebarValue()]);
    expect(sidebarValue().currentSessionId).toBe('B-1');
    expect(sidebarValue().sessions).toEqual([chatSession('B-1')]);
    // The same fixed callbacks, now reaching B.
    expect(sidebarValue().onSessionSelect).toBe(a.onSessionSelect);
    a.onSessionSelect('B-1');
    expect(calls).toEqual(['B#0 select B-1']);
  });

  it('shows project B with no empty sidebar in between, from a new page', async () => {
    await show([{ slot: 'A', project: 'A' }]);
    const from = shown.length;

    await show([{ slot: 'B', project: 'B' }]);

    expect(shown.slice(from)).toEqual([sidebarValue()]);
    expect(sidebarValue().currentSessionId).toBe('B-1');
    sidebarValue().onSessionSelect('B-1');
    expect(calls).toEqual(['B#0 select B-1']);
  });

  it('empties the sidebar when the page unmounts', async () => {
    await show([{ slot: 'page', project: 'A' }]);
    expect(seen).not.toBeNull();

    await show([]);

    expect(seen).toBeNull();
  });

  it("keeps the newer page's sessions when an older page unmounts later", async () => {
    await show([{ slot: 'A', project: 'A' }]);
    await show([
      { slot: 'A', project: 'A' },
      { slot: 'B', project: 'B' },
    ]);
    expect(sidebarValue().currentSessionId).toBe('B-1');
    const from = shown.length;

    await show([{ slot: 'B', project: 'B' }]);

    expect(shown.slice(from)).toEqual([]);
    expect(sidebarValue().currentSessionId).toBe('B-1');
    sidebarValue().onSessionSelect('B-1');
    expect(calls).toEqual(['B#0 select B-1']);
  });

  it('stops calling a page once it is gone', async () => {
    await show([{ slot: 'page', project: 'A' }]);
    const stale = sidebarValue();

    await show([]);
    await callAll(stale, 'A-1');

    expect(calls).toEqual([]);
  });
});
