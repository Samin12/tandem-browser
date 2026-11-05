import { describe, expect, test } from 'bun:test';
import { displayUrl, fitFrame, mapPointer, parseFrame } from '../src/frame';
const header = { targetId:'t1',seq:2,deviceWidth:1600,deviceHeight:913,offsetTop:0,pageScaleFactor:1,scrollOffsetX:0,scrollOffsetY:0,timestamp:1,format:'jpeg' };
function binary(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); const buffer = new Uint8Array(4 + bytes.length + 3);
  new DataView(buffer.buffer).setUint32(0,bytes.length,false); buffer.set(bytes,4); buffer.set([255,216,255],4+bytes.length); return buffer.buffer;
}
describe('binary frames', () => {
  test('big endian UTF-8 header length and JPEG payload', () => {
    const result = parseFrame(binary({...header,targetId:'tab-é'})); expect(result.header.targetId).toBe('tab-é');
    expect(result.header.deviceWidth).toBe(1600); expect([...result.jpeg]).toEqual([255,216,255]);
  });
  test('rejects truncated, oversized, invalid JSON and invalid dimensions', () => {
    for (const value of [new ArrayBuffer(0),new ArrayBuffer(4),binary({...header,deviceWidth:0}),binary({...header,deviceHeight:-1}),binary({...header,format:'png'}),binary({...header,seq:null})]) expect(() => parseFrame(value)).toThrow();
    const huge = binary(header); new DataView(huge).setUint32(0,999999,false); expect(() => parseFrame(huge)).toThrow();
    const malformed = binary(header); new Uint8Array(malformed)[4]=0; expect(() => parseFrame(malformed)).toThrow();
  });
});
describe('viewport mapping', () => {
  test('vertical letterboxing and CSS coordinates independent of DPR', () => {
    const rect = {left:20,top:100,width:800,height:600}; const f = fitFrame(800,600,1600,913);
    expect(f.scale).toBe(.5); expect(f.y).toBeCloseTo(71.75);
    expect(mapPointer(420,400,rect,header)).toEqual({x:800,y:456.5});
    // CSS bounds stay the same when the canvas backing store is 1600×1200 (DPR 2).
    expect(mapPointer(420,400,rect,{...header,deviceWidth:1600,deviceHeight:913})).toEqual({x:800,y:456.5});
    expect(mapPointer(20,100,rect,header)).toBeNull(); expect(mapPointer(20,100,rect,header,true)).toEqual({x:0,y:0});
  });
  test('horizontal letterboxing; outside/up events clamp during capture', () => {
    const rect = {left:0,top:0,width:1200,height:400};
    const point = mapPointer(600,200,rect,header)!; expect(point.x).toBeCloseTo(800); expect(point.y).toBeCloseTo(456.5);
    expect(mapPointer(0,200,rect,header)).toBeNull();
    expect(mapPointer(1500,1000,rect,header,true)).toEqual({x:1599,y:912});
    expect(mapPointer(0,0,{...rect,width:0,height:0},header)).toBeNull();
  });
  test('URL display preserves schemes, paths, queries and punycode', () => {
    for (const url of ['about:blank','chrome://newtab','chrome://newtab/']) expect(displayUrl(url)).toBe('');
    for (const url of ['https://example.com/a?q=1#x','http://localhost:3000','https://xn--bcher-kva.de/','https://example.com/%20']) expect(displayUrl(url)).toBe(url);
  });
});
