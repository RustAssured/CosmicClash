import { describe, expect, it } from 'vitest';
import {
  GLYPH_CIRCLE,
  GLYPH_CROSS,
  backButton,
  confirmButton,
  padButtonLabel,
  resolveFamily,
} from './labels';
import { computeAutoAssignment } from './assign';
import { Pad } from './types';

describe('labels', () => {
  it('Nintendo labels sit at Nintendo positions: A right, B bottom, X top, Y left', () => {
    expect(padButtonLabel('nintendo', Pad.EAST)).toBe('A');
    expect(padButtonLabel('nintendo', Pad.SOUTH)).toBe('B');
    expect(padButtonLabel('nintendo', Pad.NORTH)).toBe('X');
    expect(padButtonLabel('nintendo', Pad.WEST)).toBe('Y');
    expect(padButtonLabel('nintendo', Pad.R2)).toBe('ZR');
    expect(padButtonLabel('nintendo', Pad.START)).toBe('+');
    expect(padButtonLabel('nintendo', Pad.SELECT)).toBe('−');
  });
  it('Xbox and PlayStation label the same positions differently', () => {
    expect(padButtonLabel('xbox', Pad.SOUTH)).toBe('A');
    expect(padButtonLabel('xbox', Pad.WEST)).toBe('X');
    expect(padButtonLabel('playstation', Pad.SOUTH)).toBe(GLYPH_CROSS);
    expect(padButtonLabel('playstation', Pad.EAST)).toBe(GLYPH_CIRCLE);
  });
  it('positional confirm is the bottom button everywhere; label confirm follows the printed A/Cross', () => {
    for (const f of ['nintendo', 'xbox', 'playstation'] as const) {
      expect(confirmButton(f, 'positional')).toBe(Pad.SOUTH);
      expect(backButton(f, 'positional')).toBe(Pad.EAST);
    }
    expect(confirmButton('nintendo', 'label')).toBe(Pad.EAST); // Nintendo A
    expect(backButton('nintendo', 'label')).toBe(Pad.SOUTH); // Nintendo B
    expect(confirmButton('xbox', 'label')).toBe(Pad.SOUTH); // Xbox A
    expect(confirmButton('playstation', 'label')).toBe(Pad.SOUTH); // Cross
  });
  it('label mode overrides the device family; auto follows it', () => {
    expect(resolveFamily('auto', 'xbox')).toBe('xbox');
    expect(resolveFamily('nintendo', 'xbox')).toBe('nintendo');
    expect(resolveFamily('auto', null)).toBe('nintendo');
  });
});

describe('computeAutoAssignment', () => {
  it('no pads: P1 WASD, P2 arrows', () => {
    expect(computeAutoAssignment([], [null, null])).toEqual(['kb1', 'kb2']);
  });
  it('first connected pad is P1, then the second pad, else keyboards fill in', () => {
    expect(computeAutoAssignment(['pad:0'], [null, null])).toEqual(['pad:0', 'kb1']);
    expect(computeAutoAssignment(['pad:2', 'pad:0'], [null, null])).toEqual(['pad:2', 'pad:0']);
  });
  it('respects a manual slot and does not hand its device to the other slot', () => {
    expect(computeAutoAssignment(['pad:0'], ['kb1', null])).toEqual(['kb1', 'pad:0']);
    expect(computeAutoAssignment(['pad:0'], [null, 'pad:0'])).toEqual(['kb1', 'pad:0']);
  });
});
