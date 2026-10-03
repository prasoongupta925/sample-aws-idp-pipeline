// @vitest-environment node
// The DOM comes from ../../test/jsdom (the stock jsdom environment cannot
// start in this workspace); it must be imported before testing-library.
import '../../test/jsdom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import en from '../../i18n/locales/en.json';
import type { Project } from '../ProjectSettingsModal';
import { Route } from '../../routes/call-recordings';

const api = vi.hoisted(() => ({ fetchApi: vi.fn() }));

vi.mock('../../hooks/useAwsClient', () => ({
  useAwsClient: () => ({ fetchApi: api.fetchApi }),
}));

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
});

const project = (project_id: string, name: string): Project => ({
  project_id,
  name,
  description: '',
  status: 'active',
  created_by: 'asha.verma',
  language: 'en',
  color: null,
  created_at: '2026-09-20T09:00:00Z',
  updated_at: '2026-09-28T09:00:00Z',
});

const PROJECTS = [
  project('p-sneha', 'Sneha Kulkarni – Personal Loan'),
  project('p-week', 'Telecaller QA – Week 40'),
  project('p-calls', 'Telecaller QA – Sample calls'),
];

/** S3 through a fake XMLHttpRequest: each PUT is recorded and succeeds. */
const puts: { url: string; type: string; name: string }[] = [];

class FakeXhr {
  url = '';
  type = '';
  status = 0;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    if (name === 'Content-Type') this.type = value;
  }
  send(file: File) {
    puts.push({ url: this.url, type: this.type, name: file.name });
    setTimeout(() => {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded: file.size / 2,
        total: file.size,
      } as ProgressEvent);
      this.status = 200;
      this.onload?.();
    }, 0);
  }
}

let documents = 0;

beforeEach(() => {
  puts.length = 0;
  documents = 0;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  api.fetchApi.mockReset();
  api.fetchApi.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === 'projects') return PROJECTS;
    if (init?.method === 'POST') {
      documents += 1;
      return {
        document_id: `doc-${documents}`,
        upload_url: `https://s3.example/put/doc-${documents}`,
      };
    }
    return undefined;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage(entry = '/call-recordings') {
  const Page = Route.options.component;
  if (!Page) throw new Error('the /call-recordings route has no component');
  const rootRoute = createRootRoute({ component: Outlet });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/call-recordings',
      validateSearch: Route.options.validateSearch,
      component: Page,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => null,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/projects/$projectId',
      component: () => null,
    }),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  );
}

const recording = (name: string, type = '') =>
  new File([new Uint8Array(4096)], name, { type });

async function pick(...files: File[]) {
  const input = await screen.findByTestId('call-recordings-input');
  fireEvent.change(input, { target: { files } });
}

describe('upload call recordings', () => {
  it('offers the Telecaller QA projects, Sample calls first', async () => {
    renderPage();

    const select = (await screen.findByRole('combobox', {
      name: 'Telecaller QA project',
    })) as HTMLSelectElement;
    expect(select.value).toBe('p-calls');
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      'Telecaller QA – Sample calls',
      'Telecaller QA – Week 40',
    ]);
    expect(
      screen.getByTestId('call-recordings-input').getAttribute('accept'),
    ).toBe('.mp3,.m4a,.wav,.amr,.ogg,.webm,audio/*');
    expect(
      (
        screen.getByRole('button', {
          name: 'Upload 1 recording',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('preselects the project in the link', async () => {
    renderPage('/call-recordings?project=p-week');

    const select = (await screen.findByRole('combobox', {
      name: 'Telecaller QA project',
    })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('p-week'));
  });

  it('uploads the recordings to the project for Transcribe and lists the refused files', async () => {
    renderPage();
    await screen.findByRole('combobox', { name: 'Telecaller QA project' });

    await pick(
      recording('call_1020.amr'),
      recording('call_1045.webm', 'video/webm'),
      recording('bank_statement.pdf', 'application/pdf'),
    );

    expect(
      screen.getByText(/bank_statement\.pdf: not a supported recording format/),
    ).toBeTruthy();
    expect(screen.getAllByText(/Ready/)).toHaveLength(2);

    fireEvent.click(
      screen.getByRole('button', { name: 'Upload 2 recordings' }),
    );

    expect(
      (await screen.findByTestId('call-recordings-done')).textContent,
    ).toContain('2 recordings uploaded');
    expect(screen.getAllByText(/Uploaded/)).toHaveLength(2);
    expect(
      screen
        .getByRole('link', { name: 'Open the project' })
        .getAttribute('href'),
    ).toBe('/projects/p-calls');

    const posts = api.fetchApi.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(posts.map(([url]) => url)).toEqual([
      'projects/p-calls/documents',
      'projects/p-calls/documents',
    ]);
    expect(posts.map(([, init]) => JSON.parse(init.body))).toEqual([
      {
        file_name: 'call_1020.amr',
        content_type: 'audio/amr',
        file_size: 4096,
        use_bda: false,
        use_ocr: false,
        use_transcribe: true,
      },
      {
        file_name: 'call_1045.webm',
        content_type: 'audio/webm',
        file_size: 4096,
        use_bda: false,
        use_ocr: false,
        use_transcribe: true,
      },
    ]);
    // S3 gets the type the URL was signed for.
    expect(puts).toEqual([
      {
        url: 'https://s3.example/put/doc-1',
        type: 'audio/amr',
        name: 'call_1020.amr',
      },
      {
        url: 'https://s3.example/put/doc-2',
        type: 'audio/webm',
        name: 'call_1045.webm',
      },
    ]);
    const statuses = api.fetchApi.mock.calls.filter(
      ([, init]) => init?.method === 'PUT',
    );
    expect(statuses.map(([url]) => url)).toEqual([
      'projects/p-calls/documents/doc-1/status',
      'projects/p-calls/documents/doc-2/status',
    ]);
  });

  it("shows the backend's reason when a recording is refused, and retries it", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let refuse = true;
    api.fetchApi.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'projects') return PROJECTS;
      if (init?.method === 'POST') {
        if (refuse) {
          const { ApiError } = await import('../../lib/apiError');
          throw new ApiError(400, 'File size exceeds 500MB limit');
        }
        return { document_id: 'doc-9', upload_url: 'https://s3.example/9' };
      }
      return undefined;
    });
    renderPage();
    await screen.findByRole('combobox', { name: 'Telecaller QA project' });
    await pick(recording('call_0930.mp3', 'audio/mpeg'));

    fireEvent.click(screen.getByRole('button', { name: 'Upload 1 recording' }));

    expect(
      await screen.findByText(/Failed: File size exceeds 500MB limit/),
    ).toBeTruthy();
    expect(screen.queryByTestId('call-recordings-done')).toBeNull();

    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Upload 1 recording' }));
    expect(
      (await screen.findByTestId('call-recordings-done')).textContent,
    ).toContain('1 recording uploaded');
  });

  it('explains what to do without a Telecaller QA project', async () => {
    api.fetchApi.mockImplementation(async () => [PROJECTS[0]]);
    renderPage();

    expect(
      await screen.findByText(/No Telecaller QA project yet/),
    ).toBeTruthy();
    await pick(recording('call_0930.mp3', 'audio/mpeg'));
    expect(
      (
        screen.getByRole('button', {
          name: 'Upload 1 recording',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
