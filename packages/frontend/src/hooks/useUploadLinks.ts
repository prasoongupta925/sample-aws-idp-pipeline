import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseCreatedUploadLink,
  parseUploadLink,
  parseUploadLinks,
  type CreatedUploadLink,
  type UploadLink,
  type UploadLinkCreate,
} from '../lib/uploadLinks';
import { ApiError } from '../lib/apiError';

interface UseUploadLinksOptions {
  fetchApi: <T>(url: string, init?: RequestInit) => Promise<T>;
  projectId: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * The project's customer upload links (prefix projects/{id}/upload-links).
 * The token of a new link is returned once by create() and kept by the
 * caller only while the dialog shows it; the list never has tokens.
 */
export function useUploadLinks({ fetchApi, projectId }: UseUploadLinksOptions) {
  const [links, setLinks] = useState<UploadLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const base = `projects/${projectId}/upload-links`;
  const loadSeq = useRef(0);

  useEffect(() => {
    loadSeq.current += 1;
    setLinks([]);
    setLoadError(null);
    setCreateError(null);
  }, [projectId]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const raw = await fetchApi<unknown>(base);
      if (seq === loadSeq.current) setLinks(parseUploadLinks(raw));
    } catch (err) {
      if (seq !== loadSeq.current) return;
      console.error('Failed to load upload links:', err);
      setLoadError(err);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [fetchApi, base]);

  /** POST; the result holds the link's only copy of its token. */
  const create = useCallback(
    async (request: UploadLinkCreate): Promise<CreatedUploadLink | null> => {
      setCreating(true);
      setCreateError(null);
      try {
        const raw = await fetchApi<unknown>(base, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(request),
        });
        const created = parseCreatedUploadLink(raw);
        // The list keeps the link without its token.
        const link = parseUploadLink(raw) as UploadLink;
        loadSeq.current += 1;
        setLoading(false);
        setLinks((prev) => [
          link,
          ...prev.filter((l) => l.link_id !== link.link_id),
        ]);
        return created;
      } catch (err) {
        console.error('Failed to create upload link:', err);
        setCreateError(err);
        return null;
      } finally {
        setCreating(false);
      }
    },
    [fetchApi, base],
  );

  const revoke = useCallback(
    async (linkId: string): Promise<boolean> => {
      setRevoking(linkId);
      try {
        const raw = await fetchApi<unknown>(
          `${base}/${encodeURIComponent(linkId)}`,
          { method: 'DELETE' },
        );
        const link = parseUploadLink(raw);
        if (link) {
          setLinks((prev) =>
            prev.map((l) => (l.link_id === link.link_id ? link : l)),
          );
        }
        return true;
      } catch (err) {
        console.error('Failed to revoke upload link:', err);
        return false;
      } finally {
        setRevoking(null);
      }
    },
    [fetchApi, base],
  );

  return {
    links,
    loading,
    loadError,
    load,
    creating,
    createError,
    create,
    revoking,
    revoke,
  };
}

export type UploadLinksState = ReturnType<typeof useUploadLinks>;

export type UnlockOutcome = 'unlocked' | 'wrong_password' | 'failed';

/**
 * Staff enter the password of a customer's protected PDF. The password is
 * sent once in the request body and not kept anywhere.
 */
export async function unlockDocument(
  fetchApi: <T>(url: string, init?: RequestInit) => Promise<T>,
  projectId: string,
  documentId: string,
  password: string,
): Promise<UnlockOutcome> {
  try {
    await fetchApi<unknown>(
      `projects/${projectId}/documents/${encodeURIComponent(documentId)}/unlock`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ password }),
      },
    );
    return 'unlocked';
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) return 'wrong_password';
    // Never log the request: it holds the password.
    console.error('Failed to unlock document:', (err as Error)?.message);
    return 'failed';
  }
}
