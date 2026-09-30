import { STAGE_IDS, TITAN_IDS, type Difficulty, type StageId, type TitanId } from '@/contracts';
import { browserStore, type KeyValueStore } from '@/input';

/** UI preferences. Volumes are integer steps 0..10. Stored under one versioned key; garbage and blocked storage are tolerated. */
export interface UISettings {
  master: number;
  music: number;
  sfx: number;
  quality: 0 | 1 | 2;
  lastP1: TitanId;
  lastP2: TitanId;
  lastStage: StageId;
  aiLevel: Difficulty;
  /** The HOW TO PLAY pages have been shown once (they open by themselves on the very first launch). */
  /** Comfort: camera shake and flash effects in quarter steps, 0..4 (4 = full). */
  shake: number;
  flash: number;
  seenHowTo: boolean;
  /** Matches started on this device: the in-match hint strip shows during the very first one. */
  matches: number;
}

export const UI_STORAGE_KEY = 'adeuk.ui.v1';

export const defaultUISettings = (): UISettings => ({
  master: 8,
  music: 7,
  sfx: 8,
  quality: 2,
  lastP1: 'lastone',
  lastP2: 'asteroid',
  lastStage: 'nursery',
  aiLevel: 3,
  shake: 4,
  flash: 4,
  seenHowTo: false,
  matches: 0,
});

const int = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;

export function parseUISettings(raw: string | null): UISettings {
  const d = defaultUISettings();
  if (!raw) return d;
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return d;
  }
  if (!j || typeof j !== 'object') return d;
  const o = j as Record<string, unknown>;
  return {
    master: int(o.master, 0, 10, d.master),
    music: int(o.music, 0, 10, d.music),
    sfx: int(o.sfx, 0, 10, d.sfx),
    quality: int(o.quality, 0, 2, d.quality) as 0 | 1 | 2,
    lastP1: (TITAN_IDS as readonly string[]).includes(o.lastP1 as string) ? (o.lastP1 as TitanId) : d.lastP1,
    lastP2: (TITAN_IDS as readonly string[]).includes(o.lastP2 as string) ? (o.lastP2 as TitanId) : d.lastP2,
    lastStage: (STAGE_IDS as readonly string[]).includes(o.lastStage as string)
      ? (o.lastStage as StageId)
      : d.lastStage,
    aiLevel: int(o.aiLevel, 1, 6, d.aiLevel) as Difficulty,
    shake: int(o.shake, 0, 4, d.shake),
    flash: int(o.flash, 0, 4, d.flash),
    seenHowTo: o.seenHowTo === true,
    matches: int(o.matches, 0, 100000, d.matches),
  };
}

export function loadUISettings(store: KeyValueStore | null): UISettings {
  if (!store) return defaultUISettings();
  try {
    return parseUISettings(store.getItem(UI_STORAGE_KEY));
  } catch {
    return defaultUISettings();
  }
}

export function saveUISettings(store: KeyValueStore | null, s: UISettings): void {
  if (!store) return;
  try {
    store.setItem(UI_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* blocked storage: preferences simply don't persist */
  }
}

export const resolveStore = (s: KeyValueStore | null | undefined): KeyValueStore | null =>
  s === undefined ? browserStore() : s;
