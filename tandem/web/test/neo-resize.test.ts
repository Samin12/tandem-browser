import { expect, test } from 'bun:test';
import { enableViewerResize } from '../src/neo-resize';
test('noVNC 1.3 can resize a watched window without enabling input on the RFB instance', () => {
  const rfb = { _viewOnly: true, sizes: 0,
    get viewOnly() { return this._viewOnly; },
    _requestRemoteResize() { if (!this._viewOnly) this.sizes++; },
    sendKey() { return !this._viewOnly; },
  };
  enableViewerResize(rfb);
  rfb._requestRemoteResize();
  expect(rfb.sizes).toBe(1); expect(rfb.viewOnly).toBe(true); expect(rfb.sendKey()).toBe(false);
  rfb._viewOnly = false; rfb._requestRemoteResize(); expect(rfb.sizes).toBe(2); expect(rfb.sendKey()).toBe(true);
  rfb._viewOnly = true; rfb._requestRemoteResize(); expect(rfb.sizes).toBe(3); expect(rfb.viewOnly).toBe(true);
});
