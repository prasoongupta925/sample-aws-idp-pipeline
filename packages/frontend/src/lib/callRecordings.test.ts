// @vitest-environment node
import type { Project } from '../components/ProjectSettingsModal';
import {
  CALL_RECORDING_ACCEPT,
  MAX_RECORDING_BYTES,
  asCallRecording,
  defaultCallProject,
  putWithProgress,
  recordingUploadRequest,
  telecallerProjects,
  uploadRecording,
} from './callRecordings';
import type { FetchApi } from './presignedUrls';

const project = (
  project_id: string,
  name: string,
  more: Partial<Project> = {},
): Project => ({
  project_id,
  name,
  description: '',
  status: 'active',
  created_by: 'asha.verma',
  language: 'en',
  color: null,
  created_at: '2026-09-20T09:00:00Z',
  updated_at: '2026-09-28T09:00:00Z',
  ...more,
});

const recording = (name: string, type = '', size = 2048) =>
  new File([new Uint8Array(size)], name, { type });

describe('asCallRecording', () => {
  it.each([
    ['call_0930.mp3', 'audio/mpeg', 'audio/mpeg'],
    ['Call recording Rohan Iyer.m4a', 'audio/x-m4a', 'audio/mp4'],
    ['call_1015.WAV', 'audio/wav', 'audio/wav'],
    ['call_1020.amr', '', 'audio/amr'],
    ['call_1025.amr', 'application/octet-stream', 'audio/amr'],
    ['call_1030.ogg', 'application/ogg', 'audio/ogg'],
    // Pickers report WebM as video: a call recording is audio.
    ['call_1045.webm', 'video/webm', 'audio/webm'],
  ])('%s (%s) is sent as %s', (name, type, sent) => {
    const result = asCallRecording(recording(name, type));
    if (!('file' in result)) throw new Error(`refused: ${result.problem}`);
    expect(result.file.type).toBe(sent);
    expect(result.file.name).toBe(name);
    expect(result.file.size).toBe(2048);
  });

  it('keeps the same file when its type is already right', () => {
    const file = recording('call.mp3', 'audio/mpeg');
    expect(asCallRecording(file)).toEqual({ file });
  });

  it.each([
    ['call.aac', 'audio/aac'],
    ['call.3gp', 'audio/3gpp'],
    ['bank_statement.pdf', 'application/pdf'],
    ['site_visit.mp4', 'video/mp4'],
    ['mp3', 'audio/mpeg'],
  ])('refuses %s: not a supported recording format', (name, type) => {
    expect(asCallRecording(recording(name, type))).toEqual({
      problem: 'format',
    });
  });

  it('refuses an empty or too large recording', () => {
    expect(asCallRecording(recording('call.mp3', 'audio/mpeg', 0))).toEqual({
      problem: 'empty',
    });
    const big = recording('call.mp3', 'audio/mpeg', 1);
    Object.defineProperty(big, 'size', { value: MAX_RECORDING_BYTES + 1 });
    expect(asCallRecording(big)).toEqual({ problem: 'tooLarge' });
  });

  it('offers the six formats and audio/* in the picker', () => {
    expect(CALL_RECORDING_ACCEPT.split(',')).toEqual([
      '.mp3',
      '.m4a',
      '.wav',
      '.amr',
      '.ogg',
      '.webm',
      'audio/*',
    ]);
  });
});

describe('telecallerProjects', () => {
  const projects = [
    project('p-sneha', 'Sneha Kulkarni – Personal Loan'),
    project('p-qa-new', 'Telecaller QA – Week 40', {
      updated_at: '2026-10-02T09:00:00Z',
    }),
    project('p-calls', 'Telecaller QA – Sample calls'),
    project('p-review', 'Branch calls', {
      description: 'Call QA of the Pune branch',
      updated_at: '2026-10-01T09:00:00Z',
    }),
  ];

  it('keeps the Telecaller QA projects, Sample calls first, then the newest', () => {
    expect(telecallerProjects(projects).map((p) => p.project_id)).toEqual([
      'p-calls',
      'p-qa-new',
      'p-review',
    ]);
  });

  it('preselects the project asked for, else the first', () => {
    const calls = telecallerProjects(projects);
    expect(defaultCallProject(calls, 'p-qa-new')).toBe('p-qa-new');
    // Not a Telecaller QA project (or unknown): the default.
    expect(defaultCallProject(calls, 'p-sneha')).toBe('p-calls');
    expect(defaultCallProject(calls)).toBe('p-calls');
    expect(defaultCallProject([])).toBe('');
  });
});

