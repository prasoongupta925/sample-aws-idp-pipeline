// @vitest-environment node
import { loadVoiceBotUrl, voiceBotUrlFrom } from './config';

describe('voiceBotUrlFrom', () => {
  it('keeps a wss:// URL', () => {
    expect(voiceBotUrlFrom('wss://d3aimkn7il0s92.cloudfront.net/ws')).toBe(
      'wss://d3aimkn7il0s92.cloudfront.net/ws',
    );
    expect(voiceBotUrlFrom('  wss://voice.example.in/ws  ')).toBe(
      'wss://voice.example.in/ws',
    );
  });

  it('allows plain ws:// only for a voice server on this machine', () => {
    expect(voiceBotUrlFrom('ws://localhost:8080/ws')).toBe(
      'ws://localhost:8080/ws',
    );
    expect(voiceBotUrlFrom('ws://voice.example.in/ws')).toBe('');
  });

  it('drops anything else (no panel then)', () => {
    for (const value of [
      undefined,
      null,
      '',
      '   ',
      42,
      'not a url',
      'https://voice.example.in/ws',
      'ftp://voice.example.in/ws',
      'wss://user:pw@voice.example.in/ws',
      'wss://voice.example.in/ws?token=x',
      'wss://voice.example.in/ws#x',
    ]) {
      expect(voiceBotUrlFrom(value)).toBe('');
    }
  });
});

function fakeFetch(status: number, body: unknown, json = true): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (!json) throw new SyntaxError('Unexpected token <');
        return body;
      },
    }) as Response) as unknown as typeof fetch;
}

describe('loadVoiceBotUrl', () => {
  it('reads voicebot-config.json', async () => {
    let asked = '';
    const fetcher = (async (input: RequestInfo | URL) => {
      asked = String(input);
      return {
        ok: true,
        json: async () => ({ voiceBotUrl: 'wss://v.example.in/ws' }),
      };
    }) as unknown as typeof fetch;
    expect(await loadVoiceBotUrl(fetcher)).toBe('wss://v.example.in/ws');
    expect(asked).toBe('/voicebot-config.json');
  });

  it('is empty for {} , a 404, the SPA fallback page or a network error', async () => {
    expect(await loadVoiceBotUrl(fakeFetch(200, {}))).toBe('');
    expect(await loadVoiceBotUrl(fakeFetch(404, null))).toBe('');
    expect(await loadVoiceBotUrl(fakeFetch(200, null, false))).toBe('');
    expect(
      await loadVoiceBotUrl(fakeFetch(200, { voiceBotUrl: 'http://x/ws' })),
    ).toBe('');
    const failing = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await loadVoiceBotUrl(failing)).toBe('');
  });
});
