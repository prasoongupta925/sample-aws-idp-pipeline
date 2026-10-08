import { useCallback, useLayoutEffect, useRef } from 'react';
import { useAuth } from 'react-oidc-context';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { AwsClient } from 'aws4fetch';
import { useRuntimeConfig } from './useRuntimeConfig';
import {
  requestArtifactDownloadUrl,
  requestDocumentDownloadUrl,
} from '../lib/presignedUrls';
import { ApiError, errorDetailFromBody } from '../lib/apiError';

const CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export interface StreamEvent {
  type:
    | 'text'
    | 'tool_use'
    | 'tool_result'
    | 'complete'
    | 'stage_start'
    | 'stage_complete';
  content?: string | ToolResultContent[];
  name?: string;
  tool_use_id?: string;
  input?: string;
  stage?: string;
  result?: string;
}

export interface ToolResultContent {
  type: string;
  text?: string;
  format?: string;
  source?: string;
  s3_url?: string | null;
  image?: {
    format?: string;
    source?: { bytes?: string };
  };
}

export interface ContentSource {
  base64: string;
}

export interface ImageContent {
  format: string;
  source: ContentSource;
}

export interface DocumentContent {
  format: string;
  name: string;
  source: ContentSource;
}

export interface ContentBlock {
  image?: ImageContent;
  document?: DocumentContent;
  text?: string;
}

/** Options of one fetchApi call. */
export interface FetchApiOptions {
  /**
   * How often a 5xx or 429 answer is tried again, with backoff (aws4fetch's
   * default: 10). A background request that is simply sent again later (the
   * eligibility panel's pre-check) passes 0, so one failure is one request.
   */
  retries?: number;
}

/** Parse the stream (JSON events) */
async function parseStream(
  response: Response,
  onEvent?: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  // Cancel the reader if the caller aborts (user pressed Stop). This closes the
  // HTTP stream, which the agent runtime turns into a cancellation of the
  // in-progress agent invocation.
  const onAbort = () => {
    reader.cancel().catch(() => undefined);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse one JSON object at a time
      let startIdx = 0;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === '{') {
          let braceCount = 1;
          let j = i + 1;
          let inString = false;
          let escape = false;
          while (j < buffer.length && braceCount > 0) {
            const ch = buffer[j];
            if (escape) {
              escape = false;
            } else if (ch === '\\') {
              escape = true;
            } else if (ch === '"') {
              inString = !inString;
            } else if (!inString) {
              if (ch === '{') braceCount++;
              else if (ch === '}') braceCount--;
            }
            j++;
          }
          if (braceCount === 0) {
            const jsonStr = buffer.slice(i, j);
            try {
              const event = JSON.parse(jsonStr) as StreamEvent;
              onEvent?.(event);
              if (
                event.type === 'text' &&
                event.content &&
                typeof event.content === 'string'
              ) {
                result += event.content;
              }
            } catch {
              // Ignore JSON parse failures
            }
            startIdx = j;
            i = j - 1;
          } else {
            // Incomplete JSON: keep it buffered until the next chunk completes it
            startIdx = i;
            break;
          }
        }
      }
      buffer = buffer.slice(startIdx);
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  return result;
}

/** Extract the region from an ARN */
function extractRegionFromArn(arn: string): string {
  return arn.split(':')[3];
}

