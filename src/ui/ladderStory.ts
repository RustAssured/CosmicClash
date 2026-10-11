import type { TitanId } from '@/contracts';
import type { Rung } from './ladder';

/**
 * The tournament's story cards: one line before each rung, in the trailer's voice ("Once there were two worlds." / "Then
 * something looked at them." / "Then something came to eat." / "They did not run. They built." / "우리 / WE." / "Now it
 * hunts."). WJ: edit the lines here; nothing else depends on their wording or length (the card wraps up to two lines at
 * double size, then falls back to the body size).
 *
 * `tone` picks the colour the trailer used: 'white' for the story, 'gold' for the eye and the builders, 'red' for the Mouth.
 */
export type StoryTone = 'white' | 'gold' | 'red';

export interface StoryCard {
  text: string;
  tone: StoryTone;
}

/** A regular rung: the line belongs to the opponent. */
export const RUNG_LINES: Readonly<Partial<Record<TitanId, StoryCard>>> = {
  asteroid: { text: 'First, the stones.', tone: 'white' },
  planet: { text: 'Then a world that would not move.', tone: 'white' },
  lastone: { text: 'Then something looked at you.', tone: 'gold' },
  nexus: { text: 'Then the chains closed.', tone: 'white' },
  blackhole: { text: 'Then even the light fell in.', tone: 'white' },
  supernova: { text: 'Then a star chose to burn.', tone: 'white' },
  colossus: { text: 'Then the Last One opened its eye.', tone: 'gold' },
};

/** Rung 7, the sub-boss. */
export const SUBBOSS_LINES: Readonly<Partial<Record<TitanId, StoryCard>>> = {
  // the Last One (우리's ladder, the Mouth's ladder)
  colossus: { text: 'One is left. It has watched every world end.', tone: 'gold' },
  // 우리 (everyone else's ladder): "the hunter comes for you"
  uri: { text: 'They built a hunter. Now it hunts you.', tone: 'gold' },
};

/** Rung 8, the final boss. */
export const FINAL_LINES: Readonly<Partial<Record<TitanId, StoryCard>>> = {
  mouth: { text: 'Then something came to eat. It is still hungry.', tone: 'red' },
  // the Mouth's own ladder ends at 우리
  uri: { text: 'They did not run. They built. 우리 / WE.', tone: 'gold' },
};

const FALLBACK: StoryCard = { text: 'Then another came.', tone: 'white' };

export function storyCard(rung: Rung): StoryCard {
  const table = rung.role === 'final' ? FINAL_LINES : rung.role === 'subboss' ? SUBBOSS_LINES : RUNG_LINES;
  return table[rung.foe] ?? RUNG_LINES[rung.foe] ?? FALLBACK;
}

/** The ending card, line by line (beating the Mouth). */
export const ENDING_LINES: readonly StoryCard[] = [
  { text: 'The mouth is shut.', tone: 'white' },
  { text: 'Two worlds keep their lights.', tone: 'gold' },
];

/** The ending when the Mouth climbs its own ladder and eats 우리. */
export const MOUTH_ENDING_LINES: readonly StoryCard[] = [
  { text: 'They built. It ate.', tone: 'red' },
  { text: 'Now nothing hunts.', tone: 'white' },
];
