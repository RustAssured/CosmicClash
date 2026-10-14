import { describe, expect, it } from 'vitest';
import { fasin, fatan2, fcos, fsin } from './ftrig';

describe('ftrig (presentation trig)', () => {
  it('tracks Math within its stated error', () => {
    let es = 0;
    let ea = 0;
    let eas = 0;
    for (let i = 0; i < 20000; i++) {
      const x = (i / 20000 - 0.5) * 80;
      es = Math.max(es, Math.abs(fsin(x) - Math.sin(x)), Math.abs(fcos(x) - Math.cos(x)));
      const y = Math.sin(i * 0.37) * (1 + (i % 7));
      const z = Math.cos(i * 0.91) * (1 + (i % 5));
      ea = Math.max(ea, Math.abs(fatan2(y, z) - Math.atan2(y, z)));
      const u = (i / 20000) * 2 - 1;
      eas = Math.max(eas, Math.abs(fasin(u) - Math.asin(u)));
    }
    expect(es).toBeLessThan(1e-6);
    expect(ea).toBeLessThan(2e-5);
    expect(eas).toBeLessThan(2e-5);
    expect(fatan2(0, 0)).toBe(0);
    expect(fatan2(0, -1)).toBeCloseTo(Math.PI, 5);
    expect(fatan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 5);
  });
});
