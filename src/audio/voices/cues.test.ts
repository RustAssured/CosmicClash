import { describe, expect, it } from 'vitest';
import { CUE_KINDS, cueKind } from './cues';

describe('cueKind', () => {
  it('finds the keyword in ids of every shape the titans use', () => {
    expect(cueKind('tendril-sever')).toBe('sever');
    expect(cueKind('node-dark')).toBe('dark');
    expect(cueKind('moon-lost')).toBe('lost');
    expect(cueKind('disk-shed')).toBe('shed');
    expect(cueKind('crust_break')).toBe('break');
    expect(cueKind('OceanBoil')).toBe('boil');
    expect(cueKind('atmosphere-stripped')).toBe('strip');
    expect(cueKind('core-collapse')).toBe('collapse');
    expect(cueKind('lattice.harvest')).toBe('harvest');
    expect(cueKind('swarm')).toBe('swarm');
    expect(cueKind('node-merge')).toBe('merge');
  });
  it('recognises every exact id the four newer titans emit', () => {
    const emitted: [string, string][] = [
      ['layer-blow', 'blow'],
      ['crust-crack', 'crack'],
      ['fuel-burn', 'burn'],
      ['collapse', 'collapse'],
      ['moon-lost', 'lost'],
      ['atmo-strip', 'strip'],
      ['ocean-boil', 'boil'],
      ['node-dark', 'dark'],
      ['harvest', 'harvest'],
      ['chain-latch', 'latch'],
      ['disk-shed', 'shed'],
      ['consume', 'consume'],
      ['hawking', 'hawking'],
    ];
    for (const [id, kind] of emitted) expect(cueKind(id), id).toBe(kind);
  });
  it('returns null for an id it has never heard of, so voices fall back to something tasteful', () => {
    expect(cueKind('eye-exposed')).toBeNull();
    expect(cueKind('')).toBeNull();
    expect(cueKind('momentum')).toBeNull();
  });
  it('knows the eleven kinds the Lead documented and the six ids the newer titans added', () => {
    expect([...CUE_KINDS].sort()).toEqual(
      [
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
        'blow',
        'crack',
        'burn',
        'latch',
        'consume',
        'hawking',
      ].sort(),
    );
  });
});
