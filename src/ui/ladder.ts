import {
  NEW_TITAN_DAYS,
  STAGE_IDS,
  TITAN_IDS,
  type Difficulty,
  type StageId,
  type TitanId,
} from '@/contracts';
import type { KeyValueStore } from '@/input';

/**
 * The single-player tournament (WJ approved, 2026-10). Under TOURNAMENT the player picks a MODE, then a DIFFICULTY, then a
 * titan.
 *
 * **CLASSIC / 클래식**: WJ's curated ladder, nine rungs.
 * - **우리's ladder** (the default pick): Asteroid, Planet, the Witness, Nexus, Black Hole, Supernova, the Cradle, then **the
 *   Last One** (sub-boss) and **the Mouth** (final boss).
 * - **Any other pick** fights the remaining titans in that same order, and **우리 is the sub-boss** ("the hunter comes for
 *   you"); then the Mouth. The Last One drops into the regular rungs (the last of them).
 * - **The Mouth's own ladder** (once unlocked): the eight in order (the Last One still the sub-boss), and **우리 is its final
 *   boss** (the thing they built to stop it).
 *
 * **COSMIC CLASH / 우주 대결**: the living mode. Every shipped (non-WIP) roster titan, with no code edits when one ships:
 * the light titans first (tier 1, by tier then catalogue number), then the rest in a shuffle seeded per run (stored with the
 * run, so it is reproducible and resumes exactly), then the Last One and the Mouth, always the final two (the same
 * substitutions as CLASSIC when the player is one of them).
 *
 * **DIFFICULTY / 난이도** (both modes) sets the AI level across the rungs: EASY tops out at the middle level, NORMAL is the
 * original ramp (3, 3, 4, 4, 5, 6, 6, 6) stretched to the ladder's length, TITAN starts high and stays at the top. The boss
 * Mouth (double health, enraged last ring) is the final boss on NORMAL and TITAN; EASY meets the normal Mouth.
 *
 * Pure logic + persistence only (no drawing): the screens are src/ui/screens/tourney.ts (mode, difficulty) and ladder.ts
 * (tower, cards, ending); the story lines src/ui/ladderStory.ts.
 */

export type LadderMode = 'classic' | 'cosmic';
export type LadderDifficulty = 'easy' | 'normal' | 'titan';
export const LADDER_MODES: readonly LadderMode[] = ['classic', 'cosmic'];
export const LADDER_DIFFICULTIES: readonly LadderDifficulty[] = ['easy', 'normal', 'titan'];

/** What the tournament knows of a roster titan (the app passes `ladderRoster()` from src/titans/roster.ts). */
export interface LadderTitan {
  id: TitanId;
  /** 1 (light, an opener) … 5 (the Last One). */
  tier: number;
  /** Its home stage (a StageId), used when LADDER_STAGE has none for it. */
  stage?: string;
  /** YYYY-MM-DD: the NEW tag for `NEW_TITAN_DAYS`. */
  shippedAt?: string;
  catalogue?: number;
  wip?: boolean;
}

/** CLASSIC's regular order (ids: 'lastone' = the Witness, 'colossus' = the Last One). */
export const LADDER_ORDER: readonly TitanId[] = [
  'asteroid',
  'planet',
  'lastone',
  'nexus',
  'blackhole',
  'supernova',
  'cradle',
  'colossus',
];
/** CLASSIC's length: the regulars, the sub-boss and the final boss. */
export const LADDER_RUNGS = LADDER_ORDER.length + 1;
/** 우리: the hero, and the sub-boss of everyone else's ladder. */
export const LADDER_HUNTER: TitanId = 'uri';
/** The sub-boss when the player is not the Last One. */
export const LADDER_SUBBOSS: TitanId = 'colossus';
/** The final boss. */
export const LADDER_FINAL: TitanId = 'mouth';
/** The Mouth's own final boss (its last rung cannot be itself). */
export const MOUTH_LADDER_FINAL: TitanId = 'uri';

/**
 * AI level per rung (1–6) on an eight-rung ladder, per difficulty; `aiRamp` stretches it to any length. NORMAL is the
 * original: mid-level (3, Fighter) at rung 1, the top level (6, Titan) from rung 6.
 */
