// @vitest-environment node
// The project page through a silent token renewal (about hourly). It used to
// load again: the full-page loader replaced it, so the chat, the panels and
// any open dialog (with a just-made customer upload link) were remounted.
// The DOM comes from ../test/jsdom (the stock jsdom environment cannot start
// in this workspace); it must be imported before testing-library.
import '../test/jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, render, screen, waitFor } from '@testing-library/react';
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
import { ToastProvider } from './Toast';
import { Route } from '../routes/projects/$projectId';

type Logins = { logins: Record<string, string> };

/** The signed-in user. A renewal re-renders every useAuth() caller, as react-oidc-context does. */
const auth = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const userWith = (idToken: string) => ({
    id_token: idToken,
    profile: { 'cognito:username': 'asha.verma' },
  });
  let state = { user: userWith('token-1') };
  return {
    get: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    renew: (idToken: string) => {
      state = { user: userWith(idToken) };
      listeners.forEach((listener) => listener());
    },
    reset: () => {
      state = { user: userWith('token-1') };
    },
  };
});
const cognito = vi.hoisted(() => ({ fetch: vi.fn() }));
const signer = vi.hoisted(() => ({
  clients: [] as Record<string, unknown>[],
  fetch: vi.fn(),
}));
/** true: useAwsClient hands out a new fetchApi for each user, as before the fix. */
const client = vi.hoisted(() => ({ newFetchApiPerUser: false }));
/** Stand-ins for the page's children: their latest props and render counts. */
const ui = vi.hoisted(() => {
  const props: Record<string, Record<string, unknown>> = {};
  const renders: Record<string, number> = {};
  return {
    props,
    renders,
    /** A module whose component renders <div data-testid={name}>. */
    standIn: async (name: string) => {
      const { createElement } = await import('react');
      return {
        default: (p: Record<string, unknown>) => {
          props[name] = p;
          renders[name] = (renders[name] ?? 0) + 1;
          return createElement('div', { 'data-testid': name });
        },
      };
    },
  };
});

vi.mock('react-oidc-context', async () => {
  const { useSyncExternalStore } = await import('react');
  return { useAuth: () => useSyncExternalStore(auth.subscribe, auth.get) };
});
vi.mock('../hooks/useRuntimeConfig', () => {
  const config = {
    apis: { Backend: 'https://api.example.test/' },
    cognitoProps: {
      region: 'ap-south-1',
      identityPoolId: 'ap-south-1:test-identity-pool',
      userPoolId: 'ap-south-1_TestPool',
      userPoolWebClientId: 'test-client',
    },
  };
  return { useRuntimeConfig: () => config };
});
vi.mock('@aws-sdk/credential-provider-cognito-identity', () => ({
  fromCognitoIdentityPool: (params: Logins) => () => cognito.fetch(params),
}));
vi.mock('aws4fetch', () => ({
  AwsClient: class {
    constructor(options: Record<string, unknown>) {
      signer.clients.push(options);
    }
    fetch(url: string, init?: RequestInit) {
      return signer.fetch(url, init);
    }
  },
}));
vi.mock('../hooks/useAwsClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useAwsClient')>();
  const { useCallback, useSyncExternalStore } = await import('react');
  return {
    ...actual,
    useAwsClient: () => {
      const aws = actual.useAwsClient();
      const { user } = useSyncExternalStore(auth.subscribe, auth.get);
      const { fetchApi } = aws;
      const perUser = useCallback(
        <T,>(path: string, init?: RequestInit) => fetchApi<T>(path, init),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [fetchApi, user],
      );
      return client.newFetchApiPerUser ? { ...aws, fetchApi: perUser } : aws;
    },
  };
});
vi.mock('../contexts/WebSocketContext', () => {
  const socket = {
    status: 'disconnected',
    sendMessage: () => undefined,
    subscribe: () => () => undefined,
  };
  return { useWebSocket: () => socket, useWebSocketMessage: () => undefined };
});
vi.mock('./ChatPanel', () => ui.standIn('ChatPanel'));
vi.mock('./SidePanel', () => ui.standIn('SidePanel'));
vi.mock('./CustomerUploadLinks/RequestDocumentsModal', () =>
  ui.standIn('RequestDocumentsModal'),
);
vi.mock('./CubeLoader', () => ui.standIn('CubeLoader'));
// Not under test here: nothing rendered.
vi.mock('./ProjectNavBar', () => ({ default: () => null }));
vi.mock('./ProjectSettingsModal', () => ({
  default: () => null,
  CARD_COLORS: [{ glow: 'transparent' }],
}));
vi.mock('./WorkflowDetailModal', () => ({ default: () => null }));
vi.mock('./AgentSelectModal', () => ({ default: () => null }));
vi.mock('./DocumentUploadModal', () => ({ default: () => null }));
vi.mock('./CustomerUploadLinks/UnlockPdfModal', () => ({
  default: () => null,
}));
vi.mock('./ArtifactViewer', () => ({ default: () => null }));
vi.mock('./FileCheckPanel', () => ({ default: () => null }));
vi.mock('./EligibilityPanel', () => ({ default: () => null }));
vi.mock('./DsaPainPointsPanel', () => ({ default: () => null }));
vi.mock('./SystemPromptModal', () => ({ default: () => null }));
vi.mock('./ProjectGraphModal', () => ({ default: () => null }));
vi.mock('./ui/resizable', () => ({
  ResizablePanelGroup: () => null,
  ResizablePanel: () => null,
  ResizableHandle: () => null,
}));

