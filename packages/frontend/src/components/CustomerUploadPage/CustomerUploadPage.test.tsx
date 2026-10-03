// @vitest-environment node
// The DOM comes from ../../test/jsdom (the stock jsdom environment cannot
// start in this workspace); it must be imported before testing-library.
import '../../test/jsdom';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ApiError } from '../../lib/apiError';
import type { PublicClient, PublicLink } from '../../lib/customerUploadPublic';
import { CONSENT_VERSION } from '../../data/customerUploadPage';
import { RuntimeConfigContext } from '../RuntimeConfig';
import CustomerUploadPage, { CustomerUploadFlow } from './index';

const io = vi.hoisted(() => ({
  put: vi.fn(),
  encrypted: vi.fn(),
}));

vi.mock('../../lib/customerUploadPublic', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/customerUploadPublic')>()),
  putWithProgress: io.put,
  isEncryptedPdf: io.encrypted,
}));

const DOC_LOCKED = '11111111-2222-3333-4444-555555555555';

function link(overrides: Partial<PublicLink> = {}): PublicLink {
  return {
    dsa_name: 'Verma Loan Services',
    items: [{ code: 'PAN_COPY' }, { code: 'OTHER', note: 'Rent agreement' }],
    language: 'en',
    expires_at: '2026-10-06T08:30:00+00:00',
    consented: true,
    consent_version: CONSENT_VERSION,
    file_count: 0,
    max_files: 20,
    max_file_bytes: 15 * 1024 * 1024,
    files: [],
    ...overrides,
  };
}

function fakeClient(get: () => PublicLink | Promise<PublicLink>) {
  return {
    get: vi.fn(async () => get()),
    consent: vi.fn(async () => undefined),
    createFile: vi.fn(async (r: { file_name: string }) => ({
      document_id: `doc-${r.file_name}`,
      upload_url: 'https://bucket.s3.amazonaws.com/key?sig',
      status: 'uploading',
    })),
    unlock: vi.fn(),
    submit: vi.fn(async () => 2),
  };
}

const asClient = (c: ReturnType<typeof fakeClient>) =>
  c as unknown as PublicClient;

const file = (name: string, type: string, size = 100) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

beforeEach(() => {
  io.put.mockReset();
  io.encrypted.mockReset();
  io.put.mockImplementation(
    async (
      _u: string,
      _f: File,
      _t: string,
      onProgress: (p: number) => void,
    ) => {
      onProgress(40);
      onProgress(100);
    },
  );
  io.encrypted.mockResolvedValue(false);
});

