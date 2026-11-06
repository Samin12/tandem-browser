/** Keep engine branding out of the shell title, including older gateway titles. */
export function windowTitle(title: string): string {
  const page = title.trim().replace(/\s+—\s+Tandem(?: Browser)?$/i, '').trim();
  return !page || /^BrowserOS/i.test(page) || /^Tandem(?: Browser)?$/i.test(page) ? 'Tandem' : `${page} — Tandem`;
}
