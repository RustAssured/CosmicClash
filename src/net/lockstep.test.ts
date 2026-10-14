import { describe, expect, it } from 'vitest';
import { emptyInput, type MatchConfig, type TitanId } from '@/contracts';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { arenaForMatch } from '@/combat/mouth/arena';
import { createMatterWorld } from '@/matter';
import { TITAN_SKY } from '@/render/unified';
import { createAiSource, createMatch, type Match } from '@/sim';
import { STAGE_INFO } from '@/stages/info';
import { getTitanDef } from '@/titans';
import { Rng } from '@/contracts';
import {
  PKT_INPUT,
  axisOf,
  decodeInput,
  decodePing,
  encodeInput,
  encodePing,
  quantAxis,
  PKT_PING,
} from './codec';
import { normaliseRoomCode, parseLinkSim, randomRoomCode, roomLink } from './config';
import { NetMatchDriver } from './driver';
import { DEFAULT_DELAY, Lockstep, delayFor } from './lockstep';
import { FakeScheduler, createLoopbackPair } from './loopback';
import type { NetLink } from './link';

function build(cfg: MatchConfig): Match {
  return createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: arenaForMatch(STAGE_INFO[cfg.stage].arena, [cfg.slots[0].titan, cfg.slots[1].titan]),
    lighting: TITAN_SKY,
  });
}

const config = (a: TitanId, b: TitanId, seed: number): MatchConfig => ({
  seed,
  stage: 'nursery',
  mode: 'versus',
  footwork: 'orbit',
  pace: 1.3,
  roundSeconds: 120,
  slots: [
    { titan: a, controller: 'human' },
    { titan: b, controller: 'human' },
  ],
});

interface Peer {
  match: Match;
  driver: NetMatchDriver;
  link: NetLink | null;
}

/**
 * Two peers in lockstep over a fake lossy link with random delay. Each peer's local slot is played by its own AI, which
 * reads its OWN match (like a human watching their own screen). Each peer's frame clock jitters independently, and a peer
 * now and then misses frames (a GC pause, a slow frame).
 */
function duel(opts: {
  a: TitanId;
  b: TitanId;
  seed: number;
  ticks: number;
  delay: number;
  latencyMs: number;
  jitterMs: number;
  loss: number;
  corruptAt?: number;
}): { peers: [Peer, Peer]; wallMs: number } {
  const sched = new FakeScheduler();
  const rng = new Rng(opts.seed * 31 + 7);
  const rand = (): number => rng.next();
  const cfg = config(opts.a, opts.b, opts.seed);
  const peers: Peer[] = [];
  for (const slot of [0, 1] as const) {
    const match = build(cfg);
    const driver = new NetMatchDriver(new Lockstep(slot, opts.delay), (b) => peers[slot]!.link?.sendFast(b));
    const ai = createAI(4, getTitanDef(cfg.slots[slot].titan), opts.seed * 7 + slot, { footwork: 'orbit' });
    driver.attach(match, createAiSource(match, slot, ai));
    peers.push({ match, driver, link: null });
  }
  const [la, lb] = createLoopbackPair(
    { latencyMs: opts.latencyMs, jitterMs: opts.jitterMs, loss: opts.loss },
    sched,
    rand,
    { fast: (b) => peers[0]!.driver.receive(b), control: () => undefined, state: () => undefined },
    { fast: (b) => peers[1]!.driver.receive(b), control: () => undefined, state: () => undefined },
  );
  peers[0]!.link = la;
  peers[1]!.link = lb;

  // each peer has its own frame clock: 16.7 ms ± 2 ms, and a 1 % chance a frame takes 120 ms
  const nextAt = [0, 5];
  const fire = (s: 0 | 1): void => {
    const p = peers[s]!;
    if (p.match.tick < opts.ticks && p.driver.beforeStep()) {
      p.match.step();
      if (opts.corruptAt !== undefined && s === 1 && p.match.tick === opts.corruptAt) {
        // a desync of our own making: carve a tenth off one fighter on one peer only
        p.match.world.carve(p.match.fighters[0].body.id, 0.9, 1);
      }
      p.driver.afterStep();
    }
    const slow = rand() < 0.01 ? 120 : 0;
    nextAt[s] = sched.now() + 1000 / 60 + (rand() - 0.5) * 4 + slow;
  };
  let wall = 0;
  while (
    (peers[0]!.match.tick < opts.ticks || peers[1]!.match.tick < opts.ticks) &&
    wall < opts.ticks * 400
  ) {
    const s: 0 | 1 = nextAt[0]! <= nextAt[1]! ? 0 : 1;
    const at = nextAt[s]!;
    sched.advance(Math.max(0, at - sched.now()));
    fire(s);
    if (peers[0]!.driver.lockstep.desync || peers[1]!.driver.lockstep.desync) {
      // let the other side see it too, then stop
      sched.advance(500);
      break;
    }
    wall = sched.now();
  }
  return { peers: peers as [Peer, Peer], wallMs: wall };
}

