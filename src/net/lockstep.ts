import { Btn, type InputFrame } from '@/contracts';
import {
  MAX_INPUTS_PER_PACKET,
  axisOf,
  decodeInput,
  encodeInput,
  quantAxis,
  type InputPacket,
} from './codec';

/**
 * Input-delay lockstep (docs/netplay/STEP0.md recommendation, docs/netplay/STEP1.md §3).
 *
 * Both peers run the same deterministic Match. Each loop tick a peer samples its own input and schedules it `delay` ticks
 * in the future; a tick is simulated only when BOTH slots' inputs for it are known. Nothing is predicted, nothing is rolled
 * back: a late input makes the sim wait (a "waiting" indicator), never speed up.
 *
 * Ticks are the Match's own (`Match.step()` increments its tick, then polls the inputs for that tick). Ticks 1…delay have
 * no input from anyone: both peers pre-fill them with empty frames, identically.
 *
 * This class is pure (no DOM, no clock): the input log, the redundant packet it sends, acks, and the desync check.
 */

export const MIN_DELAY = 2;
export const MAX_DELAY = 6;
export const DEFAULT_DELAY = 3;
/** The full state hash is exchanged every this many ticks (the checksum every tick). */
export const HASH_EVERY = 60;
const TICK_MS = 1000 / 60;

/**
 * The input delay for a measured link: D = ceil((RTT/2 + jitter + 4 ms) / 16.7 ms), clamped to 2–6 ticks (STEP0). With too
 * few samples to judge, the default of 3 ticks (50 ms).
 */
export function delayFor(rttMs: number | null, jitterMs = 0): number {
  if (rttMs === null || !Number.isFinite(rttMs)) return DEFAULT_DELAY;
  const d = Math.ceil((rttMs / 2 + Math.max(0, jitterMs) + 4) / TICK_MS);
  return Math.min(MAX_DELAY, Math.max(MIN_DELAY, d));
}

/** The buttons that never cross the wire (the app's own pause / training toggles). */
const LOCAL_ONLY = Btn.PAUSE | Btn.TRAINING;

/** A growable per-tick input log for one slot (index = tick). */
class SlotLog {
  x = new Int8Array(1024);
  y = new Int8Array(1024);
  held = new Uint16Array(1024);
  have = new Uint8Array(1024);

  ensure(t: number): void {
    if (t < this.have.length) return;
    let n = this.have.length;
    while (n <= t) n *= 2;
    const grow = <T extends Int8Array | Uint8Array | Uint16Array>(a: T, mk: (n: number) => T): T => {
      const b = mk(n);
      b.set(a);
      return b;
    };
    this.x = grow(this.x, (k) => new Int8Array(k));
    this.y = grow(this.y, (k) => new Int8Array(k));
    this.held = grow(this.held, (k) => new Uint16Array(k));
    this.have = grow(this.have, (k) => new Uint8Array(k));
  }

  set(t: number, x: number, y: number, held: number): void {
    this.ensure(t);
    this.x[t] = x;
    this.y[t] = y;
    this.held[t] = held;
    this.have[t] = 1;
  }

  has(t: number): boolean {
    return t < this.have.length && this.have[t] === 1;
  }
}

export interface DesyncInfo {
  /** The first tick found to differ. */
  tick: number;
  kind: 'checksum' | 'hash';
  local: number;
  remote: number;
}

/** What a desync dump holds (also the input log a replay tool can play back: tools/netplay/desync-replay.ts). */
export interface InputDump {
  v: 1;
  localSlot: 0 | 1;
  delay: number;
  ticks: number;
  /** Per slot, per tick from 1: moveX, moveY, held (the quantised values the sim was fed). */
  inputs: [number[], number[]];
  /** This peer's checksum after every tick (index 0 = tick 1). */
  checksums: number[];
  hashes: [number, number][];
}