const BACKEND = 'https://api.example.test/';
const LOGIN = 'cognito-idp.ap-south-1.amazonaws.com/ap-south-1_TestPool';

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

/** The backend's answer to a GET of `path`. */
function answer(path: string): unknown {
  const project = /^projects\/([^/?]+)$/.exec(path);
  if (project) {
    return {
      project_id: project[1],
      name: `Test file ${project[1]}`,
      description: '',
      status: 'active',
      created_by: 'asha.verma',
      language: 'en',
      color: 0,
      created_at: '2026-09-20T09:00:00Z',
      updated_at: '2026-10-01T10:00:00Z',
    };
  }
  if (path.startsWith('chat/projects/')) {
    return { sessions: [], next_cursor: null };
  }
  if (path.startsWith('artifacts?')) return { items: [] };
  if (path === 'chat/models') return { models: [] };
  return [];
}

beforeEach(() => {
  localStorage.clear();
  auth.reset();
  client.newFetchApiPerUser = false;
  for (const name of Object.keys(ui.props)) delete ui.props[name];
  for (const name of Object.keys(ui.renders)) delete ui.renders[name];
  cognito.fetch.mockReset();
  cognito.fetch.mockImplementation(async ({ logins }: Logins) => ({
    accessKeyId: `ASIA-${logins[LOGIN]}`,
    secretAccessKey: 'test-secret',
    sessionToken: `session-${logins[LOGIN]}`,
    expiration: new Date(Date.now() + 60 * 60 * 1000),
  }));
  signer.clients.length = 0;
  signer.fetch.mockReset();
  signer.fetch.mockImplementation(
    async (url: string) =>
      new Response(JSON.stringify(answer(url.slice(BACKEND.length)))),
  );
});

/** Paths of the backend requests, in order. */
const requests = () =>
  signer.fetch.mock.calls.map(([url]) => (url as string).slice(BACKEND.length));

/** The id_token of each identity pool request, in order. */
const tokensSent = () =>
  cognito.fetch.mock.calls.map(([params]) => (params as Logins).logins[LOGIN]);

/** The six requests that load a project (in any order). */
const projectLoad = (id: string) =>
  [
    `projects/${id}`,
    `projects/${id}/documents`,
    `projects/${id}/workflows`,
    `chat/projects/${id}/sessions`,
    `projects/${id}/agents`,
    `artifacts?project_id=${id}`,
  ].sort();

const loadsOf = (id: string) =>
  requests()
    .filter((path) => projectLoad(id).includes(path))
    .sort();

/** Lets pending requests and their state updates finish. */
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 20)));