export const AI_RAMPS: Readonly<Record<LadderDifficulty, readonly Difficulty[]>> = {
  easy: [1, 1, 2, 2, 2, 3, 3, 3],
  normal: [3, 3, 4, 4, 5, 6, 6, 6],
  titan: [5, 6, 6, 6, 6, 6, 6, 6],
};
/** The NORMAL ramp at CLASSIC's old eight rungs (kept for the tools that read it). */
export const LADDER_AI: readonly Difficulty[] = AI_RAMPS.normal;

/** A difficulty's AI levels for a ladder of `n` rungs: its eight-step ramp, stretched (nearest step) to fit. */
export function aiRamp(difficulty: LadderDifficulty, n: number): Difficulty[] {
  const base = AI_RAMPS[difficulty];
  const last = base.length - 1;
  // TITAN: one rung just below the top, then the top for the rest, however long the ladder
  if (difficulty === 'titan') return Array.from({ length: n }, (_, i) => base[Math.min(i, last)]!);
  return Array.from({ length: n }, (_, i) => base[n <= 1 ? last : Math.round((i * last) / (n - 1))]!);
}

/**
 * Each opponent fights on a stage that suits it. A titan without an entry fights on its own home stage (`LadderTitan.stage`,
 * a kit titan's `kit.stage`), else at the Rim.
 */
export const LADDER_STAGE: Readonly<Partial<Record<TitanId, StageId>>> = {
  asteroid: 'shearfield', // rocks running in rivers
  planet: 'nursery', // a world among newborn suns
  lastone: 'rim', // the Witness watches from the edge of the galaxy
  nexus: 'quasar', // chains across the scarred black
  blackhole: 'tussenruimte', // the stillness between galaxies
  supernova: 'redgiant', // a dying sun
  cradle: 'nursery', // where suns are born, something prepares
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
  /** The foe plays its boss variant (the Mouth as the final boss, NORMAL and TITAN). */
  boss: boolean;
}

/** Which ladder: the mode, the difficulty, and for COSMIC CLASH the roster and the run's seed. */
export interface LadderSpec {
  mode?: LadderMode;
  difficulty?: LadderDifficulty;
  /** COSMIC CLASH: the roster it draws from (every non-WIP titan in it). */
  roster?: readonly LadderTitan[];
  /** COSMIC CLASH: the shuffle's seed. */
  seed?: number;
}

const isStage = (s: string | undefined): s is StageId => !!s && (STAGE_IDS as readonly string[]).includes(s);

/** CLASSIC's foes for a pick, in order, with their roles. */
export function classicFoes(player: TitanId): TitanId[] {
  const pool = LADDER_ORDER.filter((id) => id !== player);
  // a player outside the regulars (우리, the Mouth) meets them all: the Last One is then the sub-boss
  const full = pool.length === LADDER_ORDER.length;
  const regular = full ? pool.slice(0, -1) : pool;
  const sub = full ? pool[pool.length - 1]! : LADDER_HUNTER;
  const final = player === LADDER_FINAL ? MOUTH_LADDER_FINAL : LADDER_FINAL;
  return [...regular, sub, final];
}

/** mulberry32: a small, fast, seeded PRNG (0..1). */
function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * COSMIC CLASH's foes for a pick: the light titans (tier 1) first, then a shuffle of the rest seeded by `seed`, then the
 * sub-boss (the Last One; 우리 when the player is the Last One) and the final boss (the Mouth; 우리 for the Mouth itself).
 * Work-in-progress titans never appear. The shuffle starts from catalogue order, so the roster's own order does not matter.
 */
export function cosmicFoes(player: TitanId, roster: readonly LadderTitan[], seed: number): TitanId[] {
  const shipped = roster.filter((t) => !t.wip && t.id !== player && t.id !== LADDER_FINAL);
  const has = (id: TitanId): boolean => shipped.some((t) => t.id === id);
  const sub = player === LADDER_SUBBOSS || !has(LADDER_SUBBOSS) ? LADDER_HUNTER : LADDER_SUBBOSS;
  const final = player === LADDER_FINAL ? MOUTH_LADDER_FINAL : LADDER_FINAL;
  const rest = shipped
    .filter((t) => t.id !== sub && t.id !== final)
    .sort((a, b) => a.tier - b.tier || (a.catalogue ?? 999) - (b.catalogue ?? 999) || (a.id < b.id ? -1 : 1));
  const openers = rest.filter((t) => t.tier <= 1).map((t) => t.id);
  const middle = rest
    .filter((t) => t.tier > 1)
    .sort((a, b) => (a.catalogue ?? 999) - (b.catalogue ?? 999) || (a.id < b.id ? -1 : 1))
    .map((t) => t.id);
  const r = rng(seed);
  for (let i = middle.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [middle[i], middle[j]] = [middle[j]!, middle[i]!];
  }
  return [...openers, ...middle, sub, final];
}