export class Lockstep {
  /** Next local tick to produce an input for. */
  localNext: number;
  /** Highest tick such that every remote input up to it is known. */
  remoteContig: number;
  /** Highest local tick the peer has acknowledged (we resend everything after it). */
  peerAck: number;
  /** Last tick simulated. */
  simTick = 0;
  /** Set once a checksum or hash mismatch is seen; the session stops the match. */
  desync: DesyncInfo | null = null;
  /** After the match ends nothing more is compared (the results screens may drift apart harmlessly). */
  done = false;

  private readonly logs: [SlotLog, SlotLog] = [new SlotLog(), new SlotLog()];
  private ck = new Uint32Array(1024);
  private readonly hashes = new Map<number, number>();
  private readonly pendingCk = new Map<number, number>();
  private readonly pendingHash = new Map<number, number>();
  private lastCkTick = 0;
  private lastCk = 0;
  private lastHashTick = 0;
  private lastHash = 0;
  /** Remote input packets accepted / malformed or stale (diagnostics). */
  packetsIn = 0;
  packetsBad = 0;

  constructor(
    readonly local: 0 | 1,
    readonly delay: number,
    readonly epoch = 0,
  ) {
    for (const log of this.logs) for (let t = 1; t <= delay; t++) log.set(t, 0, 0, 0);
    this.localNext = delay + 1;
    this.remoteContig = delay;
    this.peerAck = delay;
  }

  get remote(): 0 | 1 {
    return this.local === 0 ? 1 : 0;
  }

  /** True when the input for the tick about to be simulated + delay still has to be sampled. */
  needLocal(): boolean {
    return this.localNext <= this.simTick + 1 + this.delay;
  }

  /** Record this peer's input for tick `localNext` (quantised; PAUSE / TRAINING stripped). */
  pushLocal(f: Readonly<InputFrame>): void {
    this.logs[this.local].set(
      this.localNext,
      quantAxis(f.moveX),
      quantAxis(f.moveY),
      f.held & ~LOCAL_ONLY & 0xffff,
    );
    this.localNext++;
  }

  /** Both slots' inputs for the next tick are known. */
  ready(): boolean {
    const t = this.simTick + 1;
    return this.logs[this.local].has(t) && this.remoteContig >= t;
  }

  /** How many ticks of remote input we are waiting for (0 = none). */
  get waitingFor(): number {
    return Math.max(0, this.simTick + 1 - this.remoteContig);
  }

  /** Fill the sim's frame for `slot` at `tick` (edges derived from the held masks, exactly as the live sources do). */
  frame(slot: 0 | 1, tick: number, out: InputFrame): void {
    const log = this.logs[slot];
    if (!log.has(tick)) {
      out.moveX = 0;
      out.moveY = 0;
      out.held = 0;
      out.pressed = 0;
      out.released = 0;
      return;
    }
    const held = log.held[tick]!;
    const prev = tick > 1 && log.has(tick - 1) ? log.held[tick - 1]! : 0;
    out.moveX = axisOf(log.x[tick]!);
    out.moveY = axisOf(log.y[tick]!);
    out.held = held;
    out.pressed = held & ~prev;
    out.released = prev & ~held;
  }

  /** The match stepped to `tick`: remember its checksum (and full hash on hash ticks), compare with the peer's. */
  stepped(tick: number, checksum: number, hash?: number): void {
    this.simTick = tick;
    if (this.done) return;
    if (tick >= this.ck.length) {
      let n = this.ck.length;
      while (n <= tick) n *= 2;
      const b = new Uint32Array(n);
      b.set(this.ck);
      this.ck = b;
    }
    this.ck[tick] = checksum >>> 0;
    this.lastCkTick = tick;
    this.lastCk = checksum >>> 0;
    const r = this.pendingCk.get(tick);
    if (r !== undefined) {
      this.pendingCk.delete(tick);
      this.compare('checksum', tick, r);
    }
    if (hash !== undefined) {
      this.hashes.set(tick, hash >>> 0);
      this.lastHashTick = tick;
      this.lastHash = hash >>> 0;
      const rh = this.pendingHash.get(tick);
      if (rh !== undefined) {
        this.pendingHash.delete(tick);
        this.compare('hash', tick, rh);
      }
    }
  }

