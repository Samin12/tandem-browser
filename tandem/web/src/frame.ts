import type { FrameHeader } from './types';
export function parseFrame(buffer: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } {
  if (buffer.byteLength < 5) throw new Error('Truncated frame');
  const length = new DataView(buffer).getUint32(0, false);
  if (length > 65536 || length < 2 || length + 4 >= buffer.byteLength) throw new Error('Invalid frame header length');
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 4, length))) as FrameHeader;
  if (typeof header.targetId !== 'string' || !Number.isFinite(header.seq) ||
      !Number.isFinite(header.deviceWidth) || !Number.isFinite(header.deviceHeight) ||
      header.deviceWidth <= 0 || header.deviceHeight <= 0 || header.format !== 'jpeg') throw new Error('Invalid frame metadata');
  return { header, jpeg: new Uint8Array(buffer, 4 + length) };
}
export function fitFrame(width: number, height: number, deviceWidth: number, deviceHeight: number) {
  const scale = Math.min(width / deviceWidth, height / deviceHeight);
  return { x: (width - deviceWidth * scale) / 2, y: (height - deviceHeight * scale) / 2,
    width: deviceWidth * scale, height: deviceHeight * scale, scale };
}
export function mapPointer(clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number }, header: Pick<FrameHeader, 'deviceWidth' | 'deviceHeight'>,
  clamp = false) {
  const fit = fitFrame(rect.width, rect.height, header.deviceWidth, header.deviceHeight);
  if (!(fit.scale > 0)) return null;
  let x = (clientX - rect.left - fit.x) / fit.scale;
  let y = (clientY - rect.top - fit.y) / fit.scale;
  if (!clamp && (x < 0 || y < 0 || x >= header.deviceWidth || y >= header.deviceHeight)) return null;
  x = Math.max(0, Math.min(header.deviceWidth - 1, x));
  y = Math.max(0, Math.min(header.deviceHeight - 1, y));
  return { x, y };
}
export function displayUrl(url: string): string {
  if (url === 'about:blank' || url === 'chrome://newtab' || url === 'chrome://newtab/') return '';
  return url;
}
