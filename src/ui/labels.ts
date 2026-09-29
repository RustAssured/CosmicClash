import type { Difficulty, DifficultyLabel, DamageType, MatchMode } from '@/contracts';
import { REACTION_MS } from '@/contracts';
import type { Action } from '@/input';

export const DIFFICULTY_LABELS: readonly DifficultyLabel[] = [
  { level: 1, name: 'Novice', nameKo: '초보' },
  { level: 2, name: 'Apprentice', nameKo: '견습' },
  { level: 3, name: 'Fighter', nameKo: '투사' },
  { level: 4, name: 'Veteran', nameKo: '숙련' },
  { level: 5, name: 'Expert', nameKo: '달인' },
  { level: 6, name: 'Titan', nameKo: '거인' },
];

export const difficultyNote = (level: Difficulty): string => {
  const ms = REACTION_MS[level];
  const notes: Record<Difficulty, string> = {
    1: 'Slow to react, forgiving spacing.',
    2: 'Reacts to big windups; misses feints.',
    3: 'A fair fight: spaces well, punishes recovery.',
    4: 'Reads your habits, mixes up its timing.',
    5: 'Fast reactions and clean punishes.',
    6: 'Every read the AI can make, at the limit of reaction.',
  };
  return `${notes[level]} Reaction ${ms} ms.`;
};

export const MODE_LABELS: Record<
  Exclude<MatchMode, 'attract' | 'aivai'>,
  { en: string; ko: string; note: string }
> = {
  versus: { en: 'VERSUS', ko: '대전', note: 'Two players, one screen. Best of three.' },
  vsai: { en: 'VS AI', ko: '인공지능', note: 'Fight a titan-mind. Best of three.' },
  training: {
    en: 'TRAINING',
    ko: '연습',
    note: 'Frame data, hitboxes and matter overlays. No clock, no KO.',
  },
};

/** One-line plain-language description of each damage type, for the select screen. */
export const DAMAGE_BLURB: Record<DamageType, { name: string; text: string }> = {
  FRACTURE: { name: 'FRACTURE', text: 'Shears along the weakest bonds; chunks tumble off.' },
  ASSIMILATION: { name: 'ASSIMILATION', text: 'Converts cells to its own lattice, then harvests them.' },
  TIDAL: { name: 'TIDAL', text: 'Tears loose matter into streams and swallows it.' },
  THERMAL: { name: 'THERMAL', text: 'Heat spreads; what ignites burns to ash and embers.' },
  CRUSH: { name: 'CRUSH', text: 'Compresses and cracks: craters, shock rings, faults.' },
  KINETIC: { name: 'KINETIC', text: 'Ballistic impacts, ejecta and shrapnel that bursts later.' },
};

export const ACTION_TEXT: Record<Action, { en: string; ko: string }> = {
  strike: { en: 'STRIKE', ko: '타격' },
  crush: { en: 'CRUSH', ko: '분쇄' },
  surge: { en: 'SURGE', ko: '쇄도' },
  signature: { en: 'SIGNATURE', ko: '고유기' },
  ultimate: { en: 'ULTIMATE', ko: '궁극기' },
  guard: { en: 'GUARD', ko: '방어' },
  feint: { en: 'FEINT', ko: '취소' },
  pause: { en: 'PAUSE', ko: '일시정지' },
  training: { en: 'TRAINING', ko: '연습' },
};

export const ATTRIBUTE_LABELS: readonly {
  key: 'mass' | 'cohesion' | 'heat' | 'gravity' | 'reach' | 'tempo';
  en: string;
  ko: string;
}[] = [
  { key: 'mass', en: 'MASS', ko: '질량' },
  { key: 'cohesion', en: 'COHESION', ko: '결속' },
  { key: 'heat', en: 'HEAT', ko: '내열' },
  { key: 'gravity', en: 'GRAVITY', ko: '중력' },
  { key: 'reach', en: 'REACH', ko: '사거리' },
  { key: 'tempo', en: 'TEMPO', ko: '속도' },
];
