import { TITAN_IDS, type Difficulty, type StageId, type TitanId } from '@/contracts';
import type { KeyValueStore } from '@/input';

/**
 * The single-player tournament ladder (WJ approved order, 2026-10): one player climbs eight rungs of AI titans to the Mouth.
 *
 * - **우리's ladder** (the default pick): Asteroid, Planet, the Witness, Nexus, Black Hole, Supernova, then **the Last One**
 *   (sub-boss) and **the Mouth** (final boss, its boss variant).
 * - **Any other pick** fights the remaining titans in that same order, and **우리 is the sub-boss** at rung 7 ("the hunter
 *   comes for you"); then the Mouth. The Last One drops into the regular rungs (it is the last of them).
 * - **The Mouth's own ladder** (once unlocked): the seven in order (the Last One still the sub-boss), and **우리 is its final
 *   boss** (the thing they built to stop it).
 *
 * Pure logic + persistence only (no drawing): the tower screen is src/ui/screens/ladder.ts, the story lines
 * src/ui/ladderStory.ts.
 */

export const LADDER_RUNGS = 8;
/** The regular order (ids: 'lastone' = the Witness, 'colossus' = the Last One). */
export const LADDER_ORDER: readonly TitanId[] = [
  'asteroid',
  'planet',
  'lastone',
  'nexus',
  'blackhole',
  'supernova',
  'colossus',
];
/** 우리: the hero, and the sub-boss of everyone else's ladder. */
export const LADDER_HUNTER: TitanId = 'uri';
/** The final boss. */
export const LADDER_FINAL: TitanId = 'mouth';
/** The Mouth's own final boss (its rung 8 cannot be itself). */
export const MOUTH_LADDER_FINAL: TitanId = 'uri';

/** AI difficulty per rung (1–6): mid-level (3, Fighter) at rung 1, the top level (6, Titan) from rung 6. */
export const LADDER_AI: readonly Difficulty[] = [3, 3, 4, 4, 5, 6, 6, 6];

/**
 * Each opponent fights on a stage that suits it. A titan added to LADDER_ORDER brings its stage here too (a titan without
 * one fights at the Rim).
 */
export const LADDER_STAGE: Readonly<Partial<Record<TitanId, StageId>>> = {
  asteroid: 'shearfield', // rocks running in rivers
  planet: 'nursery', // a world among newborn suns
  lastone: 'rim', // the Witness watches from the edge of the galaxy
  nexus: 'quasar', // chains across the scarred black
  blackhole: 'tussenruimte', // the stillness between galaxies
  supernova: 'redgiant', // a dying sun
  colossus: 'mausoleum', // the Last One keeps watch over the fallen
  uri: 'rim', // the hunter comes in from the edge
  mouth: 'mausoleum', // its own arena (Gate 3A's test bed)
};

export type RungRole = 'fight' | 'subboss' | 'final';

export interface Rung {
  /** 1-based rung number (1 = the bottom of the tower). */
  n: number;
  foe: TitanId;
  role: RungRole;
  aiLevel: Difficulty;
  stage: StageId;
  /** The foe plays its boss variant (the Mouth as the final boss). */
  boss: boolean;
}

/** The eight rungs for a player's pick. */
export function ladderFor(player: TitanId): Rung[] {
  const pool = LADDER_ORDER.filter((id) => id !== player);
  // a player outside the regular seven (우리, the Mouth) meets all seven: the Last One is then the sub-boss
  const full = pool.length === LADDER_ORDER.length;
  const regular = full ? pool.slice(0, -1) : pool;
  const sub = full ? pool[pool.length - 1]! : LADDER_HUNTER;
  const final = player === LADDER_FINAL ? MOUTH_LADDER_FINAL : LADDER_FINAL;
  const foes: [TitanId, RungRole][] = [
    ...regular.map((id): [TitanId, RungRole] => [id, 'fight']),
    [sub, 'subboss'],
    [final, 'final'],
  ];
  return foes.map(([foe, role], i) => ({
    n: i + 1,
    foe,
    role,
    aiLevel: LADDER_AI[i]!,
    stage: LADDER_STAGE[foe] ?? 'rim',
    boss: role === 'final' && foe === LADDER_FINAL,
  }));
}

