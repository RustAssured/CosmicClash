import { rgba } from '@/contracts';
import { registerDiagnostics, registerTuning, type TuningKnob } from '@/debug/tuning';
import type { MouthFighter } from './fighter';
import { MOUTH_LIVE, MOUTH_LOOK, MOUTH_TUNE } from './tuning';

/**
 * The Mouth's tuning panel in the debug overlay (MASTER_PROMPT rule 6: WJ tunes during real matches; backquote / R3): the
 * oracle's own five sliders (slide, strike, lag, reach, track), the Gate 3A numbers marked "to tune", and the light rig; plus
 * diagnostics — the hurt capsules, the beat, health and the locked strike point. Registered on the fighter's first tick under
 * `match.p<n>.mouth`, so the match's own release drops it with the rest.
 */
export function registerMouthKnobs(f: MouthFighter): void {
  const owner = `match.p${f.slot + 1}.mouth`;
  const k = (
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    o: Record<string, number>,
    field: string,
  ): TuningKnob => ({
    key,
    label,
    min,
    max,
    step,
    get: () => o[field]!,
    set: (v) => (o[field] = v),
  });
  const tune = MOUTH_TUNE as unknown as Record<string, number>;
  const live = MOUTH_LIVE as unknown as Record<string, number>;
  const look = MOUTH_LOOK as unknown as Record<string, number>;
  registerTuning(owner, [
    k('slide', 'SLIDE PX/S', 60, 500, 1, tune, 'slide'),
    k('strike', 'STRIKE SPEED', 0.5, 2, 0.01, tune, 'strike'),
    k('lag', 'NECK WEIGHT', 0.4, 2, 0.01, tune, 'lag'),
    k('reach', 'REACH', 0.4, 1.4, 0.01, tune, 'reach'),
    k('track', 'TRACKING', 0.4, 3, 0.01, tune, 'track'),
    k('eRef', 'E REF (POWER 1)', 120, 1200, 10, live, 'eRef'),
    k('damageMul', 'DAMAGE TAKEN X', 0.2, 3, 0.05, live, 'damageMul'),
    k('continuousMul', 'BEAM SHARE', 0, 1, 0.05, live, 'continuousMul'),
    k('debrisMul', 'DEBRIS SHARE', 0, 1, 0.05, live, 'debrisMul'),
    k('biteEnergy', 'BITE ENERGY', 100, 2500, 10, live, 'biteEnergy'),
    k('sweepEnergy', 'SWEEP ENERGY', 100, 2500, 10, live, 'sweepEnergy'),
    k('crushEnergy', 'CRUSH ENERGY', 100, 2500, 10, live, 'crushEnergy'),
    k('safeStrip', 'SAFE STRIP PX', 0, 300, 5, live, 'safeStrip'),
    k('keepOut', 'COIL KEEP-OUT PX', 40, 160, 1, live, 'keepOut'),
    k('grabR', 'GRAB RADIUS', 30, 140, 1, live, 'grabR'),
    k('sky', 'LIGHT: ORACLE 0/SKY 1', 0, 1, 1, look, 'sky'),
  ]);
  registerDiagnostics(owner, (d) => {
    const h = f.hurt;
    for (let i = 0; i < h.n; i++) {
      const c = h.caps[i]!;
      const col =
        c.part === 'head'
          ? rgba(255, 220, 120)
          : c.part === 'neck'
            ? rgba(255, 120, 120)
            : rgba(160, 130, 240);
      d.line(d.sx(c.x0), d.sy(c.y0), d.sx(c.x1), d.sy(c.y1), col);
      d.circle(d.sx(c.x1), d.sy(c.y1), c.r, col);
    }
    const v = f.view;
    const m = v.mouth;
    d.text(
      d.sx(v.x) - 20,
      d.sy(v.y) - 70,
      `${m.beat.toUpperCase()} ${Math.round(v.integrityPct)}%`,
      rgba(239, 226, 214),
    );
    for (const t of v.threats) {
      const s = t.shape;
      if (s.kind === 'point') d.circle(d.sx(s.x), d.sy(s.y), s.r, rgba(255, 90, 70));
    }
  });
}
