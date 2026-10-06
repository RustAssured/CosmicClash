import { rgba, type FighterView, type TitanId } from '@/contracts';
import { registerDiagnostics, registerTuning, tuning, type DiagCtx, type TuningKnob } from './tuning';

/**
 * The first knobs (the proof of the framework): what WJ tunes during a real match. Per fighter: the global balance knobs
 * (`balance.power` / `balance.durability`) and the knock-back taken; the Witness's rig damping; the AI's engagement gap.
 * Plus one diagnostics layer per fighter (bounds, anchor, velocity, integrity, state) and per AI (plan, breath).
 *
 * Everything here only READS until a player moves a slider (see tuning.ts). Owners are `match.p1.*` / `match.p2.*`;
 * `releaseMatchKnobs` drops them all when the match ends.
 */

/** What this module needs of a fighter (FighterImpl satisfies it structurally). */
export interface KnobFighter {
  readonly view: FighterView;
  readonly feel: { power: number; durability: number; knockMul: number };
  readonly behaviour: unknown;
}

/** What it needs of an AI controller (UtilityAI satisfies it). */
export interface KnobAI {
  engageGap: number;
  readonly currentPlan: string;
  readonly restTicks: number;
  readonly level: number;
}

const PREFIX = 'match.';
const COL = {
  p: [rgba(242, 184, 102), rgba(108, 198, 220)] as const,
  vel: rgba(134, 209, 168),
  core: rgba(247, 250, 255),
  hp: rgba(224, 112, 95),
  text: rgba(230, 236, 245),
};

/**
 * The Witness's XPBD rig drives, reached through its behaviour (a bridge until the behaviour publishes its own knobs: proposal
 * 170). Returns null for every other titan.
 */
function rigDrives(f: KnobFighter): { zeta: number }[] | null {
  const wr = (f.behaviour as { wr?: { rig?: { drives?: { zeta: number }[] } } } | null)?.wr;
  return wr?.rig?.drives ?? null;
}

export function registerMatchKnobs(
  fighters: readonly KnobFighter[],
  titans: readonly TitanId[],
  ais: readonly (KnobAI | null)[],
): void {
  releaseMatchKnobs();
  fighters.forEach((f, i) => {
    const owner = `${PREFIX}p${i + 1}.${titans[i]}`;
    const knobs: TuningKnob[] = [
      {
        key: 'power',
        label: 'BALANCE POWER',
        min: 0.3,
        max: 3,
        step: 0.05,
        get: () => f.feel.power,
        set: (v) => (f.feel.power = v),
      },
      {
        key: 'durability',
        label: 'DURABILITY',
        min: 0.3,
        max: 3,
        step: 0.05,
        get: () => f.feel.durability,
        set: (v) => (f.feel.durability = v),
      },
      {
        key: 'knock',
        label: 'KNOCKBACK TAKEN',
        min: 0.2,
        max: 3,
        step: 0.05,
        get: () => f.feel.knockMul,
        set: (v) => (f.feel.knockMul = v),
      },
    ];
    const drives = rigDrives(f);
    if (drives && drives.length) {
      // one multiplier on every drive's damping ratio, from the values the rig was built with
      const base = drives.map((d) => d.zeta);
      let k = 1;
      knobs.push({
        key: 'rigDamping',
        label: 'RIG DAMPING x',
        min: 0.3,
        max: 2.5,
        step: 0.05,
        get: () => k,
        set: (v) => {
          k = v;
          drives.forEach((d, j) => (d.zeta = base[j]! * v));
        },
      });
    }
    registerTuning(owner, knobs);
    registerDiagnostics(owner, (d) => drawFighter(d, f.view, i));
    const ai = ais[i];
    if (ai) {
      const aiOwner = `${PREFIX}p${i + 1}.ai`;
      registerTuning(aiOwner, [
        {
          key: 'gap',
          label: `AI L${ai.level} GAP (TICKS)`,
          min: 60,
          max: 1500,
          step: 30,
          get: () => ai.engageGap,
          set: (v) => (ai.engageGap = v),
        },
      ]);
      registerDiagnostics(aiOwner, (d) => drawAi(d, f.view, ai, i));
    }
  });
}

export function releaseMatchKnobs(): void {
  tuning.unregisterPrefix(PREFIX);
}

function drawFighter(d: DiagCtx, v: FighterView, slot: number): void {
  const c = COL.p[slot === 0 ? 0 : 1];
  const x0 = d.sx(v.boundsX0);
  const y0 = d.sy(v.boundsY0);
  const w = d.sx(v.boundsX1) - x0;
  const h = d.sy(v.boundsY1) - y0;
  d.box(x0, y0, w, h, c);
  const ax = d.sx(v.x);
  const ay = d.sy(v.y);
  d.line(ax - 3, ay, ax + 3, ay, COL.core);
  d.line(ax, ay - 3, ax, ay + 3, COL.core);
  // velocity: where the anchor will be in a quarter second
  d.arrow(ax, ay, v.vx * 0.25, v.vy * 0.25, COL.vel);
  d.bar(x0, y0 - 6, Math.max(20, Math.min(80, w)), 3, v.integrityPct / 100, COL.hp);
  const move = v.moveId ? ` ${v.moveId.split('.').pop()}/${v.phase ?? ''}` : '';
  d.text(x0, y0 - 13, `${v.state}${move} ${Math.round(v.integrityPct)}%`, COL.text);
}

function drawAi(d: DiagCtx, v: FighterView, ai: KnobAI, slot: number): void {
  const x = d.sx(v.boundsX0);
  const y = d.sy(v.boundsY1) + 3;
  d.text(x, y, `AI ${ai.currentPlan || '-'}`, COL.text);
  // the breath between its own attacks
  d.bar(x, y + 7, 60, 2, Math.min(1, ai.restTicks / Math.max(1, ai.engageGap)), COL.p[slot === 0 ? 0 : 1]);
}
