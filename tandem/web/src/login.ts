import { loadBrand } from './brand';
const form = document.querySelector<HTMLFormElement>('#login-form')!;
const button = document.querySelector<HTMLButtonElement>('#login-submit')!;
const error = document.querySelector<HTMLElement>('#login-error')!;
const password = document.querySelector<HTMLInputElement>('#password')!;
const totp = document.querySelector<HTMLInputElement>('#totp')!;
let needsTotp = false;
let retryTimer: ReturnType<typeof setInterval> | undefined;
async function setup() {
  try {
    const [brand, response] = await Promise.all([loadBrand(), fetch('/api/auth-config')]);
    if (!response.ok) throw new Error('Unable to load sign-in settings. Reload to try again.');
    const config = await response.json();
    needsTotp = config.totp === true;
    document.querySelector<HTMLElement>('#totp-field')!.hidden = !needsTotp;
    totp.required = needsTotp;
    document.title = `Sign in — ${brand.productName}`;
    document.querySelector<HTMLElement>('#tagline')!.textContent = brand.tagline;
    button.disabled = false;
  } catch (cause) { error.textContent = cause instanceof Error ? cause.message : 'Unable to connect.'; }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  error.textContent = '';
  button.disabled = true;
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tandem': '1' }, body: JSON.stringify({ password: password.value, ...(needsTotp ? { totp: totp.value } : {}) }) });
    const data = await response.json();
    if (response.ok) { password.value = ''; totp.value = ''; location.assign('/'); return; }
    if (response.status === 429) {
      const seconds = Math.max(1, Number(data.retryAfter ?? response.headers.get('Retry-After')) || 900);
      const until = Date.now() + seconds * 1000;
      const update = () => {
        const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        error.textContent = remaining ? `Too many attempts. Try again in ${remaining} seconds (${new Date(until).toLocaleTimeString()}).` : 'You can try signing in again.';
        if (!remaining) { clearInterval(retryTimer); retryTimer = undefined; button.disabled = false; }
      };
      update(); retryTimer = setInterval(update, 1000); return;
    }
    error.textContent = data.error === 'invalid_credentials' ? 'Incorrect password or authentication code.' : 'Unable to sign in. Please try again.';
    password.select();
  } catch { error.textContent = 'Unable to connect. Check your connection and try again.'; }
  button.disabled = false;
});
void setup();