/** Rungs from a foe list (the last two are the sub-boss and the final boss) at a difficulty. */
export function rungsOf(
  foes: readonly TitanId[],
  difficulty: LadderDifficulty = 'normal',
  roster: readonly LadderTitan[] = [],
): Rung[] {
  const ai = aiRamp(difficulty, foes.length);
  return foes.map((foe, i) => {
    const role: RungRole = i === foes.length - 1 ? 'final' : i === foes.length - 2 ? 'subboss' : 'fight';
    const home = roster.find((t) => t.id === foe)?.stage;
    return {
      n: i + 1,
      foe,
      role,
      aiLevel: ai[i]!,
      stage: LADDER_STAGE[foe] ?? (isStage(home) ? home : 'rim'),
      boss: role === 'final' && foe === LADDER_FINAL && difficulty !== 'easy',
    };
  });
}

/** The ladder for a player's pick (CLASSIC NORMAL unless the spec says otherwise). */
export function ladderFor(player: TitanId, spec: LadderSpec = {}): Rung[] {
  const mode = spec.mode ?? 'classic';
  const foes =
    mode === 'classic' ? classicFoes(player) : cosmicFoes(player, spec.roster ?? [], spec.seed ?? 1);
  return rungsOf(foes, spec.difficulty ?? 'normal', spec.roster);
}

/** The titan a cleared ladder unlocks: the Mouth, when it was the final boss (either mode, any difficulty); else null. */
export function unlockOnClear(player: TitanId, spec: LadderSpec = {}): TitanId | null {
  const l = ladderFor(player, spec);
  return l[l.length - 1]!.foe === LADDER_FINAL ? LADDER_FINAL : null;
}

/** Shipped within `NEW_TITAN_DAYS` of `todayMs` (epoch ms): the NEW tag in the COSMIC CLASH lineup. */
export function isNewTitan(t: LadderTitan | undefined, todayMs: number): boolean {
  if (!t?.shippedAt || t.wip) return false;
  const at = Date.parse(`${t.shippedAt}T00:00:00Z`);
  if (!Number.isFinite(at)) return false;
  const days = (todayMs - at) / 86_400_000;
  return days >= -1 && days < NEW_TITAN_DAYS;
}

/** How many titans COSMIC CLASH has (the live badge): every shipped roster titan. */
export const cosmicCount = (roster: readonly LadderTitan[]): number => roster.filter((t) => !t.wip).length;

/* ------------------------------------------------------------------------------------------------ *
 *  progress (localStorage, one versioned key; v1 is migrated)
 * ------------------------------------------------------------------------------------------------ */
export const LADDER_STORAGE_KEY = 'adeuk.ladder.v2';
/** The S12 save (one CLASSIC run, eight rungs): read once and migrated into v2. */
export const LADDER_V1_KEY = 'adeuk.ladder.v1';

export interface LadderRun {
  player: TitanId;
  /** The rung being fought, 1-based. */
  rung: number;
  /** Continues used on this run. */
  continues: number;
  /** COSMIC CLASH: the shuffle's seed. */
  seed: number;
  /** COSMIC CLASH: the lineup this run was dealt (so a titan shipped mid-run does not reshuffle it). */
  order?: TitanId[];
}

export type RunKey = `${LadderMode}:${LadderDifficulty}`;
export const runKey = (mode: LadderMode, difficulty: LadderDifficulty): RunKey => `${mode}:${difficulty}`;

export interface LadderSave {
  /** The run in progress per mode and difficulty. */
  runs: Partial<Record<RunKey, LadderRun>>;
  /** Best rung reached per titan per mode; `CLEARED` = the ladder cleared with it. */
  best: Record<LadderMode, Partial<Record<TitanId, number>>>;
  /** The mode and difficulty chosen last (the menu's default, the dev flag's). */
  last: { mode: LadderMode; difficulty: LadderDifficulty };
}

