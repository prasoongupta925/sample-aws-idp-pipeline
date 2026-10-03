// "Upload call recordings": a telecaller's phone recordings go to a Telecaller
// QA project, where Amazon Transcribe writes the transcript and the Call QA
// Reviewer scores the call. Pure helpers and the upload itself; the page is
// ../components/CallRecordings.
import type { Project } from '../components/ProjectSettingsModal';
import type { FetchApi } from './presignedUrls';
import { detectProduct } from './projectTree';

/**
 * Formats of phone call recorders, by extension, with the type the page
 * declares for each. Amazon Transcribe reads all of them as they are; the
 * backend stores an audio/webm upload as .weba so the pipeline treats it as
 * audio, not video.
 */
export const CALL_RECORDING_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
};

/**
 * `<input accept>`: the extensions, plus audio/* so a phone's picker also
 * lists recordings it knows by type only.
 */
export const CALL_RECORDING_ACCEPT = [
  ...Object.keys(CALL_RECORDING_TYPES).map((ext) => `.${ext}`),
  'audio/*',
].join(',');

/** The backend's upload limit (app/presigned.py MAX_UPLOAD_BYTES). */
export const MAX_RECORDING_BYTES = 500 * 1024 * 1024;

export type RecordingProblem = 'format' | 'empty' | 'tooLarge';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * The file as a call recording: the same bytes with the audio type of its
 * extension (phone pickers report AMR or WebM recordings as octet-stream or
 * video, and the upload URL is signed for the declared type), or the reason
 * it cannot be uploaded.
 */
export function asCallRecording(
  file: File,
): { file: File } | { problem: RecordingProblem } {
  const type = CALL_RECORDING_TYPES[extensionOf(file.name)];
  if (!type) return { problem: 'format' };
  if (file.size < 1) return { problem: 'empty' };
  if (file.size > MAX_RECORDING_BYTES) return { problem: 'tooLarge' };
  if (file.type === type) return { file };
  return {
    file: new File([file], file.name, {
      type,
      lastModified: file.lastModified,
    }),
  };
}

const isSampleCalls = (project: Pick<Project, 'name'>) =>
  /\bsample\s+calls?\b/i.test(project.name);

const updated = (project: Project) =>
  Date.parse(project.updated_at || project.created_at || '') || 0;

/**
 * The Telecaller QA projects (named or described as such): "Sample calls"
 * first, then the most recently updated.
 */
export function telecallerProjects(projects: Project[]): Project[] {
  return projects
    .filter((project) => detectProduct(project) === 'telecallerQa')
    .sort(
      (a, b) =>
        Number(isSampleCalls(b)) - Number(isSampleCalls(a)) ||
        updated(b) - updated(a),
    );
}

/** The project to preselect: the one asked for if it is a Telecaller QA project, else the first. */
export function defaultCallProject(
  projects: Project[],
  wanted?: string,
): string {
  if (wanted && projects.some((p) => p.project_id === wanted)) return wanted;
  return projects[0]?.project_id ?? '';
}

/**
 * Upload request of a recording: Transcribe on, no OCR or BDA. No
 * transcribe_options, so Transcribe identifies the language (Indian English,
 * Hindi, Marathi or US English); the project gives the analysis language and
 * prompt.
 */
export function recordingUploadRequest(file: File) {
  return {
    file_name: file.name,
    content_type: file.type,
    file_size: file.size,
    use_bda: false,
    use_ocr: false,
    use_transcribe: true,
  };
}

/**
 * PUT a recording to its presigned URL with progress (0 to 1). The
 * Content-Type is the type the URL was signed for (the file's own type).
 */
export function putWithProgress(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
  createXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new Error(`Failed to upload ${file.name} (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error(`Failed to upload ${file.name}`));
    xhr.onabort = () => reject(new Error(`Upload of ${file.name} stopped`));
    xhr.send(file);
  });
}

/**
 * Uploads one recording to a project the way the upload modal does: the
 * document record and its presigned URL, the PUT, then status "uploaded". The
 * S3 upload starts the pipeline (Transcribe, then the analysis). When the PUT
 * fails (a phone losing its network), the record it would have filled is
 * deleted, so the project keeps no document stuck at "uploading". Returns the
 * document id.
 */
export async function uploadRecording(
  fetchApi: FetchApi,
  projectId: string,
  file: File,
  onProgress: (fraction: number) => void,
  put: typeof putWithProgress = putWithProgress,
): Promise<string> {
  const documents = `projects/${encodeURIComponent(projectId)}/documents`;
  const info = await fetchApi<{ document_id: string; upload_url: string }>(
    documents,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recordingUploadRequest(file)),
    },
  );
  const documentPath = `${documents}/${encodeURIComponent(info.document_id)}`;
  try {
    await put(info.upload_url, file, onProgress);
  } catch (error) {
    await fetchApi(documentPath, { method: 'DELETE' }).catch(() => undefined);
    throw error;
  }
  await fetchApi(`${documentPath}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'uploaded' }),
  });
  return info.document_id;
}
