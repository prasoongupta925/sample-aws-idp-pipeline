import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  ApplicantEraseRequest,
  ApplicantEraseResponse,
  FileCheckChecklistSummary,
  FileCheckRequest,
  FileCheckResult,
} from '../types/fileCheck';
import {
  normalizeChecklists,
  parseEraseResponse,
  pickDefaultChecklistId,
} from '../lib/fileCheck';

interface UseFileCheckOptions {
  fetchApi: <T>(url: string, init?: RequestInit) => Promise<T>;
  projectId: string;
  /** After an applicant's data was erased (e.g. reload the documents list). */
  onApplicantErased?: (response: ApplicantEraseResponse) => void;
}

/**
 * State for the File Check panel. The verdict is whatever
 * POST /projects/{id}/file-check returns; nothing is computed here.
 */
export function useFileCheck({
  fetchApi,
  projectId,
  onApplicantErased,
}: UseFileCheckOptions) {
  const [checklists, setChecklists] = useState<FileCheckChecklistSummary[]>([]);
  const [checklistsLoaded, setChecklistsLoaded] = useState(false);
  const [checklistsLoading, setChecklistsLoading] = useState(false);
  const [checklistsError, setChecklistsError] = useState<unknown>(null);
  const [checklistId, setChecklistId] = useState('');
  const [applicant, setApplicant] = useState('');
  // Applicant names seen in the last run without an applicant filter; they
  // feed the applicant dropdown.
  const [knownApplicants, setKnownApplicants] = useState<string[]>([]);
  const [result, setResult] = useState<FileCheckResult | null>(null);
  const [resultApplicant, setResultApplicant] = useState('');
  const [lastRunAt, setLastRunAt] = useState<Date | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Erase applicant (POST .../applicants/erase)
  const [erasing, setErasing] = useState(false);
  const [eraseError, setEraseError] = useState<unknown>(null);
  const [eraseResult, setEraseResult] = useState<ApplicantEraseResponse | null>(
    null,
  );

  // Ignore responses that arrive after a newer request or a project switch.
  const checklistsSeq = useRef(0);
  const runSeq = useRef(0);
  const eraseSeq = useRef(0);
  const projectRef = useRef(projectId);
  const onErasedRef = useRef(onApplicantErased);
  onErasedRef.current = onApplicantErased;

  // The project page is reused across projects: start clean on a switch.
  useEffect(() => {
    if (projectRef.current === projectId) return;
    projectRef.current = projectId;
    checklistsSeq.current += 1;
    runSeq.current += 1;
    eraseSeq.current += 1;
    setErasing(false);
    setEraseError(null);
    setEraseResult(null);
    setChecklists([]);
    setChecklistsLoaded(false);
    setChecklistsLoading(false);
    setChecklistsError(null);
    setChecklistId('');
    setApplicant('');
    setKnownApplicants([]);
    setResult(null);
    setResultApplicant('');
    setLastRunAt(null);
    setRunning(false);
    setError(null);
  }, [projectId]);

  const loadChecklists = useCallback(async () => {
    const seq = ++checklistsSeq.current;
    setChecklistsLoading(true);
    setChecklistsError(null);
    try {
      const raw = await fetchApi<unknown>(`projects/${projectId}/checklists`);
      if (seq !== checklistsSeq.current) return;
      const { checklists: list, defaultId } = normalizeChecklists(raw);
      setChecklists(list);
      setChecklistId((current) =>
        current && list.some((c) => c.id === current)
          ? current
          : pickDefaultChecklistId(list, defaultId),
      );
      setChecklistsLoaded(true);
    } catch (err) {
      if (seq !== checklistsSeq.current) return;
      console.error('Failed to load file-check checklists:', err);
      setChecklistsError(err);
    } finally {
      if (seq === checklistsSeq.current) setChecklistsLoading(false);
    }
  }, [fetchApi, projectId]);

  const runCheck = useCallback(async () => {
    const seq = ++runSeq.current;
    const wantedApplicant = applicant.trim();
    const body: FileCheckRequest = {};
    if (checklistId) body.checklist_id = checklistId;
    if (wantedApplicant) body.applicant = wantedApplicant;
    setRunning(true);
    setError(null);
    // A new verdict replaces the "data was erased" note.
    setEraseResult(null);
    try {
      const raw = await fetchApi<unknown>(`projects/${projectId}/file-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (seq !== runSeq.current) return;
      const obj =
        raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      if (typeof obj.overall_verdict !== 'string') {
        throw new Error(
          typeof obj.error === 'string'
            ? obj.error
            : 'unexpected response from the file-check service',
        );
      }
      const data = obj as unknown as FileCheckResult;
      setResult(data);
      setResultApplicant(wantedApplicant);
      setLastRunAt(new Date());
      if (!wantedApplicant) {
        setKnownApplicants(
          Array.from(
            new Set(
              (data.applicants ?? [])
                .map((a) => a.applicant)
                .filter((name): name is string => !!name),
            ),
          ),
        );
      }
    } catch (err) {
      if (seq !== runSeq.current) return;
      console.error('File check failed:', err);
      setError(err);
    } finally {
      if (seq === runSeq.current) setRunning(false);
    }
  }, [fetchApi, projectId, checklistId, applicant]);

  /**
   * Permanently erases one applicant's documents and derived data. The
   * applicant is sent by PAN when the verdict has one (a name can match two
   * applicants: 409); `confirm` repeats the name (the API answers 400
   * otherwise). On success the verdict is cleared: it lists erased data.
   */
  const eraseApplicant = useCallback(
    async (
      target: { applicant: string; pan?: string | null },
      confirm: string,
    ): Promise<ApplicantEraseResponse | null> => {
      const seq = ++eraseSeq.current;
      const name = target.applicant;
      const pan = target.pan?.trim();
      const body: ApplicantEraseRequest = { applicant: pan || name, confirm };
      setErasing(true);
      setEraseError(null);
      try {
        const raw = await fetchApi<unknown>(
          `projects/${projectId}/applicants/erase`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (seq !== eraseSeq.current) return null;
        const response = parseEraseResponse(raw, name);
        // The verdict (and any check still running) describes erased data.
        runSeq.current += 1;
        setRunning(false);
        setResult(null);
        setResultApplicant('');
        setLastRunAt(null);
        setError(null);
        setKnownApplicants((prev) => prev.filter((a) => a !== name));
        setApplicant((current) =>
          current.trim() === name || (!!pan && current.trim() === pan)
            ? ''
            : current,
        );
        setEraseResult(response);
        onErasedRef.current?.(response);
        return response;
      } catch (err) {
        if (seq !== eraseSeq.current) return null;
        console.error('Erase applicant failed:', err);
        setEraseError(err);
        return null;
      } finally {
        if (seq === eraseSeq.current) setErasing(false);
      }
    },
    [fetchApi, projectId],
  );

  const clearEraseError = useCallback(() => setEraseError(null), []);
  const dismissEraseResult = useCallback(() => setEraseResult(null), []);

  return {
    checklists,
    checklistsLoaded,
    checklistsLoading,
    checklistsError,
    loadChecklists,
    checklistId,
    setChecklistId,
    applicant,
    setApplicant,
    knownApplicants,
    result,
    resultApplicant,
    lastRunAt,
    running,
    error,
    runCheck,
    erasing,
    eraseError,
    eraseResult,
    eraseApplicant,
    clearEraseError,
    dismissEraseResult,
  };
}

export type FileCheckState = ReturnType<typeof useFileCheck>;