/** The titan a cleared ladder unlocks: the Mouth, when it was the final boss; null otherwise. */
export function unlockOnClear(player: TitanId): TitanId | null {
  const last = ladderFor(player)[LADDER_RUNGS - 1]!;
  return last.foe === LADDER_FINAL ? LADDER_FINAL : null;
}

/* ------------------------------------------------------------------------------------------------ *
 *  progress (localStorage, one versioned key)
 * ------------------------------------------------------------------------------------------------ */
export const LADDER_STORAGE_KEY = 'adeuk.ladder.v1';

export interface LadderRun {
  player: TitanId;
  /** The rung being fought, 1..8. */
  rung: number;
  /** Continues used on this run. */
  continues: number;
}

export interface LadderSave {
  run: LadderRun | null;
  /** Best rung reached per titan (1..8); 9 = the ladder cleared with it. */
  best: Partial<Record<TitanId, number>>;
}

export const CLEARED = LADDER_RUNGS + 1;

export const emptyLadder = (): LadderSave => ({ run: null, best: {} });

const isTitan = (v: unknown): v is TitanId => (TITAN_IDS as readonly unknown[]).includes(v);
const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

export function parseLadder(raw: string | null): LadderSave {
  const out = emptyLadder();
  if (!raw) return out;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!j || typeof j !== 'object') return out;
  const o = j as { run?: unknown; best?: unknown };
  if (o.run && typeof o.run === 'object') {
    const r = o.run as Record<string, unknown>;
    const rung = int(r.rung, 1, LADDER_RUNGS);
    if (isTitan(r.player) && rung !== null)
      out.run = { player: r.player, rung, continues: int(r.continues, 0, 1e6) ?? 0 };
  }
  if (o.best && typeof o.best === 'object') {
    for (const [k, v] of Object.entries(o.best as Record<string, unknown>)) {
      const n = int(v, 1, CLEARED);
      if (isTitan(k) && n !== null) out.best[k] = n;
    }
  }
  return out;
}

export function loadLadder(store: KeyValueStore | null): LadderSave {
  if (!store) return emptyLadder();
  try {
    return parseLadder(store.getItem(LADDER_STORAGE_KEY));
  } catch {
    return emptyLadder();
  }
}

export function saveLadder(store: KeyValueStore | null, s: LadderSave): void {
  if (!store) return;
  try {
    store.setItem(LADDER_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* blocked storage: the run lasts this session only */
  }
}

const bump = (s: LadderSave, id: TitanId, n: number): void => {
  s.best[id] = Math.max(s.best[id] ?? 0, n);
};

/** Start a fresh run for `player` at rung 1 (or `rung`, the dev flag), replacing any run in progress. */
export function startRun(s: LadderSave, player: TitanId, rung = 1): LadderRun {
  const r = { player, rung: Math.min(LADDER_RUNGS, Math.max(1, Math.round(rung))), continues: 0 };
  s.run = r;
  bump(s, player, r.rung);
  return r;
}

/** The current rung was won: climb (returns 'next'), or the ladder is cleared ('cleared': the run ends). */
export function recordWin(s: LadderSave): 'next' | 'cleared' | 'none' {
  const r = s.run;
  if (!r) return 'none';
  if (r.rung >= LADDER_RUNGS) {
    bump(s, r.player, CLEARED);
    s.run = null;
    return 'cleared';
  }
  r.rung++;
  bump(s, r.player, r.rung);
  return 'next';
}

/** The current rung was lost: the run stays on it (CONTINUE retries it). */
export function recordLoss(s: LadderSave): void {
  if (s.run) s.run.continues++;
}

export function abandonRun(s: LadderSave): void {
  s.run = null;
}
