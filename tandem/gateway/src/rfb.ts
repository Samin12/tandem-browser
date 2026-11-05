const PARTIAL_LIMIT = 1024 * 1024;
export const CUT_TEXT_LIMIT = 10 * 1024 * 1024;
const INPUT = new Set([4, 5, 6, 255]);

export class RfbFilter {
  private phase = 0;
  private buffer = Buffer.alloc(20);
  private used = 0;
  private expected = 12;
  private failed = false;
  constructor(private holds: () => boolean, private forward: (message: Buffer) => void, private reject: (reason: string, type?: number) => void) {}
  private size() {
    const b = this.buffer;
    switch (b[0]) {
      case 0: return 20;
      case 2: return this.used < 4 ? 4 : 4 + 4 * b.readUInt16BE(2);
      case 3: case 150: return 10;
      case 4: return 8;
      case 5: return 6;
      case 6: return this.used < 8 ? 8 : 8 + Math.abs(b.readInt32BE(4));
      case 248: return this.used < 9 ? 9 : 9 + b[8]!;
      case 251: return this.used < 8 ? 8 : 8 + 16 * b[6]!;
      case 255: return 12;
      default: return 0;
    }
  }
  push(data: Uint8Array) {
    if (this.failed) return;
    let offset = 0;
    while (offset < data.length) {
      const n = Math.min(this.expected - this.used, data.length - offset);
      this.buffer.set(data.subarray(offset, offset + n), this.used); this.used += n; offset += n;
      if (this.used < this.expected) continue;
      const size = this.phase < 3 ? this.expected : this.size();
      if (!size || size > (this.buffer[0] === 6 ? CUT_TEXT_LIMIT : PARTIAL_LIMIT)) {
        this.failed = true; this.reject(size ? 'Oversize RFB message' : 'Unknown RFB message', this.buffer[0]); this.buffer = Buffer.alloc(0); return;
      }
      if (size > this.used) {
        this.expected = size;
        if (size > this.buffer.length) { const next = Buffer.alloc(size); this.buffer.copy(next, 0, 0, this.used); this.buffer = next; }
        continue;
      }
      if (this.phase < 3 || !INPUT.has(this.buffer[0]!) || this.holds()) this.forward(Buffer.from(this.buffer.subarray(0, this.used)));
      this.used = 0;
      if (this.phase < 3) this.phase++;
      this.expected = 1;
      if (this.buffer.length > PARTIAL_LIMIT) this.buffer = Buffer.alloc(20);
    }
  }
}