describe('CustomerUploadFlow', () => {
  it('asks to open the link again without a token (it is never stored)', () => {
    render(<CustomerUploadFlow client={null} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Open your link again',
    );
    expect(screen.queryByText('This link does not work any more')).toBeNull();
  });

  it('shows the same page for a 404 link', async () => {
    const client = fakeClient(() => {
      throw new ApiError(404, 'gone');
    });
    render(<CustomerUploadFlow client={asClient(client)} />);
    expect(
      await screen.findByText('This link does not work any more'),
    ).toBeTruthy();
  });

  it('shows "link does not work" for a 404 on consent', async () => {
    const client = fakeClient(() => link({ consented: false }));
    client.consent.mockRejectedValue(new ApiError(404, 'gone'));
    render(<CustomerUploadFlow client={asClient(client)} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Agree and continue' }));
    expect(
      await screen.findByText('This link does not work any more'),
    ).toBeTruthy();
  });

  it('shows "link does not work" for a 404 on a file', async () => {
    const client = fakeClient(() => link());
    client.createFile.mockRejectedValue(new ApiError(404, 'gone'));
    render(<CustomerUploadFlow client={asClient(client)} />);
    const input = await screen.findByTestId('files-input');
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [file('pan.jpg', 'image/jpeg')] },
      });
    });
    expect(
      await screen.findByText('This link does not work any more'),
    ).toBeTruthy();
    expect(io.put).not.toHaveBeenCalled();
  });

  it('shows "link does not work" when an unlock finds the link gone', async () => {
    let gone = false;
    const client = fakeClient(() => {
      if (gone) throw new ApiError(404, 'gone');
      return link({
        file_count: 1,
        files: [
          {
            document_id: DOC_LOCKED,
            file_name: 's.pdf',
            status: 'password_required',
            locked: true,
          },
        ],
      });
    });
    client.unlock.mockImplementation(async () => {
      gone = true;
      throw new ApiError(404, 'gone');
    });
    render(<CustomerUploadFlow client={asClient(client)} />);
    fireEvent.change(await screen.findByLabelText('PDF password'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(
      await screen.findByText('This link does not work any more'),
    ).toBeTruthy();
  });

  it('offers a retry after a network error', async () => {
    let calls = 0;
    const client = fakeClient(() => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return link();
    });
    render(<CustomerUploadFlow client={asClient(client)} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Add your documents')).toBeTruthy();
  });

  it('asks for consent first, in the link language, and logs it', async () => {
    let consented = false;
    const client = fakeClient(() => link({ language: 'hi', consented }));
    client.consent.mockImplementation(async () => {
      consented = true;
    });
    render(<CustomerUploadFlow client={asClient(client)} />);
    expect(await screen.findByText('आपकी सहमति')).toBeTruthy();
    expect(
      screen.getByText(/Verma Loan Services ने आपसे ये दस्तावेज़ माँगे हैं/),
    ).toBeTruthy();
    expect(screen.getByText(/7 दिनों के अंदर/)).toBeTruthy();
    // No upload controls before consent.
    expect(screen.queryByTestId('camera-input')).toBeNull();

    const agree = screen.getByRole('button', { name: 'सहमत हूँ, आगे बढ़ें' });
    expect((agree as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(agree);
    expect(await screen.findByText('अपने दस्तावेज़ जोड़ें')).toBeTruthy();
    expect(client.consent).toHaveBeenCalledWith('hi', CONSENT_VERSION);
  });

  it('switches the language, also for the consent call', async () => {
    const client = fakeClient(() => link({ consented: false }));
    render(<CustomerUploadFlow client={asClient(client)} />);
    await screen.findByText('Your consent');
    fireEvent.change(screen.getByLabelText('Language / भाषा'), {
      target: { value: 'mr' },
    });
    expect(screen.getByText('तुमची संमती')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'संमती देऊन पुढे जा' }));
    await waitFor(() =>
      expect(client.consent).toHaveBeenCalledWith('mr', CONSENT_VERSION),
    );
  });

  it('asks to reload when the consent text is out of date', async () => {
    const client = fakeClient(() => link({ consented: false }));
    client.consent.mockRejectedValue(new ApiError(409, 'Reload'));
    render(<CustomerUploadFlow client={asClient(client)} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Agree and continue' }));
    expect(
      await screen.findByText(
        'This page is out of date. Reload it to see the current text.',
      ),
    ).toBeTruthy();
  });

  it('has the camera input and a multi-file picker', async () => {
    render(<CustomerUploadFlow client={asClient(fakeClient(() => link()))} />);
    const camera = (await screen.findByTestId(
      'camera-input',
    )) as HTMLInputElement;
    expect(camera.getAttribute('accept')).toBe('image/*,application/pdf');
    expect(camera.getAttribute('capture')).toBe('environment');
    const files = screen.getByTestId('files-input') as HTMLInputElement;
    expect(files.multiple).toBe(true);
    expect(files.getAttribute('accept')).toBe('image/*,application/pdf');
    expect(
      screen.getByText('PDF files or photos', { exact: false }),
    ).toBeTruthy();
  });

  it('uploads the files, refuses the wrong ones and lists what arrived', async () => {
    let files: PublicLink['files'] = [];
    const client = fakeClient(() => link({ files, file_count: files.length }));
    client.createFile.mockImplementation(async (r: { file_name: string }) => {
      files = [
        ...files,
        {
          document_id: `doc-${r.file_name}`,
          file_name: r.file_name,
          status: 'uploading',
          locked: false,
        },
      ];
      return {
        document_id: `doc-${r.file_name}`,
        upload_url: 'https://bucket.s3.amazonaws.com/key?sig',
        status: 'uploading',
      };
    });
    render(<CustomerUploadFlow client={asClient(client)} />);
    const input = await screen.findByTestId('files-input');
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [
            file('pan.jpg', 'image/jpeg'),
            file('notes.docx', ''),
            file('huge.pdf', 'application/pdf', 16 * 1024 * 1024),
          ],
        },
      });
    });
    await waitFor(() => expect(screen.getByText('Received')).toBeTruthy());
    expect(client.createFile).toHaveBeenCalledTimes(1);
    expect(client.createFile).toHaveBeenCalledWith({
      file_name: 'pan.jpg',
      content_type: 'image/jpeg',
      file_size: 100,
      encrypted: false,
    });
    expect(io.put).toHaveBeenCalledWith(
      'https://bucket.s3.amazonaws.com/key?sig',
      expect.any(File),
      'image/jpeg',
      expect.any(Function),
    );
    expect(
      screen.getByText(
        'Only PDF files and photos (JPG, PNG, WebP) can be added.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('This file is larger than 15 MB.')).toBeTruthy();
    // Only a PDF is checked for a password.
    expect(io.encrypted).not.toHaveBeenCalled();
  });

  it('flags an encrypted PDF and shows a failed upload', async () => {
    io.encrypted.mockResolvedValue(true);
    io.put.mockRejectedValue(new Error('Upload failed (403)'));
    const client = fakeClient(() => link());
    render(<CustomerUploadFlow client={asClient(client)} />);
    const input = await screen.findByTestId('files-input');
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [file('statement.pdf', 'application/pdf')] },
      });
    });
    await waitFor(() =>
      expect(
        screen.getByText('Upload failed. Please add it again.'),
      ).toBeTruthy(),
    );
    expect(client.createFile).toHaveBeenCalledWith(
      expect.objectContaining({ file_name: 'statement.pdf', encrypted: true }),
    );
  });

  it('stops at the link limit (client count and the server 409)', async () => {
    const client = fakeClient(() => link({ file_count: 19, max_files: 20 }));
    client.createFile.mockRejectedValueOnce(new ApiError(409, 'full'));
    render(<CustomerUploadFlow client={asClient(client)} />);
    const input = await screen.findByTestId('files-input');
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [file('a.jpg', 'image/jpeg'), file('b.jpg', 'image/jpeg')],
        },
      });
    });
    await waitFor(() =>
      expect(
        screen.getAllByText('No more files can be added to this link.'),
      ).toHaveLength(2),
    );
    expect(client.createFile).toHaveBeenCalledTimes(1);
  });

  it('unlocks a protected PDF, clears the field and counts tries', async () => {
    let status = 'password_required';
    const client = fakeClient(() =>
      link({
        file_count: 1,
        files: [
          {
            document_id: DOC_LOCKED,
            file_name: 'statement.pdf',
            status,
            locked: status === 'password_required',
          },
        ],
      }),
    );
    client.unlock
      .mockResolvedValueOnce({ status: 'wrong_password', attemptsLeft: 4 })
      .mockImplementationOnce(async () => {
        status = 'uploaded';
        return { status: 'unlocked' };
      });
    render(<CustomerUploadFlow client={asClient(client)} />);
    expect(await screen.findByText('Password needed')).toBeTruthy();
    expect(screen.getByText(/Some PDFs still need a password/)).toBeTruthy();

    const field = screen.getByLabelText('PDF password') as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('off');
    fireEvent.change(field, { target: { value: 'wrong-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(
      await screen.findByText('Wrong password. 4 tries left.'),
    ).toBeTruthy();
    expect(field.value).toBe('');

    fireEvent.change(field, { target: { value: 'right-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByText('Received')).toBeTruthy();
    expect(screen.queryByLabelText('PDF password')).toBeNull();
    expect(client.unlock).toHaveBeenNthCalledWith(2, DOC_LOCKED, 'right-2');
  });

  it('blocks the form after too many tries', async () => {
    const client = fakeClient(() =>
      link({
        file_count: 1,
        files: [
          {
            document_id: DOC_LOCKED,
            file_name: 's.pdf',
            status: 'password_required',
            locked: true,
          },
        ],
      }),
    );
    client.unlock.mockRejectedValue(new ApiError(429, 'Too many'));
    render(<CustomerUploadFlow client={asClient(client)} />);
    fireEvent.change(await screen.findByLabelText('PDF password'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(
      await screen.findByText(
        'Too many tries. Your loan advisor will ask you for the password.',
      ),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText('PDF password') as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('marks an earlier record without its file as not received', async () => {
    const client = fakeClient(() =>
      link({
        file_count: 1,
        files: [
          {
            document_id: 'd-1',
            file_name: 'old.jpg',
            status: 'uploading',
            locked: false,
          },
        ],
      }),
    );
    render(<CustomerUploadFlow client={asClient(client)} />);
    expect(
      await screen.findByText('Not received. Please add it again.'),
    ).toBeTruthy();
  });

  it('submits only once something arrived, then thanks the customer', async () => {
    const empty = fakeClient(() => link());
    const { unmount } = render(<CustomerUploadFlow client={asClient(empty)} />);
    const disabled = (await screen.findByRole('button', {
      name: 'Submit documents',
    })) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    unmount();

    const client = fakeClient(() =>
      link({
        file_count: 2,
        files: [
          {
            document_id: 'd-1',
            file_name: 'pan.jpg',
            status: 'uploaded',
            locked: false,
          },
          {
            document_id: 'd-2',
            file_name: 'bank.pdf',
            status: 'processing',
            locked: false,
          },
        ],
      }),
    );
    render(<CustomerUploadFlow client={asClient(client)} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Submit documents' }),
    );
    expect(await screen.findByText('Thank you!')).toBeTruthy();
    expect(
      screen.getByText(
        '2 file(s) sent to Verma Loan Services. You can close this page.',
      ),
    ).toBeTruthy();
    expect(client.submit).toHaveBeenCalledTimes(1);
  });

  it('shows the closed-link page when submit finds the link gone', async () => {
    const client = fakeClient(() =>
      link({
        file_count: 1,
        files: [
          {
            document_id: 'd-1',
            file_name: 'pan.jpg',
            status: 'uploaded',
            locked: false,
          },
        ],
      }),
    );
    client.submit.mockRejectedValue(new ApiError(404, 'gone'));
    render(<CustomerUploadFlow client={asClient(client)} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Submit documents' }),
    );
    expect(
      await screen.findByText('This link does not work any more'),
    ).toBeTruthy();
  });

  it('lists the requested items with their notes', async () => {
    render(<CustomerUploadFlow client={asClient(fakeClient(() => link()))} />);
    expect(await screen.findByText('Rent agreement')).toBeTruthy();
    expect(screen.getByText(/This link works till/)).toBeTruthy();
  });
});

describe('CustomerUploadPage (the /u page as main.tsx renders it)', () => {
  const TOKEN = 'Tk'.repeat(21) + 'Z';
  const OTHER = 'Q'.repeat(42) + '9';
  const BACKEND = 'https://api.example.com/';

  function backend(status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 200 ? JSON.stringify(link()) : null, {
        status,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return calls;
  }

  const page = (token: string | null) => (
    // Only the runtime config: no AuthProvider (CognitoAuth) above the page.
    <RuntimeConfigContext.Provider value={{ apis: { Backend: BACKEND } }}>
      <CustomerUploadPage initialToken={token} />
    </RuntimeConfigContext.Provider>
  );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('works without any sign-in and sends the token only in its header', async () => {
    const calls = backend();
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) => vi.spyOn(console, level),
    );
    const stored = [
      vi.spyOn(window.localStorage, 'setItem'),
      vi.spyOn(window.sessionStorage, 'setItem'),
    ];
    render(page(TOKEN));
    expect(await screen.findByText('Add your documents')).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/public/upload-link');
    expect(calls[0].url).not.toContain(TOKEN);
    expect(
      (calls[0].init.headers as Record<string, string>)['X-Upload-Token'],
    ).toBe(TOKEN);
    expect(calls[0].init.credentials).toBe('omit');
    expect(calls[0].init.referrerPolicy).toBe('no-referrer');
    // Never logged, never stored, never in the address bar.
    for (const spy of [...logs, ...stored]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    }
    expect(window.location.href).not.toContain(TOKEN);
    expect(JSON.stringify(window.history.state)).not.toContain(TOKEN);
  });

  it('asks a reload without the fragment to open the link again', () => {
    const calls = backend();
    render(page(null));
    expect(screen.getByText('Open your link again')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('takes a link opened again in the same tab (fragment only) and clears it', async () => {
    const calls = backend();
    window.history.replaceState(null, '', '/u');
    render(page(null));
    expect(screen.getByText('Open your link again')).toBeTruthy();
    // jsdom fires hashchange on a later task, like a browser.
    window.location.hash = `#${OTHER}`;
    expect(await screen.findByText('Add your documents')).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(
      (calls[0].init.headers as Record<string, string>)['X-Upload-Token'],
    ).toBe(OTHER);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/u');
  });

  it('shows "link does not work" for a 404, like every other refused link', async () => {
    backend(404);
    render(page(TOKEN));
    expect(
      await screen.findByText('This link does not work any more'),
    ).toBeTruthy();
  });
});
