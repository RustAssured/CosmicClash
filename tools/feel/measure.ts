/**
 * Headless feel measurements (deterministic, Node): per command, what the player sees and when.
 *   npx tsx tools/feel/measure.ts [--a=lastone] [--b=planet] [--real] [--orbit] [--gap=230] [--json=out.json]
 *
 * For each command against an idle foe: the fighter-reported `feel` respond (ticks + channel) and settle, the observed first
 * changed integer root/lean, lean overshoot, root travel (back before the blow, forward after it, where it rests), the
 * anticipation and total ticks of moves. Then the impact model: a blow landed at the centre / edge / glancing / low on the
 * foe (class, spin Δω, Δv). Then whether each heavy move CONNECTS from `--gap` (default 230 px) and its hit-stop. With
 * `--orbit`: 4 s of pure tangential thrust (time per orbital state, angle swept around the foe, distance band).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Btn, type SimEvent, type TitanId } from '@/contracts';
import { ORBIT } from '@/combat/orbit';
import { makeLab, measureCommand, probeHit, type FeelCommand } from '@/combat/testing/feelLab';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((x) => x.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');
const flag = (k: string): boolean => args.includes(`--${k}`);

const A = opt('a', 'lastone') as TitanId;
const B = opt('b', 'planet') as TitanId;
const REAL = flag('real');
const ORBIT_ON = flag('orbit');
const GAP = +opt('gap', '230');
const JSON_OUT = opt('json', '');
const footwork = ORBIT_ON ? 'orbit' : 'classic';

const out: Record<string, unknown> = { a: A, b: B, real: REAL, footwork };
const ms = (t: number | null): string => (t === null ? '   —' : `${Math.round((t * 1000) / 60)}`.padStart(4));

/* ---- 1. commands ---- */
const cmds: FeelCommand[] = [
  'strike',
  'crush',
  'surge',
  'signature',
  'guard',
  'feint',
  'steer-fwd',
  'steer-back',
  'steer-up',
];
console.log(`\n${A} (vs idle ${B}), ${footwork}, ${REAL ? 'real matter world' : 'fake world'}`);
console.log('command      respond  ch     1st px  settle ms  overshoot  back  fwd  rest  antic  total');
const recs = [];
for (const c of cmds) {
  // 300 px: clear of the foe and inside the soft tether (which would bleed a backward step); sticks are held 1 s
  // stepping back starts closer, so the second of cruising is not spent in the soft tether
  const lab = makeLab({ a: A, b: B, gap: c === 'steer-back' ? 160 : 300, real: REAL, footwork });
  const r = measureCommand(lab, c, c.startsWith('steer') ? 75 : 200);
  recs.push(r);
  console.log(
    `${c.padEnd(12)} ${String(r.respond ?? '—').padStart(7)}  ${(r.channel ?? '—').padEnd(5)} ${String(r.firstPixel ?? '—').padStart(6)}  ${ms(r.settle).padStart(9)}  ${r.overshoot.toFixed(0).padStart(9)}  ${String(r.back).padStart(4)} ${String(r.fwd).padStart(4)} ${String(r.rest).padStart(5)}  ${String(r.anticipation).padStart(5)}  ${String(r.total).padStart(5)}`,
  );
}
out['commands'] = recs;

/* ---- 2. the impact model: where a blow lands ---- */
console.log(`\nimpact on ${B}: class, spin Δω (rad/s), Δv (px/s)`);
const probes: Record<string, unknown> = {};
for (const [name, ox, oy] of [
  ['centre', -40, 0],
  ['edge (high)', -35, -26],
  ['glancing (top)', -25, -48],
  ['low', -38, 34],
] as const) {
  const lab = makeLab({ a: A, b: B, gap: 200, real: REAL, footwork });
  const p = probeHit(lab, ox, oy);
  probes[name] = p;
  console.log(
    `  ${name.padEnd(15)} ${p.cls.padEnd(9)} Δω ${p.dw.toFixed(2).padStart(6)}  Δv (${p.dvx.toFixed(0)}, ${p.dvy.toFixed(0)})`,
  );
}
out['impact'] = probes;

/* ---- 3. heavy moves from normal spacing ---- */
console.log(`\nheavy moves from a ${GAP} px gap (idle foe):`);
const heavy: Record<string, unknown> = {};
for (const [who, foe] of [
  [A, B],
  [B, A],
] as const) {
  const lab = makeLab({ a: who, b: foe, gap: GAP, real: REAL, footwork });
  const r = measureCommand(lab, 'crush', 150);
  const hit = lab.events.find((e): e is Extract<SimEvent, { t: 'hit' }> => e.t === 'hit' && e.attacker === 0);
  const hs = lab.events.find((e): e is Extract<SimEvent, { t: 'hitstop' }> => e.t === 'hitstop');
  const cue = lab.events.find((e) => e.t === 'cue' && e.id.startsWith('hit-'));
  const moveId = lab.f0.slotMoves.crush?.id ?? '?';
  heavy[moveId] = {
    connected: !!hit,
    energy: hit?.energy,
    hitstop: hs?.ticks,
    cls: cue && cue.t === 'cue' ? cue.id : null,
    ...r,
  };
  console.log(
    `  ${moveId.padEnd(16)} ${hit ? 'CONNECTS' : 'whiffs  '} hit-stop ${hs?.ticks ?? '—'} ticks, ${cue && cue.t === 'cue' ? cue.id : ''}; anticipation ${r.anticipation} t (${ms(r.anticipation)} ms), total ${r.total} t; root back ${r.back} px, forward ${r.fwd} px, rest ${r.rest} px`,
  );
}
out['heavy'] = heavy;

/* ---- 4. orbital footwork ---- */
if (ORBIT_ON) {
  const lab = makeLab({ a: A, b: B, gap: 260, real: REAL, footwork: 'orbit' });
  const { f0, f1, a, step } = lab;
  const counts: Record<string, number> = {};
  let swept = 0;
  let prevAng = Math.atan2((f0.py - f1.py) * ORBIT.ey, f0.px - f1.px);
  let rMin = 1e9;
  let rMax = 0;
  for (let k = 0; k < 240; k++) {
    // stick along the tangent (screen-space), recomputed every tick: pure circling input
    const dx = f0.px - f1.px;
    const dy = (f0.py - f1.py) * ORBIT.ey;
    const l = Math.hypot(dx, dy) || 1;
    a.moveX = -dy / l;
    a.moveY = dx / l;
    a.held = k === 120 ? Btn.SURGE : 0;
    step();
    const st = f0.view.orbit;
    counts[st] = (counts[st] ?? 0) + 1;
    const ang = Math.atan2((f0.py - f1.py) * ORBIT.ey, f0.px - f1.px);
    let d = ang - prevAng;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    swept += d;
    prevAng = ang;
    const r = Math.hypot(f0.px - f1.px, (f0.py - f1.py) * ORBIT.ey);
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
  }
  out['orbit'] = { counts, sweptDeg: (swept * 180) / Math.PI, rMin, rMax };
  console.log(
    `\norbit: 4 s of tangential thrust: swept ${((swept * 180) / Math.PI).toFixed(0)}° around the foe, scaled distance ${rMin.toFixed(0)}–${rMax.toFixed(0)} px; ticks per state ${JSON.stringify(counts)}`,
  );
}

if (JSON_OUT) {
  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
  console.log(`written ${JSON_OUT}`);
}
