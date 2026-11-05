import { expect, test } from 'bun:test';
import { enableViewerResize, MAX_REMOTE_PIXELS, remoteSize } from '../src/neo-resize';
function fakeRfb() {
  return { _viewOnly: true, sizes: [] as { w: number; h: number }[],
    get viewOnly() { return this._viewOnly; },
    _screenSize() { return { w: 1468.5, h: 891 }; },
    _requestRemoteResize() { if (!this._viewOnly) this.sizes.push(this._screenSize()); },
    sendKey() { return !this._viewOnly; },
  };
}
test('noVNC 1.3 can resize a watched window without enabling input on the RFB instance', () => {
  const rfb = fakeRfb();
  enableViewerResize(rfb);
  rfb._requestRemoteResize();
  expect(rfb.sizes.length).toBe(1); expect(rfb.viewOnly).toBe(true); expect(rfb.sendKey()).toBe(false);
  rfb._viewOnly = false; rfb._requestRemoteResize(); expect(rfb.sizes.length).toBe(2); expect(rfb.sendKey()).toBe(true);
  rfb._viewOnly = true; rfb._requestRemoteResize(); expect(rfb.sizes.length).toBe(3); expect(rfb.viewOnly).toBe(true);
});
test('the remote screen is the viewer size times the engine scale, in even pixels', () => {
  const rfb = fakeRfb();
  enableViewerResize(rfb, 2);
  rfb._requestRemoteResize();
  expect(rfb.sizes[0]).toEqual({ w: 2936, h: 1782 });
  expect(remoteSize({ w: 1468.5, h: 891 }, 1)).toEqual({ w: 1468, h: 890 });
});
test('very large windows are capped without changing their shape', () => {
  const size = remoteSize({ w: 2560, h: 1440 }, 2);
  expect(size.w * size.h).toBeLessThanOrEqual(MAX_REMOTE_PIXELS);
  expect(Math.abs(size.w / size.h - 2560 / 1440)).toBeLessThan(0.01);
});
