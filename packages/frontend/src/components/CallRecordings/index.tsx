import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  CheckCircle2,
  FileAudio,
  Loader2,
  Mic,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { useAwsClient } from '../../hooks/useAwsClient';
import { apiErrorDetail } from '../../lib/apiError';
import {
  CALL_RECORDING_ACCEPT,
  asCallRecording,
  defaultCallProject,
  telecallerProjects,
  uploadRecording,
  type RecordingProblem,
} from '../../lib/callRecordings';
import type { Project } from '../ProjectSettingsModal';

type RowStatus = 'ready' | 'uploading' | 'done' | 'failed';

interface Row {
  key: number;
  file: File;
  status: RowStatus;
  /** 0 to 1 while uploading. */
  progress: number;
  error?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorText(error: unknown): string {
  return (
    apiErrorDetail(error) ??
    (error instanceof Error ? error.message : String(error))
  );
}

const CARD =
  'rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.04]';

interface CallRecordingsPageProps {
  /** Project to preselect (?project=), when it is a Telecaller QA project. */
  initialProjectId?: string;
}

/**
 * "Upload call recordings": a telecaller picks the phone recorder's files and
 * uploads them to a Telecaller QA project, where Transcribe and the Call QA
 * analysis run as for any other call. Phone first: one column, large targets,
 * and on a small screen the page covers the app's sidebar.
 */
export default function CallRecordingsPage({
  initialProjectId,
}: CallRecordingsPageProps) {
  const { t } = useTranslation();
  const { fetchApi } = useAwsClient();
  const selectId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const loadedRef = useRef(false);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [refused, setRefused] = useState<
    { name: string; problem: RecordingProblem }[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [uploadedTo, setUploadedTo] = useState<string | null>(null);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    fetchApi<Project[]>('projects')
      .then((all) => {
        const calls = telecallerProjects(all);
        setProjects(calls);
        setProjectId(defaultCallProject(calls, initialProjectId));
      })
      .catch((error) => {
        console.error('Failed to load projects:', error);
        setLoadFailed(true);
        setProjects([]);
      });
  }, [fetchApi, initialProjectId]);

