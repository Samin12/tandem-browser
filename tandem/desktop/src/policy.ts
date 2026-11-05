export function validateServerURL(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Enter a server URL.');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a complete URL, such as https://browser.example.com.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the server origin without credentials, a path, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Use HTTPS, or HTTP on localhost / 127.0.0.1 for local testing.');
  }
  return url.origin;
}

export function isSameOrigin(candidate: string, origin: string): boolean {
  try {
    const url = new URL(candidate);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.origin === origin;
  } catch { return false; }
}

export function isDesktopPopup(candidate: string, origin: string): boolean {
  return isSameOrigin(candidate, origin) && new URL(candidate).pathname.startsWith('/desktop/');
}

export function isExternalURL(candidate: string): boolean {
  try { return ['https:', 'http:'].includes(new URL(candidate).protocol); } catch { return false; }
}
