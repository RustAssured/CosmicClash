import { describe, expect, it } from 'vitest';
import { decodeCells, encodeCells, type ImageBody } from './image';

describe('image painter cells', () => {
  it('round-trips materials and levels through body.json', () => {
    const mat = Uint8Array.from([0, 1, 2, 15, 3, 0]);
    const level = Uint8Array.from([0, 0, 7, 15, 9, 4]);
    const body: ImageBody = {
      version: 1,
      w: 3,
      h: 2,
      cells: encodeCells(mat, level),
      core: { x: 1, y: 0, r: 1 },
    };
    const d = decodeCells(body);
    expect([...d.mat]).toEqual([...mat]);
    // an empty cell stores no level
    expect([...d.level]).toEqual([0, 0, 7, 15, 9, 0]);
  });

  it('rejects a body whose cells do not fit its size', () => {
    const body: ImageBody = { version: 1, w: 4, h: 4, cells: btoa('xx'), core: { x: 1, y: 1, r: 1 } };
    expect(() => decodeCells(body)).toThrow(/cells/);
  });
});
