/**
 * `SimEvent { t: 'cue' }` ids are free-form strings owned by each titan ('tendril-sever', 'node-dark', 'moon-lost', 'disk-shed'…).
 * Voices react to the KIND of cue by keyword, so a cue id documented later, or one this file has never seen, still lands on
 * something sensible: `cueKind` finds the first keyword the id contains.
 */
export const CUE_KINDS = [
  'sever',
  'dark',
  'lost',
  'shed',
  'break',
  'boil',
  'strip',
  'collapse',
  'harvest',
  'swarm',
  'merge',
] as const;
export type CueKind = (typeof CUE_KINDS)[number];

export function cueKind(id: string): CueKind | null {
  const s = id.toLowerCase();
  for (const k of CUE_KINDS) if (s.includes(k)) return k;
  return null;
}