export function useAwsClient() {
  const { apis, cognitoProps, agentRuntimeArn, bidiAgentRuntimeArn } =
    useRuntimeConfig();
  const { user } = useAuth();
  // The functions below read these through a ref, so they keep their identity
  // when a silent token renewal (about hourly) brings a new `user`: callers key
  // effects on them (a new identity reloaded the whole project page). Each
  // call reads the current id_token.
  const latest = useRef({ apis, cognitoProps, agentRuntimeArn, user });
  useLayoutEffect(() => {
    latest.current = { apis, cognitoProps, agentRuntimeArn, user };
  }, [apis, cognitoProps, agentRuntimeArn, user]);
  // Credentials are kept per id_token: a renewed token gets new ones.
  const credentialsRef = useRef<{
    idToken: string;
    credentials: Credentials;
  } | null>(null);
  const pendingRef = useRef<{
    idToken: string;
    promise: Promise<Credentials>;
  } | null>(null);

  /** Get AWS credentials from the Cognito Identity Pool (current id_token) */
  const getCredentials = useCallback(async (): Promise<Credentials> => {
    const { cognitoProps, user } = latest.current;
    const idToken = user?.id_token;
    if (!cognitoProps || !idToken) {
      throw new Error('Cognito props or user token not available');
    }

    const cached = credentialsRef.current;
    const isValid =
      cached?.idToken === idToken &&
      cached.credentials.expiration &&
      cached.credentials.expiration.getTime() - Date.now() >
        CREDENTIAL_REFRESH_BUFFER_MS;

    if (isValid) return cached.credentials;

    const pending = pendingRef.current;
    if (pending?.idToken === idToken) return pending.promise;

    const promise = fromCognitoIdentityPool({
      clientConfig: { region: cognitoProps.region },
      identityPoolId: cognitoProps.identityPoolId,
      logins: {
        [`cognito-idp.${cognitoProps.region}.amazonaws.com/${cognitoProps.userPoolId}`]:
          idToken,
      },
    })()
      .then((credentials) => {
        // Not kept when a newer token's request replaced this one meanwhile.
        if (pendingRef.current?.promise === promise) {
          credentialsRef.current = { idToken, credentials };
        }
        return credentials;
      })
      .finally(() => {
        if (pendingRef.current?.promise === promise) pendingRef.current = null;
      });
    pendingRef.current = { idToken, promise };

    return promise;
  }, []);

  /** Create a SigV4-signed AWS client (`retries`: aws4fetch's default unless given) */
  const createAwsClient = useCallback(
    async (service: string, region?: string, retries?: number) => {
      const { cognitoProps } = latest.current;
      if (!cognitoProps) throw new Error('Cognito props not available');

      const credentials = await getCredentials();
      return new AwsClient({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        region: region ?? cognitoProps.region,
        service,
        ...(retries === undefined ? {} : { retries }),
      });
    },
    [getCredentials],
  );

  /** Call the backend API */
  const fetchApi = useCallback(
    async <T>(
      path: string,
      options?: RequestInit,
      { retries }: FetchApiOptions = {},
    ): Promise<T> => {
      const { apis, user } = latest.current;
      if (!apis?.Backend) throw new Error('Backend API URL not available');
      if (!user?.id_token) throw new Error('User token not available');

      const client = await createAwsClient('execute-api', undefined, retries);
      const headers = new Headers(options?.headers);
      headers.set('X-User-Id', user.profile?.['cognito:username'] as string);

      const response = await client.fetch(`${apis.Backend}${path}`, {
        ...options,
        headers,
      });

      if (!response.ok) {
        // Keep the backend's reason (FastAPI `detail`) for the caller to show.
        const body = await response.text().catch(() => '');
        throw new ApiError(response.status, errorDetailFromBody(body));
      }

      // Responses without a body (e.g. 204 DELETE, 202 reanalyze) are not parsed;
      // return undefined. Content-Length is unreliable, so read the actual body.
      const text = await response.text();
      return text ? (JSON.parse(text) as T) : (undefined as T);
    },
    [createAwsClient],
  );

  /** Call the backend API (Blob response: images and other binaries) */
  const fetchApiBlob = useCallback(
    async (path: string, options?: RequestInit): Promise<Blob> => {
      const { apis, user } = latest.current;
      if (!apis?.Backend) throw new Error('Backend API URL not available');
      if (!user?.id_token) throw new Error('User token not available');

      const client = await createAwsClient('execute-api');
      const headers = new Headers(options?.headers);
      headers.set('X-User-Id', user.profile?.['cognito:username'] as string);

      const response = await client.fetch(`${apis.Backend}${path}`, {
        ...options,
        headers,
      });

      if (!response.ok) {
        throw new ApiError(response.status);
      }

      return response.blob();
    },
    [createAwsClient],
  );

  /** Invoke the Bedrock agent (streaming) */
  const invokeAgent = useCallback(
    async (
      prompt: ContentBlock[],
      sessionId: string,
      projectId: string,
      onEvent?: (event: StreamEvent) => void,
      agentId?: string,
      runtimeArn?: string,
      signal?: AbortSignal,
      modelId?: string,
      reasoning?: string,
    ): Promise<string> => {
      const { agentRuntimeArn, user } = latest.current;
      const targetArn = runtimeArn || agentRuntimeArn;
      if (!targetArn) throw new Error('Agent runtime ARN not available');
      if (!user?.id_token) throw new Error('User token not available');

      const region = extractRegionFromArn(targetArn);
      const client = await createAwsClient('bedrock-agentcore', region);

      const response = await client.fetch(
        `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(targetArn)}/invocations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
          },
          body: JSON.stringify({
            prompt,
            session_id: sessionId,
            project_id: projectId,
            user_id: user.profile?.['cognito:username'] as string,
            agent_id: agentId,
            ...(modelId ? { model_id: modelId } : {}),
            ...(reasoning ? { reasoning } : {}),
          }),
          // Aborting closes the HTTP stream, which the agent runtime turns into
          // a cancellation of the in-progress invocation.
          signal,
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Agent error: ${response.status} - ${errorText}`);
      }

      const isStreaming = response.headers
        .get('content-type')
        ?.includes('text/event-stream');

      if (isStreaming) {
        return parseStream(response, onEvent, signal);
      }

      return JSON.stringify(await response.json());
    },
    [createAwsClient],
  );

  // S3 access: the Cognito identity has no S3 permissions. The backend checks
  // each request and issues a presigned URL valid for 5 minutes (uploads get
  // theirs from POST projects/{id}/documents, see useDocuments).

  /** Presigned GET for an object of the project in the document bucket. */
  const getDocumentDownloadUrl = useCallback(
    (projectId: string, key: string): Promise<string> =>
      requestDocumentDownloadUrl(fetchApi, projectId, key),
    [fetchApi],
  );

  /** Presigned GET for one of the caller's artifacts in the agent bucket. */
  const getArtifactDownloadUrl = useCallback(
    (key: string): Promise<string> => requestArtifactDownloadUrl(fetchApi, key),
    [fetchApi],
  );

  return {
    fetchApi,
    fetchApiBlob,
    invokeAgent,
    getDocumentDownloadUrl,
    getArtifactDownloadUrl,
    bidiAgentRuntimeArn,
    getCredentials,
    userId: user?.profile?.['cognito:username'] as string | undefined,
  };
}