/** `best` value for a cleared ladder (any length). */
export const CLEARED = 99;
/** Longest ladder a save accepts (rung numbers above this are garbage). */
const MAX_RUNGS = 64;

export const emptyLadder = (): LadderSave => ({
  runs: {},
  best: { classic: {}, cosmic: {} },
  last: { mode: 'classic', difficulty: 'normal' },
});

const isTitan = (v: unknown): v is TitanId => (TITAN_IDS as readonly unknown[]).includes(v);
const isMode = (v: unknown): v is LadderMode => (LADDER_MODES as readonly unknown[]).includes(v);
const isDiff = (v: unknown): v is LadderDifficulty => (LADDER_DIFFICULTIES as readonly unknown[]).includes(v);
const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

function parseRun(v: unknown): LadderRun | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const rung = int(r.rung, 1, MAX_RUNGS);
  if (!isTitan(r.player) || rung === null) return null;
  const run: LadderRun = {
    player: r.player,
    rung,
    continues: int(r.continues, 0, 1e6) ?? 0,
    seed: int(r.seed, 0, 0xffffffff) ?? 1,
  };
  if (Array.isArray(r.order)) {
    if (r.order.length < 2 || r.order.length > MAX_RUNGS || !r.order.every(isTitan) || rung > r.order.length)
      return null;
    run.order = r.order;
  }
  return run;
}

function parseBest(v: unknown, out: Partial<Record<TitanId, number>>): void {
  if (!v || typeof v !== 'object') return;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const b = int(n, 1, CLEARED);
    if (isTitan(k) && b !== null) out[k] = b;
  }
}

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
  const o = j as { runs?: unknown; best?: unknown; last?: unknown };
  if (o.runs && typeof o.runs === 'object')
    for (const [k, v] of Object.entries(o.runs as Record<string, unknown>)) {
      const [m, d] = k.split(':');
      const run = parseRun(v);
      if (isMode(m) && isDiff(d) && run) {
        // a CLASSIC run is rebuilt from the current order: its rung must fit it
        if (m === 'classic' && run.rung > LADDER_RUNGS) continue;
        out.runs[runKey(m, d)] = run;
      }
    }
  if (o.best && typeof o.best === 'object') {
    const b = o.best as Record<string, unknown>;
    for (const m of LADDER_MODES) parseBest(b[m], out.best[m]);
  }
  if (o.last && typeof o.last === 'object') {
    const l = o.last as Record<string, unknown>;
    if (isMode(l.mode) && isDiff(l.difficulty)) out.last = { mode: l.mode, difficulty: l.difficulty };
  }
  return out;
}

/**
 * The S12 save (`adeuk.ladder.v1`: one eight-rung CLASSIC run, best rung per titan, 9 = cleared) as a v2 save: its run
 * becomes the CLASSIC NORMAL run and its bests CLASSIC's. The Cradle joined CLASSIC at rung 7, so a stored rung 7 or 8 (the
 * sub-boss, the Mouth) moves up one: the run stays at the same foe.
 */
export function migrateLadderV1(raw: string | null): LadderSave | null {
  if (!raw) return null;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as { run?: unknown; best?: unknown };
  const out = emptyLadder();
  const up = (n: number): number => (n >= 7 ? n + 1 : n);
  if (o.run && typeof o.run === 'object') {
    const r = o.run as Record<string, unknown>;
    const rung = int(r.rung, 1, 8);
    if (isTitan(r.player) && rung !== null)
      out.runs['classic:normal'] = {
        player: r.player,
        rung: up(rung),
        continues: int(r.continues, 0, 1e6) ?? 0,
        seed: 1,
      };
  }
  if (o.best && typeof o.best === 'object')
    for (const [k, v] of Object.entries(o.best as Record<string, unknown>)) {
      const n = int(v, 1, 9);
      if (isTitan(k) && n !== null) out.best.classic[k] = n === 9 ? CLEARED : up(n);
    }
  return out;
}

