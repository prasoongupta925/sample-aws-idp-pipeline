// @vitest-environment node
// The real project page must load, publish its chat sessions to the sidebar and
// then stay idle. On 6 Oct it re-rendered without end (React #185): a hook
// dependency changed on every render. The DOM comes from ./jsdom (the stock
// jsdom environment cannot start in this workspace); it must be imported before
// react-dom. Kept out of src/routes so the router plugin never sees it.
import './jsdom';
import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import { ToastProvider } from '../components/Toast';
import {
  SidebarSessionProvider,
  useSidebarSessions,
} from '../contexts/SidebarSessionContext';
import { Route } from '../routes/projects/$projectId';

const api = vi.hoisted(() => {
  const fetchApi = vi.fn(async (url: string) => {
    if (url === 'chat/models') return { models: [] };
    if (/\/sessions(\?|$)/.test(url))
      return { sessions: [], next_cursor: null };
    if (url.startsWith('prompts/')) return { content: '' };
    if (/^projects\/[^/]+$/.test(url))
      return {
        project_id: 'p1',
        name: 'Loop check',
        description: '',
        status: 'active',
        created_by: 'asha.verma',
        language: 'en',
        color: 0,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      };
    return [];
  });
  return {
    client: {
      fetchApi,
      fetchApiBlob: vi.fn(),
      invokeAgent: vi.fn(),
      getCredentials: vi.fn(),
      getDocumentDownloadUrl: vi.fn(),
      getArtifactDownloadUrl: vi.fn(),
      bidiAgentRuntimeArn: '',
      userId: 'u1',
    },
    ws: {
      status: 'disconnected' as const,
      subscribe: () => () => undefined,
      sendMessage: () => undefined,
    },
    auth: {
      user: { profile: { email: 'asha.verma@example.com' }, id_token: 't' },
      isAuthenticated: true,
      isLoading: false,
    },
    // Renders of the page component, which calls usePanelLayout once per render.
    pageRenders: { count: 0 },
  };
});

vi.mock('../hooks/useAwsClient', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAwsClient: () => api.client,
}));
vi.mock('../contexts/WebSocketContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWebSocket: () => api.ws,
  useWebSocketMessage: () => undefined,
}));
vi.mock('../hooks/usePanelLayout', async (importOriginal) => {
  const m = await importOriginal<typeof import('../hooks/usePanelLayout')>();
  return {
    ...m,
    usePanelLayout: (...args: Parameters<typeof m.usePanelLayout>) => {
      api.pageRenders.count += 1;
      return m.usePanelLayout(...args);
    },
  };
});
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(),
  version: 'stub',
}));
vi.mock('react-oidc-context', () => ({ useAuth: () => api.auth }));
vi.mock('../hooks/useRuntimeConfig', () => ({
  useRuntimeConfig: () => ({ apis: {}, cognitoProps: undefined }),
}));

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
  // Browser APIs the page's components use and jsdom lacks.
  class NoopObserver {
    observe() {
      return undefined;
    }
    unobserve() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  }
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver ??= NoopObserver;
  g.IntersectionObserver ??= NoopObserver;
  window.matchMedia ??= ((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.HTMLElement.prototype.scrollIntoView ??= () => undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('the project page settles and stays idle', async () => {
  // The real scheduler, not act(): a loop yields between renders instead of
  // hanging the test.
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  g.IS_REACT_ACT_ENVIRONMENT = false;
  const Page = Route.options.component;
  if (!Page) throw new Error('the project route has no component');
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/projects/$projectId',
        component: Page,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/projects/p1'] }),
  });
  let resolved = false;
  router.subscribe('onResolved', () => {
    resolved = true;
  });

  let pageCommits = 0;
  let sidebarRenders = 0;
  let seen: ReturnType<typeof useSidebarSessions> = null;
  function Sidebar() {
    sidebarRenders += 1;
    seen = useSidebarSessions();
    return null;
  }
  const counts = () => ({
    renders: api.pageRenders.count,
    commits: pageCommits,
    sidebar: sidebarRenders,
  });

  const errors: string[] = [];
  const consoleError = vi.spyOn(console, 'error');
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container, {
    onUncaughtError: (error) => {
      errors.push(String(error));
    },
    onCaughtError: (error) => {
      errors.push(`caught: ${String(error)}`);
    },
  });
  try {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ToastProvider>
          <SidebarSessionProvider>
            <Sidebar />
            <Profiler
              id="page"
              onRender={() => {
                pageCommits += 1;
              }}
            >
              <RouterProvider router={router} />
            </Profiler>
          </SidebarSessionProvider>
        </ToastProvider>
      </I18nextProvider>,
    );

    // Load and settle: the router has resolved the page and nothing rendered
    // for a second. A render loop never settles; it meets the idle check
    // after 10 s.
    const start = performance.now();
    let last = JSON.stringify(counts());
    let quietSince = start;
    while (performance.now() - start < 10000) {
      await sleep(100);
      const now = JSON.stringify(counts());
      if (now !== last) {
        last = now;
        quietSince = performance.now();
      } else if (resolved && seen && performance.now() - quietSince >= 1000) {
        break;
      }
    }
    const settled = counts();

    await sleep(1500); // idle

    expect(errors).toEqual([]);
    expect(settled.renders).toBeGreaterThan(0);
    expect(seen).not.toBeNull();
    expect(counts()).toEqual(settled);
    expect(
      consoleError.mock.calls
        .map((args) => args.map(String).join(' '))
        .filter((message) => /Maximum update depth/.test(message)),
    ).toEqual([]);
  } finally {
    root.unmount();
    container.remove();
    consoleError.mockRestore();
  }
}, 30000);