/** The project page, opened on a project, with the customer upload dialog open. */
async function openProject() {
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
    history: createMemoryHistory({ initialEntries: ['/projects/p-1'] }),
  });
  render(
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </I18nextProvider>,
  );

  const chat = await screen.findByTestId('ChatPanel', {}, { timeout: 5000 });
  await waitFor(() => expect(requests()).toContain('chat/models'));
  await settle();
  // The dialog keeps the upload link it made in its own state.
  act(() => (ui.props.SidePanel.onRequestFromCustomer as () => void)());
  expect(ui.props.RequestDocumentsModal.isOpen).toBe(true);
  expect(loadsOf('p-1')).toEqual(projectLoad('p-1'));

  return {
    router,
    chat,
    side: screen.getByTestId('SidePanel'),
    dialog: screen.getByTestId('RequestDocumentsModal'),
  };
}

describe('project page through a token renewal', () => {
  it('stays as it is: no loader, nothing remounted, nothing loaded again', async () => {
    const page = await openProject();
    const loaderRenders = ui.renders.CubeLoader;
    const sent = requests().length;
    const onModelChange = ui.props.ChatPanel.onModelChange;

    await act(async () => auth.renew('token-2'));
    await settle();

    expect(ui.renders.CubeLoader).toBe(loaderRenders);
    expect(screen.getByTestId('ChatPanel')).toBe(page.chat);
    expect(screen.getByTestId('SidePanel')).toBe(page.side);
    expect(screen.getByTestId('RequestDocumentsModal')).toBe(page.dialog);
    expect(ui.props.RequestDocumentsModal.isOpen).toBe(true);
    expect(ui.props.ChatPanel.onModelChange).toBe(onModelChange);
    expect(requests()).toHaveLength(sent);
  });

  it('asks the backend with credentials for the renewed token afterwards', async () => {
    await openProject();
    await act(async () => auth.renew('token-2'));
    const asked = tokensSent().length;

    await act(() =>
      (ui.props.SidePanel.onRefreshDocuments as () => Promise<void>)(),
    );

    expect(requests().at(-1)).toBe('projects/p-1/documents');
    expect(tokensSent().slice(asked)).toEqual(['token-2']);
    expect(signer.clients.at(-1)).toMatchObject({
      accessKeyId: 'ASIA-token-2',
    });
  });

  it('does not load again even if fetchApi changes with the user: the load is keyed on the project', async () => {
    client.newFetchApiPerUser = true;
    const page = await openProject();
    const loaderRenders = ui.renders.CubeLoader;

    await act(async () => auth.renew('token-2'));
    await settle();

    expect(ui.renders.CubeLoader).toBe(loaderRenders);
    expect(screen.getByTestId('ChatPanel')).toBe(page.chat);
    expect(screen.getByTestId('RequestDocumentsModal')).toBe(page.dialog);
    expect(ui.props.RequestDocumentsModal.isOpen).toBe(true);
    expect(loadsOf('p-1')).toEqual(projectLoad('p-1'));
  });

  it('still loads a project it switches to, behind the loader', async () => {
    const page = await openProject();
    const loaderRenders = ui.renders.CubeLoader;

    await act(() =>
      page.router.navigate({
        to: '/projects/$projectId',
        params: { projectId: 'p-2' },
      }),
    );
    await waitFor(() =>
      expect(ui.props.ChatPanel.projectName).toBe('Test file p-2'),
    );

    expect(ui.renders.CubeLoader).toBeGreaterThan(loaderRenders);
    expect(screen.queryByTestId('CubeLoader')).toBeNull();
    expect(loadsOf('p-2')).toEqual(projectLoad('p-2'));
    expect(loadsOf('p-1')).toEqual(projectLoad('p-1'));
  });
});

describe('project page hook dependencies', () => {
  it('lists chatSession fields, never the whole object (new on every render)', () => {
    const page = readFileSync(
      fileURLToPath(
        new URL('../routes/projects/$projectId.tsx', import.meta.url),
      ),
      'utf8',
    );
    // Every [...] list that closes a call: hook dependency lists and the like.
    const lists = [...page.matchAll(/\[([^[\]]*)\]\s*,?\s*\)/g)].map(
      (m) => m[1],
    );
    expect(
      lists.filter((deps) => /\bchatSession\b(?!\s*\.)/.test(deps)),
    ).toEqual([]);
  });
});
