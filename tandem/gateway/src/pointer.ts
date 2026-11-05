import { log } from './audit';

// Xvnc draws the X pointer into the picture for every VNC client whose own last
// pointer position differs from it, and a client that never sends pointer events
// (anyone watching without control) sits at 0,0. So a pointer left anywhere else
// shows up as a second, frozen arrow for watchers. Parking it at 0,0 over a short
// RFB 3.8 session of our own (security None, loopback only) removes it.
export async function parkPointer(host = '127.0.0.1', port = 5900, timeoutMs = 5000): Promise<boolean> {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  const need = async (n: number) => {
    while (buffer.length < n) await new Promise<void>((resolve, reject) => { wake = resolve; setTimeout(() => reject(new Error('timeout')), timeoutMs); });
    const out = buffer.subarray(0, n); buffer = buffer.subarray(n); return out;
  };
  let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  try {
    socket = await Bun.connect({ hostname: host, port, socket: { data(_s, data) { buffer = Buffer.concat([buffer, data]); wake?.(); }, close() { wake?.(); } } });
    const version = (await need(12)).toString();
    if (!version.startsWith('RFB 003.')) throw new Error('not RFB');
    socket.write('RFB 003.008\n');
    const types = await need((await need(1))[0]!);
    if (!types.includes(1)) throw new Error('security None unavailable');
    socket.write(new Uint8Array([1]));
    if ((await need(4)).readUInt32BE(0) !== 0) throw new Error('security failed');
    socket.write(new Uint8Array([1]));
    const init = await need(24);
    await need(init.readUInt32BE(20));
    socket.write(new Uint8Array([5, 0, 0, 0, 0, 0]));
    await Bun.sleep(100);
    return true;
  } catch (error) {
    log('pointer.park_failed', { reason: error instanceof Error ? error.message : 'unknown' });
    return false;
  } finally { socket?.end(); }
}
