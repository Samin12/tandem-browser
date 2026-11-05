import type { Brand } from './types';
export async function loadBrand(): Promise<Brand> {
  const response = await fetch('/brand.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load browser branding.');
  const brand: Brand = await response.json();
  for (const [name, value] of Object.entries(brand.colors)) {
    if (CSS.supports('color', value)) {
      document.documentElement.style.setProperty(`--${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value);
    }
  }
  for (const element of document.querySelectorAll<HTMLElement>('[data-product]')) element.textContent = brand.productName;
  for (const element of document.querySelectorAll<HTMLImageElement>('[data-logo]')) {
    // The public favicon route is the gateway's alias for the bundled brand logo.
    element.src = brand.logo === 'logo.svg' ? '/favicon.svg' : new URL(brand.logo, location.origin).href;
    element.alt = brand.productName;
  }
  return brand;
}
