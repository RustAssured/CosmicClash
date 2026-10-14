import type { LinkSim } from './config';
import { isControlMsg, type ControlMsg, type LinkHandlers, type LinkState, type NetLink } from './link';

/**
 * Links without a server, for testing (docs/netplay/STEP1.md §5):
 *  - `createLoopbackPair`: two in-page endpoints (the automated lockstep test, with a fake clock);
 *  - `createBroadcastLink`: two TABS of one browser over a BroadcastChannel (`?net=local`, and the Playwright e2e).
 * Both simulate latency, jitter and loss on the input lane; the control lane is delayed but reliable and in order.
 */

export interface Scheduler {
  now(): number;
  after(ms: number, fn: () => void): void;
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  after: (ms, fn) => void setTimeout(fn, Math.max(0, ms)),
};

/** A manual clock for tests: `advance(ms)` runs every callback that falls due, in time order. */
export class FakeScheduler implements Scheduler {
  private t = 0;
  private seq = 0;
  private q: { at: number; seq: number; fn: () => void }[] = [];
  now(): number {
    return this.t;
  }
  after(ms: number, fn: () => void): void {
    this.q.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fn });
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.q.length; i++) {
        const e = this.q[i]!;
        if (e.at > end) continue;
        const b = best >= 0 ? this.q[best]! : null;
        if (!b || e.at < b.at || (e.at === b.at && e.seq < b.seq)) best = i;
      }
      if (best < 0) break;
      const e = this.q.splice(best, 1)[0]!;
      this.t = Math.max(this.t, e.at);
      e.fn();
    }
    this.t = end;
  }
}

/** Delivery times for one direction: random delay on the fast lane, delayed-but-ordered on the control lane. */
class Lane {
  private lastCtl = 0;
  constructor(
    private readonly sim: LinkSim,
    private readonly sched: Scheduler,
    private readonly rand: () => number,
  ) {}
  fast(fn: () => void): void {
    if (this.sim.loss > 0 && this.rand() < this.sim.loss) return;
    this.sched.after(this.sim.latencyMs + this.rand() * this.sim.jitterMs, fn);
  }
  control(fn: () => void): void {
    const at = Math.max(
      this.lastCtl + 0.001,
      this.sched.now() + this.sim.latencyMs + this.rand() * this.sim.jitterMs,
    );
    this.lastCtl = at;
    this.sched.after(at - this.sched.now(), fn);
  }
}

class PairEnd implements NetLink {
  state: LinkState = 'open';
  peer!: PairEnd;
  lane!: Lane;
  constructor(readonly h: LinkHandlers) {}
  sendFast(bytes: Uint8Array): void {
    if (this.state !== 'open') return;
    const copy = bytes.slice();
    const peer = this.peer;
    this.lane.fast(() => peer.state === 'open' && peer.h.fast(copy));
  }
  sendControl(msg: ControlMsg): void {
    if (this.state !== 'open') return;
    const copy = JSON.parse(JSON.stringify(msg)) as ControlMsg;
    const peer = this.peer;
    this.lane.control(() => peer.state === 'open' && peer.h.control(copy));
  }
  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const peer = this.peer;
    this.lane.control(() => {
      if (peer.state === 'closed') return;
      peer.state = 'closed';
      peer.h.state('closed');
    });
  }
}

/** Two connected in-page endpoints; open at once. `rand` drives loss and jitter (seed it for a reproducible test). */
export function createLoopbackPair(
  sim: LinkSim,
  sched: Scheduler,
  rand: () => number,
  a: LinkHandlers,
  b: LinkHandlers,
): [NetLink, NetLink] {
  const ea = new PairEnd(a);
  const eb = new PairEnd(b);
  ea.peer = eb;
  eb.peer = ea;
  ea.lane = new Lane(sim, sched, rand);
  eb.lane = new Lane(sim, sched, rand);
  return [ea, eb];
}

interface BcMsg {
  from: 'host' | 'guest';
  k: 'knock' | 'f' | 'c' | 'bye';
  d?: unknown;
}

