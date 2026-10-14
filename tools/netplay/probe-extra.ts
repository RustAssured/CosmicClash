import { DMath } from '@/contracts/dmath';

/** The deterministic replacements, probed beside the engine's Math (tools/netplay/replay-core.ts `mathProbe`). */
export const PROBE_EXTRA: Record<string, (x: number, y: number) => number> = {
  dsin: (x) => DMath.sin(x),
  dcos: (x) => DMath.cos(x),
  dtan: (x) => DMath.tan(x),
  datan: (x) => DMath.atan(x),
  datan2: (x, y) => DMath.atan2(y, x),
  dasin: (x) => DMath.asin(Math.max(-1, Math.min(1, x / 3.2))),
  dacos: (x) => DMath.acos(Math.max(-1, Math.min(1, x / 3.2))),
  dexp: (x) => DMath.exp(x / 40),
  dlog: (x) => DMath.log(Math.abs(x) + 1e-3),
  dpow: (x, y) => DMath.pow(Math.abs(x) + 1e-3, y / 40),
  dcube: (x) => DMath.pow(x, 3),
  dpow13: (x) => DMath.pow(Math.abs(x), 1.3),
  dhypot: (x, y) => DMath.hypot(x, y),
  dhypot3: (x, y) => DMath.hypot(x, y, x - y),
  dcbrt: (x) => DMath.cbrt(x),
  dtanh: (x) => DMath.tanh(x),
};
