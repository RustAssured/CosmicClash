import { describe, expect, it } from 'vitest';
import { hex } from '@/contracts';
import { NEBULA_PERIOD, cosmicWordmark } from './cosmicLogo';

describe('COSMIC CLASH wordmark (nebula)', () => {
  it('loops seamlessly: a frame one period later is the same frame', () => {
    for (const t of [0, 1.3, 5.75]) {
      const a = cosmicWordmark('nebula', t).pixels;
      const b = cosmicWordmark('nebula', t + NEBULA_PERIOD).pixels;
      let diff = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
      expect(diff).toBe(0);
    }
  });

  it('has sparse celadon veins that move: present, a small share of the letters, different from frame to frame', () => {
    const celadon = new Set([hex('#f4fbf7'), hex('#d6e8de'), hex('#a8bdb2'), hex('#7c9c94')]);
    const veins = (t: number): number[] => {
      const p = cosmicWordmark('nebula', t).pixels;
      const out: number[] = [];
      for (let i = 0; i < p.length; i++) if (celadon.has(p[i]!)) out.push(i);
      return out;
    };
    const opaque = Array.from(cosmicWordmark('nebula', 0).pixels).filter((c) => c >>> 24 === 255).length;
    const a = veins(0);
    const b = veins(NEBULA_PERIOD / 4);
    expect(a.length).toBeGreaterThan(20);
    expect(a.length / opaque).toBeLessThan(0.12);
    expect(a.join()).not.toBe(b.join());
  });
});
