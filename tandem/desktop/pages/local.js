const brand = window.brand;
for (const [key, value] of Object.entries(brand.colors)) document.documentElement.style.setProperty(`--${key}`, value);
for (const element of document.querySelectorAll('[data-product]')) element.textContent = brand.productName;
const api = window.tandemLocal;
const page = document.body.dataset.page;
if (page === 'settings') {
  document.title = `Change Server — ${brand.productName}`;
  const input = document.querySelector('#server-url');
  const status = document.querySelector('#status');
  const buttons = [...document.querySelectorAll('button')];
  api.config().then(config => { input.value = config.serverURL; }).catch(() => {});
  async function check(save) {
    buttons.forEach(button => { button.disabled = true; });
    status.dataset.error = 'false';
    status.textContent = 'Checking server…';
    try {
      const result = await api[save ? 'save' : 'health'](input.value);
      status.dataset.error = String(!result.ok);
      status.textContent = result.ok ? (save ? 'Connected. Opening your browser…' : `Server OK. Browser: ${result.cdp ? 'connected' : 'unavailable'}; agent: ${result.mcp ? 'connected' : 'unavailable'}${result.version ? ` · ${result.version}` : ''}`) : result.error;
    } catch { status.dataset.error = 'true'; status.textContent = 'Could not complete the connection check. Please try again.'; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }
  document.querySelector('#check').addEventListener('click', () => check(false));
  document.querySelector('#settings-form').addEventListener('submit', event => { event.preventDefault(); void check(true); });
}
if (page === 'error') {
  document.title = `Unable to connect — ${brand.productName}`;
  document.querySelector('#retry').addEventListener('click', () => api.retry());
  document.querySelector('#settings').addEventListener('click', () => api.settings());
}
if (page === 'about') {
  document.title = `About ${brand.productName}`;
  api.config().then(config => { document.querySelector('#version').textContent = `Version ${config.version}`; });
  document.querySelector('#tagline').textContent = brand.tagline;
  document.querySelector('#attribution').textContent = `Based on ${brand.engine.name} (${brand.engine.license})`;
  document.querySelector('#repository').textContent = brand.repository;
  const link = document.querySelector('#source');
  link.href = brand.repository;
  link.addEventListener('click', event => { event.preventDefault(); api.source(); });
}
