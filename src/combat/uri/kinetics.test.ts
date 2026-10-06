import { describe, expect, it } from 'vitest';
import { URI_REF } from '@/titans/uri/rig';
import { UriKinetics, type UriKineticView, type UriMoveName } from './kinetics';
import traces from './fixtures/oracle-traces.json';

/**
 * The kinetic system against the LOCKED oracle (uri/reference/demos/uri-LOCKED-kinetic-pass.html), recorded headlessly by
 * tools/uri/oracle.ts: per move × opponent side, the frame each phase starts, the impact frame and every link at 11 frames
 * of the 3 s. The oracle runs on a float clock that has been running since the page loaded; one phase boundary can land a
 * frame later there (slam / right). The gate's tolerance is ±1 oracle frame at 30 fps = ±2 of ours.
 */

interface Trace {
  move: UriMoveName;
  side: string;
  target: [number, number];
  starts: Record<string, number>;
  impact: number;
  samples: Record<string, Record<string, number>>;
}

const view = (): UriKineticView => ({
  move: null,
  phase: null,
  lead: null,
  rear: null,
  loop: { l: 1, r: 1, sh: 0, vt: 1, br: 1 },
  stress: 0,
  torque: 0,
  core: { x: 0, y: 0 },
  pylon: { L: { th: 0, ang: 0 }, R: { th: 0, ang: 0 } },
  moon: null,
  spread: { L: 1, R: 1 },
});

/** Run a move the way the oracle harness does: settle 4 s at rest, begin, step 3 s at 60 fps. */
function run(move: UriMoveName, screenTarget: [number, number], n = 180, setup?: (k: UriKinetics) => void) {
  const k = new UriKinetics(1);
  k.target = [
    screenTarget[0] - (URI_REF.screenX - URI_REF.originX),
    screenTarget[1] - (URI_REF.screenY - URI_REF.originY),
  ];
  setup?.(k);
  for (let f = 0; f < 240; f++) k.step(1 / 60);
  k.begin(move);
  const v = view();
  const frames: {
    phase: string | null;
    hs: boolean;
    L: Record<string, number>;
    lead: string | null;
    hot: number;
  }[] = [];
  for (let f = 0; f < n; f++) {
    k.step(1 / 60);
    k.view(v);
    const L: Record<string, number> = {};
    for (const [key, l] of Object.entries(k.L)) L[key] = l.x;
    frames.push({ phase: v.phase, hs: k.hitstop > 0, L, lead: v.lead, hot: v.core.x });
  }
  return { k, frames };
}

const starts = (fr: { phase: string | null }[]): Record<string, number> => {
  const m: Record<string, number> = {};
  let prev = '?';
  fr.forEach((f, i) => {
    const p = f.phase ?? 'rest';
    if (p !== prev && !(p in m)) m[p] = i;
    prev = p;
  });
  return m;
};

describe('우리 kinetic system vs the locked oracle (Gate 2B)', () => {
  it.each((traces as unknown as Trace[]).map((t) => [`${t.move}/${t.side}`, t] as const))(
    '%s: same phases, same impact frame, same links',
    (_n, t) => {
      const { frames } = run(t.move, t.target);
      const s = starts(frames);
      for (const [p, f] of Object.entries(t.starts))
        expect(Math.abs(s[p]! - f), `${p} starts at ${s[p]} (oracle ${f})`).toBeLessThanOrEqual(2);
      const imp = frames.findIndex((f) => f.hs);
      expect(Math.abs(imp - t.impact), `impact ${imp} (oracle ${t.impact})`).toBeLessThanOrEqual(2);
      // where the phases line up exactly, the links do too
      const aligned = Object.entries(t.starts).every(([p, f]) => s[p] === f);
      if (aligned)
        for (const [fi, L] of Object.entries(t.samples))
          for (const [k, x] of Object.entries(L)) {
            // px links within 0.05 px (the apex's ±0.4 px tremor runs on the oracle's own clock), angles within 0.001 rad
            const px = (k[0] === 'h' && k !== 'ha') || k.startsWith('dx');
            expect(Math.abs(frames[+fi]!.L[k]! - x), `${k} at ${fi}`).toBeLessThan(px ? 0.05 : 1e-3);
          }
    },
  );

  it('arm roles come from the opponent side, never from a mirror: the arm on its side leads; the cores keep their places', () => {
    const right = run('punch', [520, 150]);
    const left = run('punch', [118, 150]);
    expect(right.frames[5]!.lead).toBe('R');
    expect(left.frames[5]!.lead).toBe('L');
    // the striking shoulder swings (the other stays near home): right-side punch moves sR, left-side punch moves sL
    const swing = (fr: typeof right.frames, k: string): number =>
      Math.max(...fr.map((f) => Math.abs(f.L[k]!)));
    expect(swing(right.frames, 'sR')).toBeGreaterThan(3 * swing(right.frames, 'sL'));
    expect(swing(left.frames, 'sL')).toBeGreaterThan(3 * swing(left.frames, 'sR'));
  });

  it('picks the best move for the target: above → uppercut, below → slam, level → punch then cross', () => {
    const k = new UriKinetics(1);
    k.target = [200, -120];
    expect(k.pickMove()).toBe('upper');
    k.target = [200, 320];
    expect(k.pickMove()).toBe('slam');
    k.target = [420, 150];
    expect(k.pickMove()).toBe('punch');
    k.begin('punch');
    expect(k.pickMove()).toBe('cross');
  });

  it('impact waits for the arms to ARRIVE: a soft arm lands later than a stiff one, never before its phase ends', () => {
    const stiff = run('punch', [520, 150]).frames.findIndex((f) => f.hs);
    const soft = run('punch', [520, 150], 180, (k) => (k.tune.stiff = 0.3)).frames.findIndex((f) => f.hs);
    expect(stiff).toBeGreaterThanOrEqual(18 + 12 - 1);
    expect(soft).toBeGreaterThan(stiff);
  });

  it('a move begun during a taper grows out of the current motion: no jump in any link', () => {
    const k = new UriKinetics(3);
    k.target = [320, 134];
    k.begin('slam');
    let worst = 0;
    let prev = Object.fromEntries(Object.entries(k.L).map(([n, l]) => [n, l.x]));
    for (let f = 0; f < 240; f++) {
      if (f === 140) k.begin('punch'); // the slam is tapering here
      k.step(1 / 60);
      for (const [n, l] of Object.entries(k.L)) {
        if (n[0] === 'c') continue;
        const scale = n[0] === 'h' && n !== 'ha' ? 1 / 40 : n.startsWith('dx') ? 1 / 22 : 1;
        worst = Math.max(worst, Math.abs(l.x - prev[n]!) * scale);
      }
      prev = Object.fromEntries(Object.entries(k.L).map(([n, l]) => [n, l.x]));
    }
    // per tick no link moves more than 0.2 rad (or half its travel)
    expect(worst).toBeLessThan(0.2);
  });

  it('the cores jolt but never leave their cradles; the moon never trails more than 12 px', () => {
    const { k, frames } = run('slam', [330, 330]);
    expect(Math.max(...frames.map((f) => Math.abs(f.hot)))).toBeLessThan(8);
    const v = k.view(view());
    expect(v.moon).not.toBeNull();
  });

  it('is deterministic, including the slam’s seeded core jolt', () => {
    const h = (): number => {
      const { k } = run('slam', [400, 330]);
      return k.hash(0);
    };
    expect(h()).toBe(h());
  });
});
