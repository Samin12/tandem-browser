export function pageTitle(title: string): string {
  const page = title.trim();
  return !page || /^BrowserOS/i.test(page) ? 'Tandem' : `${page} — Tandem`;
}
