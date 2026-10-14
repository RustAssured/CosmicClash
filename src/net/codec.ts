/**
 * The binary input lane (docs/netplay/STEP1.md §2). Little-endian, DataView-encoded.
 *
 *   INPUT  u8 1 | u8 epoch | u32 ack | u32 first | u8 count | count × (i8 x, i8 y, u16 held) | u32 ckTick | u32 ck
 *          | u32 hashTick | u32 hash
 *   PING   u8 2 | u32 id | f64 sentMs
 *   PONG   u8 3 | u32 id | f64 sentMs      (the ping echoed back unchanged)
 *
 * An INPUT packet carries every local input the peer has not acknowledged yet (redundancy on an unreliable lane), the
 * newest checksum this peer has computed, and the newest full state hash (every 60 ticks). `epoch` is the match number
 * within the session, so a late packet from the previous match is ignored.
 */
export const PKT_INPUT = 1;
export const PKT_PING = 2;
export const PKT_PONG = 3;

/** One tick's input on the wire: the stick quantised to int8 (−127…127) and the held-button mask. 4 bytes. */
export interface WireInput {
  x: number;
  y: number;
  held: number;
}

export interface InputPacket {
  epoch: number;
  /** The highest tick of the SENDER's view of our inputs it has received contiguously (we may drop older ones). */
  ack: number;
  /** Tick of inputs[0]. */
  first: number;
  inputs: WireInput[];
  /** The sender's newest checksum and the tick it was taken after (0 = none yet). */
  ckTick: number;
  ck: number;
  /** The sender's newest full hash (taken every 60 ticks) and its tick (0 = none yet). */
  hashTick: number;
  hash: number;
}

/** At most this many inputs ride in one packet (a peer that stopped acking for longer is far past the grace period). */
export const MAX_INPUTS_PER_PACKET = 120;
const INPUT_HEADER = 1 + 1 + 4 + 4 + 1;
const INPUT_TAIL = 16;

export function encodeInput(p: InputPacket): Uint8Array {
  const n = Math.min(MAX_INPUTS_PER_PACKET, p.inputs.length);
  const buf = new Uint8Array(INPUT_HEADER + n * 4 + INPUT_TAIL);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, PKT_INPUT);
  dv.setUint8(1, p.epoch & 0xff);
  dv.setUint32(2, p.ack >>> 0, true);
  dv.setUint32(6, p.first >>> 0, true);
  dv.setUint8(10, n);
  let o = INPUT_HEADER;
  for (let i = 0; i < n; i++) {
    const w = p.inputs[i]!;
    dv.setInt8(o, w.x);
    dv.setInt8(o + 1, w.y);
    dv.setUint16(o + 2, w.held & 0xffff, true);
    o += 4;
  }
  dv.setUint32(o, p.ckTick >>> 0, true);
  dv.setUint32(o + 4, p.ck >>> 0, true);
  dv.setUint32(o + 8, p.hashTick >>> 0, true);
  dv.setUint32(o + 12, p.hash >>> 0, true);
  return buf;
}

/** Decode an INPUT packet; null if it is malformed (a truncated or foreign datagram is dropped, never trusted). */
export function decodeInput(buf: Uint8Array): InputPacket | null {
  if (buf.length < INPUT_HEADER + INPUT_TAIL || buf[0] !== PKT_INPUT) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint8(10);
  if (buf.length !== INPUT_HEADER + n * 4 + INPUT_TAIL) return null;
  const inputs: WireInput[] = [];
  let o = INPUT_HEADER;
  for (let i = 0; i < n; i++) {
    inputs.push({ x: dv.getInt8(o), y: dv.getInt8(o + 1), held: dv.getUint16(o + 2, true) });
    o += 4;
  }
  return {
    epoch: dv.getUint8(1),
    ack: dv.getUint32(2, true),
    first: dv.getUint32(6, true),
    inputs,
    ckTick: dv.getUint32(o, true),
    ck: dv.getUint32(o + 4, true),
    hashTick: dv.getUint32(o + 8, true),
    hash: dv.getUint32(o + 12, true),
  };
}

export function encodePing(type: typeof PKT_PING | typeof PKT_PONG, id: number, sentMs: number): Uint8Array {
  const buf = new Uint8Array(13);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, type);
  dv.setUint32(1, id >>> 0, true);
  dv.setFloat64(5, sentMs, true);
  return buf;
}

export function decodePing(buf: Uint8Array): { type: number; id: number; sentMs: number } | null {
  if (buf.length !== 13 || (buf[0] !== PKT_PING && buf[0] !== PKT_PONG)) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { type: buf[0]!, id: dv.getUint32(1, true), sentMs: dv.getFloat64(5, true) };
}

/** Stick axis → int8. Both peers feed the sim the QUANTISED value (the local player's own input included). */
export const quantAxis = (v: number): number => {
  const c = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return Math.round(c * 127);
};
export const axisOf = (q: number): number => q / 127;
