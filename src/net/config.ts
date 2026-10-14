/**
 * Netplay configuration (docs/netplay/STEP1.md).
 *
 * NETPLAY_URL is the deployed signalling worker (netplay-worker/README.md, step 5; WJ's Cloudflare account, 2026-10-14).
 * Empty: the ONLINE menu says online play is not set up yet. A URL parameter overrides it for testing:
 *   ?net=https://adeuk-netplay.example.workers.dev   another worker
 *   ?net=local                                       no worker: two tabs of this browser talk over a BroadcastChannel
 *   &netsim=40,10,0.05                               (local only) one-way latency ms, jitter ms, loss 0..1 on the input lane
 */
export const NETPLAY_URL = 'https://adeuk-netplay.wj-games.workers.dev';

/** Bumped whenever the wire format or the session protocol changes (both peers must agree). */
export const NET_PROTOCOL = 1;

declare const __ADEUK_BUILD__: string | undefined;

/**
 * The build id exchanged at the handshake: the protocol version plus the commit the bundle was built from (vite.config.ts
 * defines `__ADEUK_BUILD__` from Vercel's / GitHub Actions' commit SHA, else the local .git HEAD, else 'dev'). Two peers on
 * different builds could run different sims, so they refuse to play.
 */
export function buildId(): string {
  const b = typeof __ADEUK_BUILD__ === 'string' && __ADEUK_BUILD__ ? __ADEUK_BUILD__ : 'dev';
  return `p${NET_PROTOCOL}-${b}`;
}

/** Simulated network conditions for the loopback links (tests and the two-tab local mode). */
export interface LinkSim {
  /** One-way base latency, ms. */
  latencyMs: number;
  /** Extra random one-way delay, uniform in [0, jitterMs]. */
  jitterMs: number;
  /** Probability that an input-lane packet is lost (the control lane is reliable). */
  loss: number;
}

export const NO_SIM: LinkSim = { latencyMs: 0, jitterMs: 0, loss: 0 };

export interface NetOptions {
  /** 'worker': WebRTC with the signalling worker at `url`; 'local': BroadcastChannel between tabs; 'off': not configured. */
  mode: 'worker' | 'local' | 'off';
  /** Local mode over the Playwright bridge (`?net=bridge`: two separate browsers in the e2e) instead of a BroadcastChannel. */
  bridge: boolean;
  url: string;
  sim: LinkSim;
  /** Testing: the local slot is played by the AI at this level (1–6), and picks / stage are chosen automatically. */
  autoAi: number;
  /** Testing: the titan the auto player picks, and the stage an auto host chooses. */
  autoPick: string | null;
  autoStage: string | null;
  /** Testing (`netdelay=2..6`): the host uses this input delay instead of measuring one (0 = measure). */
  forceDelay: number;
}

export function parseLinkSim(v: string | null): LinkSim {
  if (!v) return { ...NO_SIM };
  const [l, j, p] = v.split(',').map((s) => parseFloat(s));
  const ok = (x: number | undefined, d: number): number => (x !== undefined && Number.isFinite(x) ? x : d);
  return {
    latencyMs: Math.max(0, ok(l, 0)),
    jitterMs: Math.max(0, ok(j, 0)),
    loss: Math.min(0.9, Math.max(0, ok(p, 0))),
  };
}

export function netOptions(search: string, configured: string = NETPLAY_URL): NetOptions {
  const q = new URLSearchParams(search);
  const net = q.get('net');
  let mode: NetOptions['mode'];
  let url = '';
  if (net === 'local' || net === 'bridge') mode = 'local';
  else if (net && /^https?:\/\//i.test(net)) {
    mode = 'worker';
    url = net;
  } else if (configured) {
    mode = 'worker';
    url = configured;
  } else mode = 'off';
  const ai = parseInt(q.get('netai') ?? '0', 10);
  return {
    mode,
    bridge: net === 'bridge',
    url: url.replace(/\/+$/, ''),
    sim: parseLinkSim(q.get('netsim')),
    autoAi: Number.isFinite(ai) ? Math.min(6, Math.max(0, ai)) : 0,
    autoPick: q.get('netpick'),
    autoStage: q.get('netstage'),
    forceDelay: ((d) => (d >= 2 && d <= 6 ? d : 0))(parseInt(q.get('netdelay') ?? '0', 10) || 0),
  };
}

/** Room codes: six characters from an alphabet without look-alikes (no 0/O, 1/I/L). */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

/** Normalise a typed or pasted code (or a whole `?room=` link) to the canonical form, or null if it is not one. */
export function normaliseRoomCode(raw: string): string | null {
  const m = /[?&]room=([A-Za-z0-9]+)/.exec(raw);
  const s = (m ? m[1]! : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== ROOM_CODE_LENGTH) return null;
  for (const c of s) if (!ROOM_ALPHABET.includes(c)) return null;
  return s;
}

export function randomRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return s;
}

/** The link a host shares: this page's own address with `?room=CODE` (works on Vercel, Pages and localhost alike). */
export function roomLink(code: string, loc: Pick<Location, 'origin' | 'pathname' | 'search'>): string {
  const q = new URLSearchParams(loc.search);
  const keep = new URLSearchParams();
  // a local test link keeps its transport so the second tab joins the same way
  for (const k of ['net', 'netsim']) {
    const v = q.get(k);
    if (v) keep.set(k, v);
  }
  keep.set('room', code);
  return `${loc.origin}${loc.pathname}?${keep.toString()}`;
}
