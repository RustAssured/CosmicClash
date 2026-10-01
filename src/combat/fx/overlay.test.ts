import { describe, expect, it } from 'vitest';
import { Overlay } from './overlay';

describe('Overlay bulk write (proposal 121)', () => {
  it('a pen writing the arrays directly and marking its rect gets the same visibility, dirty rect and clearing as set()', () => {
    const ov = new Overlay('t', 0, 32, 32, 'normal', true);
    ov.begin(100, 100);
    // world (100,100) is layer-local (16,16)
    const i = 16 * ov.w + 16;
    ov.pixels[i] = 0xff00ff00;
    ov.emissiveBuf![i] = 90;
    ov.markRect(16, 16, 17, 17);
    ov.end();
    expect(ov.layer.visible).toBe(true);
    expect(ov.get(100, 100)).toBe(0xff00ff00);
    expect(ov.layer.dirty).toEqual({ x0: 16, y0: 16, x1: 17, y1: 17 });
    // the next frame clears what was drawn
    ov.begin(100, 100);
    expect(ov.get(100, 100)).toBe(0);
    expect(ov.emissiveBuf![i]).toBe(0);
    ov.end();
    expect(ov.layer.visible).toBe(false);
  });

  it('markRect clips to the layer and ignores empty rects', () => {
    const ov = new Overlay('t', 0, 16, 16);
    ov.begin(0, 0);
    ov.markRect(5, 5, 5, 9);
    ov.end();
    expect(ov.layer.visible).toBe(false);
    ov.begin(0, 0);
    ov.markRect(-4, -4, 40, 3);
    ov.end();
    expect(ov.layer.dirty).toEqual({ x0: 0, y0: 0, x1: 16, y1: 3 });
  });
});