  /** This peer's checksum after `tick` (undefined if not simulated yet). */
  checksumAt(tick: number): number | undefined {
    return tick >= 1 && tick <= this.lastCkTick && tick < this.ck.length ? this.ck[tick] : undefined;
  }

  hashAt(tick: number): number | undefined {
    return this.hashes.get(tick);
  }

  /** The packet to send now: every unacknowledged local input, our newest checksum and hash. */
  packet(): Uint8Array {
    const log = this.logs[this.local];
    const first = this.peerAck + 1;
    const last = Math.min(this.localNext - 1, first + MAX_INPUTS_PER_PACKET - 1);
    const inputs = [];
    for (let t = first; t <= last; t++) inputs.push({ x: log.x[t]!, y: log.y[t]!, held: log.held[t]! });
    const p: InputPacket = {
      epoch: this.epoch,
      ack: this.remoteContig,
      first,
      inputs,
      ckTick: this.lastCkTick,
      ck: this.lastCk,
      hashTick: this.lastHashTick,
      hash: this.lastHash,
    };
    return encodeInput(p);
  }

  /** Take a packet from the peer. Returns false if it was malformed or from another match. */
  receive(buf: Uint8Array): boolean {
    const p = decodeInput(buf);
    if (!p || p.epoch !== (this.epoch & 0xff)) {
      this.packetsBad++;
      return false;
    }
    this.packetsIn++;
    // our own inputs the peer holds: never beyond what we have produced
    if (p.ack > this.peerAck) this.peerAck = Math.min(p.ack, this.localNext - 1);
    const log = this.logs[this.remote];
    // a sane window only: a corrupt `first` must not make us allocate gigabytes
    if (p.first > this.delay && p.first < this.remoteContig + 100_000) {
      for (let i = 0; i < p.inputs.length; i++) {
        const t = p.first + i;
        if (log.has(t)) continue;
        const w = p.inputs[i]!;
        log.set(t, w.x, w.y, w.held & ~LOCAL_ONLY);
      }
      while (log.has(this.remoteContig + 1)) this.remoteContig++;
    }
    if (!this.done) {
      if (p.ckTick > 0) this.remoteValue('checksum', p.ckTick, p.ck);
      if (p.hashTick > 0) this.remoteValue('hash', p.hashTick, p.hash);
    }
    return true;
  }

  private remoteValue(kind: 'checksum' | 'hash', tick: number, v: number): void {
    if (tick <= this.simTick) {
      this.compare(kind, tick, v);
      return;
    }
    const pending = kind === 'checksum' ? this.pendingCk : this.pendingHash;
    if (pending.size < 512) pending.set(tick, v >>> 0);
  }

  private compare(kind: 'checksum' | 'hash', tick: number, remote: number): void {
    if (this.desync || this.done) return;
    const local = kind === 'checksum' ? this.checksumAt(tick) : this.hashes.get(tick);
    if (local === undefined) return;
    if (local !== remote >>> 0) this.desync = { tick, kind, local, remote: remote >>> 0 };
  }

  /** The whole input log so far (for a desync report and offline replay). */
  dump(): InputDump {
    const n = this.simTick;
    const inputs: [number[], number[]] = [[], []];
    for (const s of [0, 1] as const) {
      const log = this.logs[s];
      for (let t = 1; t <= n; t++)
        inputs[s].push(
          log.has(t) ? axisOf(log.x[t]!) : 0,
          log.has(t) ? axisOf(log.y[t]!) : 0,
          log.held[t] ?? 0,
        );
    }
    const checksums: number[] = [];
    for (let t = 1; t <= Math.min(n, this.lastCkTick); t++) checksums.push(this.ck[t]!);
    return {
      v: 1,
      localSlot: this.local,
      delay: this.delay,
      ticks: n,
      inputs,
      checksums,
      hashes: [...this.hashes.entries()],
    };
  }
}