describe('netplay codec and config', () => {
  it('round-trips an input packet', () => {
    const p = {
      epoch: 3,
      ack: 1234,
      first: 1200,
      inputs: [
        { x: -127, y: 127, held: 0x3ff },
        { x: 0, y: -5, held: 0 },
      ],
      ckTick: 1210,
      ck: 0xdeadbeef,
      hashTick: 1200,
      hash: 0x12345678,
    };
    const buf = encodeInput(p);
    expect(buf[0]).toBe(PKT_INPUT);
    expect(buf.length).toBe(11 + 2 * 4 + 16);
    expect(decodeInput(buf)).toEqual(p);
    expect(decodeInput(buf.subarray(0, buf.length - 1))).toBeNull();
    const ping = decodePing(encodePing(PKT_PING, 77, 1234.5));
    expect(ping).toEqual({ type: PKT_PING, id: 77, sentMs: 1234.5 });
  });

  it('quantises the stick to int8 symmetrically', () => {
    expect(quantAxis(1)).toBe(127);
    expect(quantAxis(-1)).toBe(-127);
    expect(quantAxis(2)).toBe(127);
    expect(quantAxis(NaN)).toBe(0);
    expect(axisOf(quantAxis(0.5))).toBeCloseTo(0.5, 2);
  });

  it('picks the input delay from RTT and jitter, clamped to 2–6 ticks, 3 by default', () => {
    expect(delayFor(null)).toBe(DEFAULT_DELAY);
    expect(DEFAULT_DELAY).toBe(3);
    expect(delayFor(5, 0)).toBe(2);
    expect(delayFor(60, 5)).toBe(3);
    expect(delayFor(120, 10)).toBe(5);
    expect(delayFor(400, 50)).toBe(6);
  });

  it('room codes avoid look-alikes and links carry them', () => {
    for (let i = 0; i < 50; i++) {
      const c = randomRoomCode();
      expect(c).toMatch(/^[A-HJ-KMNP-Z2-9]{6}$/);
      expect(normaliseRoomCode(c.toLowerCase())).toBe(c);
    }
    expect(normaliseRoomCode('ab0def')).toBeNull();
    expect(normaliseRoomCode('https://x.app/play/?room=ABCDEF')).toBe('ABCDEF');
    expect(
      roomLink('ABCDEF', { origin: 'https://x.app', pathname: '/play/', search: '?net=local&seed=3' }),
    ).toBe('https://x.app/play/?net=local&room=ABCDEF');
    expect(parseLinkSim('40,10,0.05')).toEqual({ latencyMs: 40, jitterMs: 10, loss: 0.05 });
  });
});

describe('netplay lockstep over a lossy link (STEP1 §5)', () => {
  it('two matches in lockstep over a lossy, jittery link end with identical hashes', () => {
    const ticks = 900;
    const { peers, wallMs } = duel({
      a: 'planet',
      b: 'lastone',
      seed: 11,
      ticks,
      delay: 3,
      latencyMs: 35,
      jitterMs: 25,
      loss: 0.15,
    });
    const [p0, p1] = peers;
    expect(p0.driver.lockstep.desync).toBeNull();
    expect(p1.driver.lockstep.desync).toBeNull();
    expect(p0.match.tick).toBe(ticks);
    expect(p1.match.tick).toBe(ticks);
    expect(p0.match.hash()).toBe(p1.match.hash());
    for (let t = 1; t <= ticks; t++)
      expect(p0.driver.lockstep.checksumAt(t), `tick ${t}`).toBe(p1.driver.lockstep.checksumAt(t));
    // both sides really played (inputs crossed the link): the AIs moved and pressed buttons
    const d0 = p0.driver.lockstep.dump();
    expect(d0.inputs[1].some((v, i) => i % 3 === 2 && v !== 0)).toBe(true);
    expect(d0.inputs[0]).toEqual(p1.driver.lockstep.dump().inputs[0]);
    // with 15 % loss and up to 60 ms one-way, the sim waited sometimes but kept close to real time
    expect(wallMs).toBeLessThan(((ticks * 1000) / 60) * 2);
  }, 120_000);

  it('a desync is caught on the tick it happens, on both peers', () => {
    const { peers } = duel({
      a: 'asteroid',
      b: 'nexus',
      seed: 5,
      ticks: 400,
      delay: 2,
      latencyMs: 10,
      jitterMs: 5,
      loss: 0.05,
      corruptAt: 250,
    });
    const d0 = peers[0].driver.lockstep.desync;
    const d1 = peers[1].driver.lockstep.desync;
    expect(d0 ?? d1).not.toBeNull();
    for (const d of [d0, d1]) if (d) expect(d.tick).toBeGreaterThanOrEqual(250);
    expect((d0 ?? d1)!.tick).toBeLessThanOrEqual(251);
  }, 120_000);

  it('the first ticks need no network: the delay is pre-filled identically', () => {
    const ls = new Lockstep(0, 3);
    const f = emptyInput();
    expect(ls.ready()).toBe(true); // ticks 1–3 are pre-filled for both slots
    expect(ls.needLocal()).toBe(true);
    ls.pushLocal({ moveX: 1, moveY: 0, held: 1, pressed: 1, released: 0 });
    expect(ls.localNext).toBe(5);
    expect(ls.needLocal()).toBe(false);
    ls.frame(1, 1, f);
    expect(f.held).toBe(0);
    // tick 4 is the first with a remote input: until it arrives, tick 4 waits
    for (let t = 1; t <= 3; t++) ls.stepped(t, t);
    expect(ls.ready()).toBe(false);
    expect(ls.waitingFor).toBe(1);
  });
});
