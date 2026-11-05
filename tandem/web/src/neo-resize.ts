// noVNC 1.3 guards desktop resizing with its input-only flag. Tandem permits
// SetDesktopSize for every viewer. Give only that method a sizing receiver;
// the real RFB instance and every input handler retain their viewOnly state.
export function enableViewerResize<T extends { _viewOnly: boolean; _requestRemoteResize(): void }>(rfb: T) {
  const resize = rfb._requestRemoteResize;
  const sizing = new Proxy(rfb, {
    get(target, key, receiver) { return key === '_viewOnly' ? false : Reflect.get(target, key, receiver); },
  });
  rfb._requestRemoteResize = () => resize.call(sizing);
}
