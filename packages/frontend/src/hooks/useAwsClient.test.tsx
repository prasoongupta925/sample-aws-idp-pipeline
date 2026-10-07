// @vitest-environment node
// A silent token renewal (about hourly) gives useAuth() a new user. The
// functions of useAwsClient must keep their identity through it (callers key
// effects on them), while every call uses the current id_token.
// The DOM comes from ../test/jsdom (the stock jsdom environment cannot start
// in this workspace); it must be imported before testing-library.
import '../test/jsdom';
import { renderHook } from '@testing-library/react';
import { useAwsClient } from './useAwsClient';

interface TestUser {
  id_token: string;
  profile: Record<string, string>;
}
type Logins = { logins: Record<string, string> };

const auth = vi.hoisted(() => ({ user: null as TestUser | null }));
const cognito = vi.hoisted(() => ({ fetch: vi.fn() }));
const signer = vi.hoisted(() => ({
  clients: [] as Record<string, unknown>[],
  fetch: vi.fn(),
}));

vi.mock('react-oidc-context', () => ({
  useAuth: () => ({ user: auth.user }),
}));
vi.mock('./useRuntimeConfig', () => {
  // One object for the app's lifetime, like RuntimeConfigProvider's.
  const config = {
    apis: { Backend: 'https://api.example.test/' },
    cognitoProps: {
      region: 'ap-south-1',
      identityPoolId: 'ap-south-1:test-identity-pool',
      userPoolId: 'ap-south-1_TestPool',
      userPoolWebClientId: 'test-client',
    },
    agentRuntimeArn:
      'arn:aws:bedrock-agentcore:ap-south-1:000000000000:runtime/test-agent',
  };
  return { useRuntimeConfig: () => config };
});
vi.mock('@aws-sdk/credential-provider-cognito-identity', () => ({
  fromCognitoIdentityPool: (params: Logins) => () => cognito.fetch(params),
}));
vi.mock('aws4fetch', () => ({
  AwsClient: class {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      signer.clients.push(options);
    }
    fetch(url: string, init?: RequestInit) {
      return signer.fetch(url, init);
    }
  },
}));

const LOGIN = 'cognito-idp.ap-south-1.amazonaws.com/ap-south-1_TestPool';
const HOUR = 60 * 60 * 1000;

const userWith = (idToken: string): TestUser => ({
  id_token: idToken,
  profile: { 'cognito:username': 'asha.verma' },
});

/** What the identity pool hands out for a token (fake values). */
const credentialsFor = (idToken: string, validForMs = HOUR) => ({
  accessKeyId: `ASIA-${idToken}`,
  secretAccessKey: 'test-secret',
  sessionToken: `session-${idToken}`,
  expiration: new Date(Date.now() + validForMs),
});

/** The id_token of each identity pool request, in order. */
const tokensSent = () =>
  cognito.fetch.mock.calls.map(([params]) => (params as Logins).logins[LOGIN]);

beforeEach(() => {
  auth.user = userWith('token-1');
  cognito.fetch.mockReset();
  cognito.fetch.mockImplementation(async ({ logins }: Logins) =>
    credentialsFor(logins[LOGIN]),
  );
  signer.clients.length = 0;
  signer.fetch.mockReset();
  signer.fetch.mockImplementation(
    async () => new Response(JSON.stringify({ ok: true })),
  );
});

/** The hook, and a token renewal (react-oidc-context's new user). */
function renderClient() {
  const hook = renderHook(() => useAwsClient());
  const renew = (idToken: string) => {
    auth.user = userWith(idToken);
    hook.rerender();
  };
  return { result: hook.result, renew };
}

describe('useAwsClient across a token renewal', () => {
  it('keeps every function it returns', () => {
    const { result, renew } = renderClient();
    const before = result.current;

    renew('token-2');

    const names = [
      'fetchApi',
      'fetchApiBlob',
      'invokeAgent',
      'getDocumentDownloadUrl',
      'getArtifactDownloadUrl',
      'getCredentials',
    ] as const;
    for (const name of names) {
      expect(result.current[name], name).toBe(before[name]);
    }
  });

  it('keeps credentials per id_token: a renewed token gets new ones', async () => {
    const { result, renew } = renderClient();
    const { getCredentials } = result.current;

    const first = await getCredentials();
    expect(await getCredentials()).toBe(first);
    expect(tokensSent()).toEqual(['token-1']);

    renew('token-2');
    const renewed = await getCredentials();

    expect(renewed.accessKeyId).toBe('ASIA-token-2');
    expect(tokensSent()).toEqual(['token-1', 'token-2']);
    expect(await getCredentials()).toBe(renewed);
    expect(tokensSent()).toHaveLength(2);
  });

  it('signs requests with the current token, also through a function kept from before the renewal', async () => {
    const { result, renew } = renderClient();
    const { fetchApi, invokeAgent } = result.current;

    await expect(fetchApi('projects/p-1')).resolves.toEqual({ ok: true });
    renew('token-2');
    await fetchApi('projects/p-1/documents');
    await invokeAgent([{ text: 'hello' }], 's'.repeat(33), 'p-1');

    expect(signer.clients).toMatchObject([
      { accessKeyId: 'ASIA-token-1', service: 'execute-api' },
      { accessKeyId: 'ASIA-token-2', service: 'execute-api' },
      {
        accessKeyId: 'ASIA-token-2',
        service: 'bedrock-agentcore',
        region: 'ap-south-1',
      },
    ]);
    const [first, second] = signer.fetch.mock.calls;
    expect(first[0]).toBe('https://api.example.test/projects/p-1');
    expect(second[0]).toBe('https://api.example.test/projects/p-1/documents');
    expect((second[1].headers as Headers).get('X-User-Id')).toBe('asha.verma');
  });

  it('asks again when the credentials are about to expire', async () => {
    cognito.fetch.mockImplementationOnce(async ({ logins }: Logins) =>
      credentialsFor(logins[LOGIN], 60 * 1000),
    );
    const { result } = renderClient();

    await result.current.getCredentials();
    const fresh = await result.current.getCredentials();

    expect(tokensSent()).toEqual(['token-1', 'token-1']);
    expect(fresh.expiration?.getTime()).toBeGreaterThan(Date.now() + HOUR / 2);
  });

  it('shares one request per token, and an old token answering last does not replace the new credentials', async () => {
    const answer = new Map<string, () => void>();
    cognito.fetch.mockImplementation(
      ({ logins }: Logins) =>
        new Promise((resolve) => {
          const token = logins[LOGIN];
          answer.set(token, () => resolve(credentialsFor(token)));
        }),
    );
    const { result, renew } = renderClient();
    const { getCredentials } = result.current;

    const a = getCredentials();
    const b = getCredentials();
    expect(tokensSent()).toEqual(['token-1']);

    // The renewed token does not wait for the old token's request.
    renew('token-2');
    const c = getCredentials();
    expect(tokensSent()).toEqual(['token-1', 'token-2']);

    answer.get('token-2')?.();
    const renewed = await c;
    answer.get('token-1')?.();
    expect((await a).accessKeyId).toBe('ASIA-token-1');
    expect(await b).toBe(await a);

    expect(await getCredentials()).toBe(renewed);
    expect(tokensSent()).toHaveLength(2);
  });
});