  const update = useCallback((key: number, change: Partial<Row>) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...change } : row)),
    );
  }, []);

  const addFiles = (list: FileList | null) => {
    const added: Row[] = [];
    const problems: { name: string; problem: RecordingProblem }[] = [];
    for (const picked of Array.from(list ?? [])) {
      const result = asCallRecording(picked);
      if ('file' in result) {
        added.push({
          key: nextKey.current++,
          file: result.file,
          status: 'ready',
          progress: 0,
        });
      } else {
        problems.push({ name: picked.name, problem: result.problem });
      }
    }
    setRows((prev) => [...prev, ...added]);
    setRefused(problems);
    setUploadedTo(null);
    // After the files are copied from the live FileList: the same file can
    // be picked again.
    if (inputRef.current) inputRef.current.value = '';
  };

  const pending = rows.filter(
    (row) => row.status === 'ready' || row.status === 'failed',
  );

  const uploadAll = async () => {
    if (!projectId || uploading || pending.length === 0) return;
    setUploading(true);
    setUploadedTo(null);
    let uploaded = 0;
    for (const row of pending) {
      update(row.key, { status: 'uploading', progress: 0, error: undefined });
      try {
        await uploadRecording(fetchApi, projectId, row.file, (progress) =>
          update(row.key, { progress }),
        );
        update(row.key, { status: 'done', progress: 1 });
        uploaded += 1;
      } catch (error) {
        console.error('Failed to upload recording:', error);
        update(row.key, { status: 'failed', error: errorText(error) });
      }
    }
    setUploading(false);
    if (uploaded > 0) setUploadedTo(projectId);
  };

  const done = rows.filter((row) => row.status === 'done').length;
  const statusText = (row: Row) =>
    row.status === 'uploading'
      ? t('callRecordings.status.uploading', {
          percent: Math.round(row.progress * 100),
        })
      : row.status === 'failed'
        ? t('callRecordings.status.failed', { reason: row.error ?? '' })
        : t(`callRecordings.status.${row.status}`);

  return (
    <div
      className="bento-page max-sm:fixed max-sm:inset-0 max-sm:z-40 max-sm:bg-slate-100 max-sm:px-4 dark:max-sm:bg-slate-950"
      data-testid="call-recordings-page"
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 pb-8">
        <Link
          to="/"
          className="inline-flex w-fit items-center gap-1.5 py-2 text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('callRecordings.back')}
        </Link>

        <header className="flex items-start gap-3">
          <span className="mt-1 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-orange-500/15 text-orange-600 dark:text-orange-300">
            <Mic className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            {/* Inline size: the app's .card h1 rule (3rem) wins over classes. */}
            <h1
              className="font-semibold text-slate-900 dark:text-slate-100"
              style={{ fontSize: '1.25rem', lineHeight: 1.3, margin: 0 }}
            >
              {t('callRecordings.title')}
            </h1>
            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {t('callRecordings.intro')}
            </p>
          </div>
        </header>

        <section className={CARD}>
          <label
            htmlFor={selectId}
            className="block text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            {t('callRecordings.project')}
          </label>
          {projects === null ? (
            <div className="mt-2 flex items-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('callRecordings.loading')}
            </div>
          ) : projects.length === 0 ? (
            <div
              className="mt-2 text-sm text-amber-700 dark:text-amber-300"
              role="status"
            >
              {loadFailed
                ? t('callRecordings.loadFailed')
                : t('callRecordings.noProject')}
            </div>
          ) : (
            <select
              id={selectId}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setUploadedTo(null);
              }}
              disabled={uploading}
              className="mt-2 block min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900 dark:border-white/10 dark:bg-slate-900 dark:text-slate-100"
            >
              {projects.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.name}
                </option>
              ))}
            </select>
          )}
        </section>

        <section className={CARD}>
          <label
            className={`flex min-h-28 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-orange-300 px-4 py-6 text-center dark:border-orange-400/40 ${
              uploading
                ? 'pointer-events-none opacity-50'
                : 'cursor-pointer hover:bg-orange-50/60 dark:hover:bg-orange-400/[0.06]'
            }`}
          >
            <FileAudio
              className="h-8 w-8 text-orange-500 dark:text-orange-300"
              aria-hidden="true"
            />
            <span className="text-base font-medium text-slate-800 dark:text-slate-100">
              {rows.length > 0
                ? t('callRecordings.chooseMore')
                : t('callRecordings.choose')}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {t('callRecordings.formats')}
            </span>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={CALL_RECORDING_ACCEPT}
              className="sr-only"
              disabled={uploading}
              onChange={(e) => addFiles(e.target.files)}
              data-testid="call-recordings-input"
            />
          </label>

          {refused.length > 0 && (
            <div
              className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-400/10 dark:text-amber-200"
              role="alert"
            >
              <div className="font-medium">{t('callRecordings.refused')}</div>
              <ul className="mt-1 space-y-0.5">
                {refused.map((item, i) => (
                  <li key={`${item.name}-${i}`} className="break-all">
                    {item.name}: {t(`callRecordings.problem.${item.problem}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rows.length > 0 && (
            <ul className="mt-3 space-y-2" data-testid="call-recordings-list">
              {rows.map((row) => (
                <li
                  key={row.key}
                  className="rounded-xl border border-slate-200/80 bg-white/80 px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.03]"
                  data-status={row.status}
                >
                  <div className="flex items-center gap-2">
                    {row.status === 'done' ? (
                      <CheckCircle2
                        className="h-5 w-5 flex-shrink-0 text-emerald-500"
                        aria-hidden="true"
                      />
                    ) : row.status === 'failed' ? (
                      <XCircle
                        className="h-5 w-5 flex-shrink-0 text-red-500"
                        aria-hidden="true"
                      />
                    ) : row.status === 'uploading' ? (
                      <Loader2
                        className="h-5 w-5 flex-shrink-0 animate-spin text-orange-500"
                        aria-hidden="true"
                      />
                    ) : (
                      <FileAudio
                        className="h-5 w-5 flex-shrink-0 text-slate-400"
                        aria-hidden="true"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                        {row.file.name}
                      </p>
                      <div
                        className={`text-xs ${row.status === 'failed' ? 'text-red-600 dark:text-red-300' : 'text-slate-500 dark:text-slate-400'}`}
                      >
                        {formatSize(row.file.size)} · {statusText(row)}
                      </div>
                    </div>
                    {(row.status === 'ready' || row.status === 'failed') &&
                      !uploading && (
                        <button
                          type="button"
                          onClick={() =>
                            setRows((prev) =>
                              prev.filter((r) => r.key !== row.key),
                            )
                          }
                          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-slate-200"
                          aria-label={t('callRecordings.remove', {
                            name: row.file.name,
                          })}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                  </div>
                  {row.status === 'uploading' && (
                    <div
                      className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10"
                      role="progressbar"
                      aria-label={row.file.name}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(row.progress * 100)}
                    >
                      <div
                        className="h-full rounded-full bg-orange-500 transition-[width]"
                        style={{ width: `${Math.round(row.progress * 100)}%` }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={uploadAll}
            disabled={!projectId || uploading || pending.length === 0}
            className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-orange-600 px-4 text-base font-semibold text-white shadow-sm hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            ) : (
              <Upload className="h-5 w-5" aria-hidden="true" />
            )}
            {uploading
              ? t('callRecordings.uploading')
              : t('callRecordings.upload', {
                  count: Math.max(1, pending.length),
                })}
          </button>
        </section>

        {uploadedTo && done > 0 && (
          <section
            className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 text-sm text-emerald-900 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100"
            role="status"
            data-testid="call-recordings-done"
          >
            <div>{t('callRecordings.done', { count: done })}</div>
            <Link
              to="/projects/$projectId"
              params={{ projectId: uploadedTo }}
              className="mt-2 inline-flex min-h-10 items-center font-semibold text-emerald-800 underline underline-offset-2 dark:text-emerald-200"
            >
              {t('callRecordings.openProject')}
            </Link>
          </section>
        )}

        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {t('callRecordings.consent')} {t('callRecordings.retention')}
        </p>
      </div>
    </div>
  );
}