/** A message pipe between two pages: a BroadcastChannel (two tabs), or the e2e test's bridge (two browsers). */
interface TabPort {
  post(m: BcMsg): void;
  listen(cb: (m: BcMsg) => void): void;
  close(): void;
}

function broadcastPort(code: string): TabPort {
  const ch = new BroadcastChannel(`adeuk-net-${code}`);
  return {
    post: (m) => ch.postMessage(m),
    listen: (cb) => (ch.onmessage = (ev: MessageEvent) => cb(ev.data as BcMsg)),
    close: () => ch.close(),
  };
}

type BridgeWindow = Window & {
  __adeukBridgeOut?: (json: string) => void;
  __adeukBridgeIn?: (json: string) => void;
};

/**
 * The Playwright bridge (`?net=bridge`, e2e/netplay.spec.ts): the test exposes `__adeukBridgeOut` and calls
 * `__adeukBridgeIn` on the other page, so the two pages can live in two separate browsers (two GPU processes).
 */
function bridgePort(): TabPort {
  const w = window as BridgeWindow;
  return {
    post: (m) =>
      w.__adeukBridgeOut?.(
        JSON.stringify(m, (_k, v: unknown) => (v instanceof Uint8Array ? { u8: [...v] } : v)),
      ),
    // the test delivers a batch (a JSON array of the messages queued while the previous delivery was in flight)
    listen: (cb) =>
      (w.__adeukBridgeIn = (json) => {
        const parsed = JSON.parse(json, (_k, v: unknown) =>
          v && typeof v === 'object' && Array.isArray((v as { u8?: unknown }).u8)
            ? new Uint8Array((v as { u8: number[] }).u8)
            : v,
        ) as BcMsg | BcMsg[];
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) cb(m);
      }),
    close: () => void delete w.__adeukBridgeIn,
  };
}

/**
 * One end of a two-tab link over BroadcastChannel `adeuk-net-<code>` (or the e2e bridge). The host tab and the guest tab
 * knock until they hear each other, then the link is open. Closing a tab sends a goodbye.
 */
export function createBroadcastLink(
  code: string,
  role: 'host' | 'guest',
  sim: LinkSim,
  h: LinkHandlers,
  bridge = false,
  sched: Scheduler = realScheduler,
  rand: () => number = Math.random,
): NetLink {
  const ch = bridge ? bridgePort() : broadcastPort(code);
  const lane = new Lane(sim, sched, rand);
  let state: LinkState = 'connecting';
  const post = (k: BcMsg['k'], d?: unknown): void => {
    try {
      ch.post({ from: role, k, d });
    } catch {
      /* closed */
    }
  };
  const setState = (s: LinkState): void => {
    if (state === s || state === 'closed') return;
    state = s;
    h.state(s);
  };
  const knock = (): void => {
    if (state !== 'connecting') return;
    post('knock');
    setTimeout(knock, 300);
  };
  ch.listen((m) => {
    if (!m || m.from === role) return;
    if (m.k === 'bye') {
      setState('closed');
      ch.close();
      return;
    }
    if (state === 'connecting') {
      setState('open');
      post('knock');
    }
    if (m.k === 'f' && m.d instanceof Uint8Array) h.fast(m.d);
    else if (m.k === 'c' && isControlMsg(m.d)) h.control(m.d);
  });
  const bye = (): void => post('bye');
  window.addEventListener('pagehide', bye);
  knock();
  return {
    get state() {
      return state;
    },
    sendFast(bytes) {
      if (state !== 'open') return;
      const copy = bytes.slice();
      lane.fast(() => state === 'open' && post('f', copy));
    },
    sendControl(msg) {
      if (state !== 'open') return;
      lane.control(() => state === 'open' && post('c', msg));
    },
    close() {
      if (state === 'closed') return;
      post('bye');
      state = 'closed';
      window.removeEventListener('pagehide', bye);
      ch.close();
    },
  };
}
