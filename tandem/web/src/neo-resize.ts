// noVNC 1.3 guards desktop resizing with its input-only flag. Tandem permits
// SetDesktopSize for every viewer. Give only that method a sizing receiver;
// the real RFB instance and every input handler retain their viewOnly state.
//
// The engine renders at displayScale device pixels per CSS pixel, so the screen
// it needs is the viewer's CSS size times that scale: one remote pixel per
// Retina pixel, and the same page layout an agent sees. Capped to keep the
// engine's software rendering and encoding affordable.
export const MAX_REMOTE_PIXELS = 3840 * 2400;

export function remoteSize(css: { w: number; h: number }, scale: number) {
  let w = css.w * scale, h = css.h * scale;
  const over = Math.max(w / 3840, h / 2400, Math.sqrt((w * h) / MAX_REMOTE_PIXELS));
  if (over > 1) { w /= over; h /= over; }
  // Even sizes keep the encoder and the CSS layout (size / scale) whole.
  return { w: Math.max(2, Math.floor(w / 2) * 2), h: Math.max(2, Math.floor(h / 2) * 2) };
}

export function enableViewerResize<T extends { _viewOnly: boolean; _requestRemoteResize(): void; _screenSize(): { w: number; h: number } }>(rfb: T, scale = 1) {
  const resize = rfb._requestRemoteResize;
  const screenSize = rfb._screenSize.bind(rfb);
  const sizing = new Proxy(rfb, {
    get(target, key, receiver) {
      if (key === '_viewOnly') return false;
      if (key === '_screenSize') return () => remoteSize(screenSize(), scale);
      return Reflect.get(target, key, receiver);
    },
  });
  rfb._requestRemoteResize = () => resize.call(sizing);
}