describe('uploading a recording', () => {
  it('asks for Transcribe without OCR or BDA, in the declared type', () => {
    const file = new File([new Uint8Array(10)], 'call.amr', {
      type: 'audio/amr',
    });
    expect(recordingUploadRequest(file)).toEqual({
      file_name: 'call.amr',
      content_type: 'audio/amr',
      file_size: 10,
      use_bda: false,
      use_ocr: false,
      use_transcribe: true,
    });
  });

  it('creates the document, PUTs the file, then marks it uploaded', async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const fetchApi = (async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return calls.length === 1
        ? { document_id: 'doc-1', upload_url: 'https://s3.example/put' }
        : undefined;
    }) as FetchApi;
    const puts: string[] = [];
    const file = new File([new Uint8Array(10)], 'call.ogg', {
      type: 'audio/ogg',
    });

    const id = await uploadRecording(
      fetchApi,
      'proj-calls',
      file,
      () => undefined,
      async (url, f) => {
        puts.push(`${url} ${f.name}`);
      },
    );

    expect(id).toBe('doc-1');
    expect(calls.map((c) => [c.path, c.init?.method])).toEqual([
      ['projects/proj-calls/documents', 'POST'],
      ['projects/proj-calls/documents/doc-1/status', 'PUT'],
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      file_name: 'call.ogg',
      content_type: 'audio/ogg',
      use_transcribe: true,
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      status: 'uploaded',
    });
    expect(puts).toEqual(['https://s3.example/put call.ogg']);
  });

  it('deletes the record instead of marking it uploaded when the PUT fails', async () => {
    const paths: string[] = [];
    const fetchApi = (async (path: string, init?: RequestInit) => {
      paths.push(`${init?.method} ${path}`);
      if (init?.method === 'DELETE') throw new Error('offline');
      return { document_id: 'doc-1', upload_url: 'https://s3.example/put' };
    }) as FetchApi;
    const file = new File([new Uint8Array(1)], 'call.mp3', {
      type: 'audio/mpeg',
    });

    await expect(
      uploadRecording(
        fetchApi,
        'proj-calls',
        file,
        () => undefined,
        () => Promise.reject(new Error('Failed to upload call.mp3 (403)')),
      ),
    ).rejects.toThrow('(403)');
    // The delete is best effort: its own failure does not hide the PUT's.
    expect(paths).toEqual([
      'POST projects/proj-calls/documents',
      'DELETE projects/proj-calls/documents/doc-1',
    ]);
  });
});

/** A fake XMLHttpRequest: records the request; the test drives its events. */
class FakeXhr {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
}

describe('putWithProgress', () => {
  const file = new File([new Uint8Array(100)], 'call.wav', {
    type: 'audio/wav',
  });

  function start() {
    const xhr = new FakeXhr();
    const progress: number[] = [];
    const done = putWithProgress(
      'https://s3.example/put',
      file,
      (p) => progress.push(p),
      () => xhr as unknown as XMLHttpRequest,
    );
    return { xhr, progress, done };
  }

  it('PUTs the file with its signed type and reports progress', async () => {
    const { xhr, progress, done } = start();
    expect([xhr.method, xhr.url, xhr.body]).toEqual([
      'PUT',
      'https://s3.example/put',
      file,
    ]);
    expect(xhr.headers).toEqual({ 'Content-Type': 'audio/wav' });

    xhr.upload.onprogress?.({
      lengthComputable: true,
      loaded: 25,
      total: 100,
    } as ProgressEvent);
    xhr.upload.onprogress?.({
      lengthComputable: false,
      loaded: 50,
      total: 0,
    } as ProgressEvent);
    xhr.status = 200;
    xhr.onload?.();

    await expect(done).resolves.toBeUndefined();
    expect(progress).toEqual([0.25, 1]);
  });

  it('fails on an S3 error status, a network error or an abort', async () => {
    const refused = start();
    refused.xhr.status = 403;
    refused.xhr.onload?.();
    await expect(refused.done).rejects.toThrow(
      'Failed to upload call.wav (403)',
    );

    const offline = start();
    offline.xhr.onerror?.();
    await expect(offline.done).rejects.toThrow('Failed to upload call.wav');

    const stopped = start();
    stopped.xhr.onabort?.();
    await expect(stopped.done).rejects.toThrow('stopped');
  });
});