export function loadLadder(store: KeyValueStore | null): LadderSave {
  if (!store) return emptyLadder();
  try {
    const v2 = store.getItem(LADDER_STORAGE_KEY);
    if (v2) return parseLadder(v2);
    const migrated = migrateLadderV1(store.getItem(LADDER_V1_KEY));
    if (migrated) {
      saveLadder(store, migrated);
      return migrated;
    }
    return emptyLadder();
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

const bump = (s: LadderSave, mode: LadderMode, id: TitanId, n: number): void => {
  s.best[mode][id] = Math.max(s.best[mode][id] ?? 0, n);
};

/** The run in progress for a mode and difficulty (null: none). */
export const runOf = (s: LadderSave, mode: LadderMode, difficulty: LadderDifficulty): LadderRun | null =>
  s.runs[runKey(mode, difficulty)] ?? null;

/** The rungs of a stored run (CLASSIC from the current order, COSMIC CLASH from the lineup it was dealt). */
export function runRungs(
  run: LadderRun,
  mode: LadderMode,
  difficulty: LadderDifficulty,
  roster: readonly LadderTitan[] = [],
): Rung[] {
  if (mode === 'cosmic')
    return rungsOf(run.order ?? cosmicFoes(run.player, roster, run.seed), difficulty, roster);
  return ladderFor(run.player, { mode, difficulty });
}

/**
 * Start a fresh run for `player` at rung 1 (or `rung`, the dev flag), replacing that mode and difficulty's run in progress.
 * COSMIC CLASH deals its lineup now (from `roster` and `seed`) and stores it with the run.
 */
export function startRun(
  s: LadderSave,
  player: TitanId,
  opts: {
    mode?: LadderMode;
    difficulty?: LadderDifficulty;
    rung?: number;
    seed?: number;
    roster?: readonly LadderTitan[];
  } = {},
): LadderRun {
  const mode = opts.mode ?? 'classic';
  const difficulty = opts.difficulty ?? 'normal';
  const seed = (opts.seed ?? 1) >>> 0;
  const order = mode === 'cosmic' ? cosmicFoes(player, opts.roster ?? [], seed) : undefined;
  const n = order?.length ?? LADDER_RUNGS;
  const r: LadderRun = {
    player,
    rung: Math.min(n, Math.max(1, Math.round(opts.rung ?? 1))),
    continues: 0,
    seed,
    ...(order ? { order } : {}),
  };
  s.runs[runKey(mode, difficulty)] = r;
  s.last = { mode, difficulty };
  bump(s, mode, player, r.rung);
  return r;
}

/** The current rung was won: climb ('next'), or the ladder is cleared ('cleared': the run ends). */
export function recordWin(
  s: LadderSave,
  mode: LadderMode = 'classic',
  difficulty: LadderDifficulty = 'normal',
  roster: readonly LadderTitan[] = [],
): 'next' | 'cleared' | 'none' {
  const key = runKey(mode, difficulty);
  const r = s.runs[key];
  if (!r) return 'none';
  const n = runRungs(r, mode, difficulty, roster).length;
  if (r.rung >= n) {
    bump(s, mode, r.player, CLEARED);
    delete s.runs[key];
    return 'cleared';
  }
  r.rung++;
  bump(s, mode, r.player, r.rung);
  return 'next';
}

/** The current rung was lost: the run stays on it (CONTINUE retries it). */
export function recordLoss(
  s: LadderSave,
  mode: LadderMode = 'classic',
  difficulty: LadderDifficulty = 'normal',
): void {
  const r = s.runs[runKey(mode, difficulty)];
  if (r) r.continues++;
}

export function abandonRun(
  s: LadderSave,
  mode: LadderMode = 'classic',
  difficulty: LadderDifficulty = 'normal',
): void {
  delete s.runs[runKey(mode, difficulty)];
}

/** Labels for the menus (English / Korean). */
export const MODE_LABELS: Readonly<Record<LadderMode, { en: string; ko: string }>> = {
  classic: { en: 'CLASSIC', ko: '클래식' },
  cosmic: { en: 'COSMIC CLASH', ko: '우주 대결' },
};
export const DIFFICULTY_NAMES: Readonly<Record<LadderDifficulty, { en: string; ko: string }>> = {
  easy: { en: 'EASY', ko: '쉬움' },
  normal: { en: 'NORMAL', ko: '보통' },
  titan: { en: 'TITAN', ko: '타이탄' },
};
