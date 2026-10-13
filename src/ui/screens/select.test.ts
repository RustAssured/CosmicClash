import { describe, expect, it } from 'vitest';
import { LOGICAL_W } from '@/contracts';
import { gridOf, gridStep } from './select';

/** The middle column between the side panels (8 + 214 wide each) and the panels' height (44 → 322). */
const COL = { x0: 8 + 214, x1: LOGICAL_W - 8 - 214, y0: 44, y1: 44 + 278 };

describe('titan select grid', () => {
  for (let n = 1; n <= 16; n++)
    it(`${n} titans: tiles, names and prompt stay in the middle column without overlapping`, () => {
      const g = gridOf(n);
      const tiles = Array.from({ length: n }, (_, i) => g.pos(i));
      for (const { x, y } of tiles) {
        // the cursor's corners reach 2-3 px outside a tile
        expect(x - 3).toBeGreaterThanOrEqual(COL.x0);
        expect(x + g.tile + 3).toBeLessThanOrEqual(COL.x1);
        expect(y).toBeGreaterThanOrEqual(COL.y0);
      }
      // each tile's name row (14 px, the Hangeul face) ends before the next row's tiles and before the prompt
      for (let i = 0; i < n; i++) {
        const below = tiles[i]!.y + g.tile + 14;
        if (i + g.cols < n) expect(below).toBeLessThanOrEqual(tiles[i + g.cols]!.y);
        expect(below).toBeLessThanOrEqual(g.promptY);
      }
      expect(g.promptY + 10 + (g.glossY !== null ? 15 : 0)).toBeLessThanOrEqual(COL.y1);
      if (g.glossY !== null) expect(g.glossY).toBeGreaterThanOrEqual(g.promptY + 10);
      if (n <= 12) expect(g.glossY).not.toBeNull();
    });

  it('moves between rows to the nearest tile (a centred short last row)', () => {
    // ten titans: 4 + 4 + 2 (the pair centred under the middle two)
    expect(gridOf(10).cols).toBe(4);
    expect(gridStep(10, 5, 1)).toBe(8);
    expect(gridStep(10, 6, 1)).toBe(9);
    expect(gridStep(10, 9, -1)).toBe(6);
    expect(gridStep(10, 0, -1)).toBe(0);
    expect(gridStep(10, 8, 1)).toBe(8);
    // nine: the original 3 × 3, straight down
    expect(gridStep(9, 1, 1)).toBe(4);
    expect(gridStep(9, 7, 1)).toBe(7);
  });
});
