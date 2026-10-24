/**
 * The roster checks, one function per question, shared by the data-driven tests (src/titans/roster.test.ts: every roster
 * titan, so a new titan is covered without new tests) and by `npm run titan:check -- <id>` (tools/titans/check.ts, which
 * also runs the slow balance sweep and prints a report).
 */
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  LOGICAL_H,
  LOGICAL_W,
  MOVE_SLOTS,
  SIZE_CLASSES,
  type Difficulty,
  type SizeClass,
  type MatchConfig,
  type TitanId,
} from '@/contracts';
import { buildMoveInfos } from '@/ai/moves';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef, renderPortrait } from '@/titans';
import { CLASH_DE, deltaE, signaturesClash } from '@/titans/kit/palette';
import { ROSTER, rosterEntry } from '@/titans/roster';

export interface CheckResult {
  ok: boolean;
  /** What was measured, in a line. */
  detail: string;
  problems: string[];
}

const result = (detail: string, problems: string[]): CheckResult => ({
  ok: problems.length === 0,
  detail,
  problems,
});

/**
 * Fits the arena and its size class: the largest dimension of its whole body (the menu portrait, at game size) lies in its
 * class's span; it fits the screen beside a foe (at most half the 640 px width) and below the HUD (at most 300 of the 360 px
 * height); the arena is tall enough for it to stand at rest.
 */
export function checkSize(id: TitanId): CheckResult {
  const e = rosterEntry(id)!;
  const p = renderPortrait(id, 1, DEFAULT_LIGHTING);
  return checkSizeOf(Math.round(p.w * e.portraitScale), Math.round(p.h * e.portraitScale), e.size);
}

/** `checkSize` on a body's measured size (game px): the titan builder runs it live on an unsaved definition. */
export function checkSizeOf(w: number, h: number, size: SizeClass): CheckResult {
  const [lo, hi] = SIZE_CLASSES[size];
  const big = Math.max(w, h);
  const problems: string[] = [];
  if (big < lo || big > hi) problems.push(`${big} px across is outside the '${size}' class (${lo}–${hi} px)`);
  if (w > LOGICAL_W / 2) problems.push(`${w} px wide: more than half the screen (${LOGICAL_W / 2} px)`);
  if (h > LOGICAL_H - 60)
    problems.push(`${h} px tall: taller than the screen below the HUD (${LOGICAL_H - 60} px)`);
  if (h / 2 > DEFAULT_ARENA.restY - DEFAULT_ARENA.minY)
    problems.push(`its top would leave the arena at rest (${h} px tall, rest line ${DEFAULT_ARENA.restY})`);
  return result(`${w}×${h} px at game size, class ${size} (${lo}–${hi})`, problems);
}

/**
 * Its signature colours (the card's / HUD's accent pair) do not read as another titan's. Titans made with the kit are held
 * tighter: their main accent must also stand apart from every other titan's two colours.
 */
export function checkPalette(id: TitanId): CheckResult {
  const e = rosterEntry(id)!;
  return checkPaletteOf(id, [e.site.accent, e.site.accent2], e.kit);
}

/** `checkPalette` on an accent pair (the titan builder runs it live on an unsaved definition). */
export function checkPaletteOf(id: string, mine: readonly [string, string], kit: boolean): CheckResult {
  const problems: string[] = [];
  let nearest = { id: '', d: Infinity };
  for (const o of ROSTER) {
    if (o.id === id) continue;
    const theirs: [string, string] = [o.site.accent, o.site.accent2];
    if (signaturesClash(mine, theirs))
      problems.push(`its accent pair reads as ${o.id}'s (${theirs.join(' / ')})`);
    for (const c of theirs) {
      const d = deltaE(mine[0], c);
      if (d < nearest.d) nearest = { id: o.id, d };
      if (kit && d < CLASH_DE)
        problems.push(`its accent ${mine[0]} is too close to ${o.id}'s ${c} (ΔE ${d.toFixed(3)})`);
    }
  }
  return result(
    `accent ${mine.join(' / ')}; nearest other colour: ${nearest.id} (ΔE ${nearest.d.toFixed(3)})`,
    problems,
  );
}

/**
 * The AI can use every move: each attack (every slot but Guard and Surge, and not a follow-up-only move) has, for every
 * aim, a modelled reach with hitboxes, energy and a hit window (src/ai/moves.ts), so the utility AI can choose it; and every
 * slot is either bound to a move or declared unbound.
 */
export function checkAiCoverage(id: TitanId): CheckResult {
  const def = getTitanDef(id);
  const infos = buildMoveInfos(def);
  const problems: string[] = [];
  let modelled = 0;
  for (const m of def.moves) {
    if (m.slot === 'guard' || m.slot === 'surge' || m.extra?.['followUpOnly']) continue;
    for (const mi of infos.filter((x) => x.def.id === m.id)) {
      if (!mi.hasHitboxes || !(mi.energy > 0) || !(mi.hitTo > mi.hitFrom))
        problems.push(`${m.id} (${mi.aim}): the AI has no model of where it hits`);
      else modelled++;
    }
  }
  for (const slot of MOVE_SLOTS)
    if (!def.moves.some((m) => m.slot === slot) && !def.unboundSlots?.includes(slot))
      problems.push(`no move in slot ${slot}`);
  return result(`${modelled} attack variants modelled`, problems);
}

