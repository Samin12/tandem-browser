import { expect, test } from 'bun:test';
import { CUT_TEXT_LIMIT, RfbFilter } from '../src/rfb';

const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
const fixed = (type: number, size: number) => { const b = Buffer.alloc(size); b[0] = type; return b; };
const encodings = fixed(2, 12); encodings.writeUInt16BE(2, 2);
const fence = fixed(248, 12); fence[8] = 3;
const screens = fixed(251, 40); screens[6] = 2;
function cut(length: number) { const b = fixed(6, 8 + Math.abs(length)); b.writeInt32BE(length, 4); return b; }
const always = [fixed(0, 20), encodings, fixed(3, 10), fixed(150, 10), fence, screens];
const input = [fixed(4, 8), fixed(5, 6), cut(5), cut(-5), fixed(255, 12)];
function setup(holding = false) {
  const forwarded: Buffer[] = [], errors: { reason: string; type?: number }[] = [], state = { holding };
  const parser = new RfbFilter(() => state.holding, b => forwarded.push(b), (reason, type) => errors.push({ reason, type }));
  return { parser, forwarded, errors, state };
}
test('RFB 3.8 handshake always passes, including byte-by-byte frames', () => {
  const { parser, forwarded, errors } = setup();
  for (const b of handshake) parser.push(Buffer.from([b]));
  expect(forwarded.map(b => b.length)).toEqual([12, 1, 1]); expect(Buffer.concat(forwarded)).toEqual(handshake); expect(errors).toEqual([]);
});
for (const message of always) test(`RFB type ${message[0]} always passes, at every split`, () => {
  for (let split = 0; split <= message.length; split++) {
    const { parser, forwarded, errors } = setup(); parser.push(handshake); forwarded.length = 0;
    parser.push(message.subarray(0, split)); parser.push(message.subarray(split));
    expect(forwarded).toEqual([message]); expect(errors).toEqual([]);
  }
});
for (const message of input) test(`RFB input ${message[0]} length ${message.length} obeys current control`, () => {
  for (let split = 1; split < message.length; split++) {
    const { parser, forwarded, errors, state } = setup(true); parser.push(handshake); forwarded.length = 0;
    parser.push(message.subarray(0, split)); state.holding = false; parser.push(message.subarray(split)); expect(forwarded).toEqual([]);
    parser.push(message.subarray(0, split)); state.holding = true; parser.push(message.subarray(split)); expect(forwarded).toEqual([message]); expect(errors).toEqual([]);
  }
});
test('RFB multiple mixed messages and handshake in one frame retain boundaries', () => {
  const { parser, forwarded, errors } = setup(); parser.push(Buffer.concat([handshake, ...always, ...input, ...always]));
  expect(Buffer.concat(forwarded)).toEqual(Buffer.concat([handshake, ...always, ...always])); expect(errors).toEqual([]);
});
test('RFB all input passes with control in a single frame', () => {
  const { parser, forwarded, errors } = setup(true); parser.push(Buffer.concat([handshake, ...input]));
  expect(Buffer.concat(forwarded)).toEqual(Buffer.concat([handshake, ...input])); expect(errors).toEqual([]);
});
test('RFB extended clipboard up to 10 MB total works across small frames', () => {
  const message = cut(-(CUT_TEXT_LIMIT - 8)), { parser, forwarded, errors } = setup(true); parser.push(handshake); forwarded.length = 0;
  for (let i = 0; i < message.length; i += 65536) parser.push(message.subarray(i, i + 65536));
  expect(forwarded).toEqual([message]); expect(errors).toEqual([]);
});
test('RFB empty variable messages keep the next message aligned', () => {
  const { parser, forwarded, errors } = setup(true), messages = [fixed(2, 4), fixed(248, 9), fixed(251, 8), cut(0), fixed(4, 8)];
  parser.push(Buffer.concat([handshake, ...messages])); expect(Buffer.concat(forwarded)).toEqual(Buffer.concat([handshake, ...messages])); expect(errors).toEqual([]);
});
test('RFB unknown type rejects once and stops parsing', () => {
  const { parser, forwarded, errors } = setup(true); parser.push(handshake); forwarded.length = 0;
  parser.push(Buffer.concat([Buffer.from([1]), fixed(4, 8)])); parser.push(fixed(5, 6));
  expect(errors).toEqual([{ reason: 'Unknown RFB message', type: 1 }]); expect(forwarded).toEqual([]);
});
for (const length of [CUT_TEXT_LIMIT - 7, -(CUT_TEXT_LIMIT - 7), -2147483648, 2147483647]) test(`RFB oversize clipboard ${length} rejects from header before buffering body`, () => {
  const { parser, errors } = setup(); parser.push(handshake); const header = fixed(6, 8); header.writeInt32BE(length, 4); parser.push(header);
  expect(errors).toEqual([{ reason: 'Oversize RFB message', type: 6 }]);
});
