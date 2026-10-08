import { useEffect, useRef, useState } from 'react';
import type { EligibilityResult } from '../types/eligibility';

/** How long the inputs stay unchanged before the banks are checked again. */
export const PRECHECK_DELAY_MS = 1000;

interface UsePrecheckOptions {
  /** The applicant: an answer for another applicant is never shown. */
  scope: string;
  /**
   * What the answer depends on (lib/eligibility precheckKey); null: no check
   * now (inputs not loaded, a value in red, Check eligibility running...).
   * The same key is never checked twice.
   */
  requestKey: string | null;
  /**
   * Sends the check with the inputs on screen; read when the check starts, so
   * it may change on every edit (it is not a dependency of the check).
   */
  run: (signal: AbortSignal) => Promise<EligibilityResult>;
  delayMs?: number;
}

export interface Precheck {
  /** The latest answer for this applicant (kept while the next one runs). */
  result: EligibilityResult | null;
  /** The requestKey that answer is for. */
  key: string | null;
  /** When that answer came (ms since the epoch). */
  at: number | null;
  /** A check of requestKey is due or on its way. */
  checking: boolean;
}

interface Answer {
  scope: string;
  key: string;
  result: EligibilityResult;
  at: number;
}

/**
 * The eligibility panel's background check of the inputs on screen: once
 * requestKey has stayed the same for `delayMs` (at once for an applicant's
 * first check, e.g. when the panel opens with saved or pre-filled inputs) it
 * runs `run` and keeps the answer. A newer key aborts the request on its way
 * and its answer is ignored; a failed check is not shown (and not retried
 * until the key changes). The effect depends on strings and booleans only and
 * an answer changes none of them but `fresh`, so the page settles.
 */
export function usePrecheck({
  scope,
  requestKey,
  run,
  delayMs = PRECHECK_DELAY_MS,
}: UsePrecheckOptions): Precheck {
  const [answer, setAnswer] = useState<Answer | null>(null);
  // The key whose check failed: not tried again until the key changes.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const runRef = useRef(run);
  // The applicant whose first check started (later ones wait for `delayMs`).
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const own = answer !== null && answer.scope === scope ? answer : null;
  const fresh = requestKey !== null && own?.key === requestKey;
  const failed = requestKey !== null && failedKey === requestKey;

  useEffect(() => {
    if (requestKey === null || fresh || failed) return;
    const controller = new AbortController();
    let live = true;
    const timer = setTimeout(
      () => {
        startedFor.current = scope;
        runRef.current(controller.signal).then(
          (result) => {
            if (!live) return;
            setAnswer({ scope, key: requestKey, result, at: Date.now() });
            setFailedKey(null);
          },
          (err: unknown) => {
            if (!live) return;
            // Never an error box: the box keeps its last answer. No message
            // logged (a 422 may quote a value typed).
            const status = (err as { status?: unknown } | null)?.status;
            console.warn(
              'Background eligibility check skipped',
              typeof status === 'number' ? status : '',
            );
            setFailedKey(requestKey);
          },
        );
      },
      startedFor.current === scope ? delayMs : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [requestKey, fresh, failed, scope, delayMs]);

  return {
    result: own?.result ?? null,
    key: own?.key ?? null,
    at: own?.at ?? null,
    checking: requestKey !== null && !fresh && !failed,
  };
}
