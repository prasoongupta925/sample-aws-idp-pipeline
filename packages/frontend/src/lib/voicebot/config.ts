// Where the voice panel connects. The URL comes from the runtime config (`voiceBotUrl`), which
// deploy/lean/update-frontend.sh fills from the SSM parameter /idp-v2/voicebot/url through a
// small static voicebot-config.json. No URL -> no voice panel and no Voice Chat entry.

/** The voice server's WebSocket URL, or '' when it is absent or not a safe address. */
export function voiceBotUrlFrom(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  // wss only (the page is https); plain ws only for a voice server on this machine.
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local)) return '';
  if (url.username || url.password || url.search || url.hash) return '';
  // Pinned to the voice CloudFront distribution (or a local dev server).
  if (!local && !/^[a-z0-9-]+\.cloudfront\.net$/.test(url.hostname)) return '';
  return url.toString();
}

/**
 * Reads voicebot-config.json next to the app ({"voiceBotUrl": "wss://…/ws"}). A missing or broken
 * file means no voice panel; it never stops the app from loading.
 */
export async function loadVoiceBotUrl(
  fetcher: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetcher('/voicebot-config.json', { cache: 'no-store' });
    if (!res.ok) return '';
    const body: unknown = await res.json();
    return body && typeof body === 'object'
      ? voiceBotUrlFrom((body as { voiceBotUrl?: unknown }).voiceBotUrl)
      : '';
  } catch {
    return '';
  }
}
