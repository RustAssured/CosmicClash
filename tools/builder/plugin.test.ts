import { describe, expect, it } from 'vitest';
import { SIZE_CLASSES, TITAN_KINDS } from '@/contracts';
import { KINDS, SIZES } from './plugin';

describe('titan builder bridge', () => {
  it('accepts exactly the roster contract kinds and size classes', () => {
    expect(KINDS).toEqual([...TITAN_KINDS]);
    expect(SIZES).toEqual(Object.keys(SIZE_CLASSES));
  });
});