/** An AI-vs-AI fight on the real matter world, `ticks` long from the first live tick; returns the state hashes. */
export function aiFight(
  a: TitanId,
  b: TitanId,
  seed: number,
  ticks: number,
  level: Difficulty = 4,
): { hash: number; world: number; events: number } {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'aivai',
    footwork: 'orbit',
    infinite: true,
    slots: [
      { titan: a, controller: 'ai', aiLevel: level },
      { titan: b, controller: 'ai', aiLevel: level },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: (s) => createMatterWorld(s),
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  m.setSources(
    createAiSource(m, 0, createAI(level, getTitanDef(a), seed * 7 + 1, { footwork: 'orbit' })),
    createAiSource(m, 1, createAI(level, getTitanDef(b), seed * 7 + 2, { footwork: 'orbit' })),
  );
  let guard = 0;
  while (m.phase === 'intro' && guard++ < 1000) m.step();
  let events = 0;
  for (let i = 0; i < ticks; i++) {
    m.step();
    events += m.events.length;
  }
  return { hash: m.hash(), world: m.world.hash(), events };
}

/** A sparring partner for the replay check: the Asteroid (small and quick), or the Planet for the Asteroid itself. */
export const partnerOf = (id: TitanId): TitanId => (id === 'asteroid' ? 'planet' : 'asteroid');

/** The same seeded AI fight twice gives the same state, world and event count (the sim stays deterministic). */
export function checkReplay(id: TitanId, ticks = 420): CheckResult {
  const b = partnerOf(id);
  const one = aiFight(id, b, 31, ticks);
  const two = aiFight(id, b, 31, ticks);
  const problems: string[] = [];
  if (one.hash !== two.hash) problems.push(`state hash differs (${one.hash} vs ${two.hash})`);
  if (one.world !== two.world) problems.push(`world hash differs (${one.world} vs ${two.world})`);
  if (one.events !== two.events) problems.push(`event count differs (${one.events} vs ${two.events})`);
  return result(`vs ${b}, ${ticks} ticks twice: hash ${one.hash >>> 0}, ${one.events} events`, problems);
}

/** The balance band: a titan should win between 25 % and 75 % of its fights against the roster at one AI level. */
export const BALANCE_BAND: readonly [number, number] = [0.25, 0.75];

export interface SweepRow {
  foe: TitanId;
  /** Our side (0 = left). */
  side: 0 | 1;
  /** 1 win, 0 loss, 0.5 undecided (the tick cap). */
  score: number;
  rounds: string;
  seconds: number;
}

export interface Sweep {
  rows: SweepRow[];
  rate: number;
  /** How often the AI started each of the titan's moves over the whole sweep. */
  moves: Record<string, number>;
}

/**
 * The balance sweep: AI against AI at one level, the titan against every other roster titan from both sides (`perSide`
 * fights a side), on the real matter world. Slow (a few seconds a fight).
 */
export function balanceSweep(
  id: TitanId,
  level: Difficulty = 4,
  perSide = 1,
  onRow?: (r: SweepRow) => void,
): Sweep {
  const rows: SweepRow[] = [];
  const moves: Record<string, number> = Object.fromEntries(getTitanDef(id).moves.map((m) => [m.id, 0]));
  let seed = 41;
  for (const foe of ROSTER.map((r) => r.id)) {
    if (foe === id) continue;
    for (const side of [0, 1] as const)
      for (let k = 0; k < perSide; k++) {
        const [a, b] = side === 0 ? [id, foe] : [foe, id];
        const cfg: MatchConfig = {
          seed: seed++,
          stage: 'nursery',
          mode: 'aivai',
          footwork: 'orbit',
          slots: [
            { titan: a, controller: 'ai', aiLevel: level },
            { titan: b, controller: 'ai', aiLevel: level },
          ],
        };
        const m = createMatch(cfg, {
          createWorld: (s) => createMatterWorld(s),
          createFighter,
          getTitanDef,
          arena: DEFAULT_ARENA,
          lighting: DEFAULT_LIGHTING,
        });
        m.setSources(
          createAiSource(m, 0, createAI(level, getTitanDef(a), cfg.seed * 7 + 1, { footwork: 'orbit' })),
          createAiSource(m, 1, createAI(level, getTitanDef(b), cfg.seed * 7 + 2, { footwork: 'orbit' })),
        );
        let ticks = 0;
        const cap = 60 * 60 * 5;
        while (m.phase !== 'matchend' && ticks < cap) {
          m.step();
          ticks++;
          for (const e of m.events)
            if (e.t === 'move' && e.slot === side) moves[e.moveId] = (moves[e.moveId] ?? 0) + 1;
        }
        const row: SweepRow = {
          foe,
          side,
          score: m.winner === -1 ? 0.5 : m.winner === side ? 1 : 0,
          rounds: `${m.wins[side]}–${m.wins[side === 0 ? 1 : 0]}`,
          seconds: ticks / 60,
        };
        rows.push(row);
        onRow?.(row);
      }
  }
  const rate = rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length);
  return { rows, rate, moves };
}
