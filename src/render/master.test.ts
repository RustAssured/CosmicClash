import { describe, expect, it } from 'vitest';
import {
  buildMasterPalette,
  masterPalette,
  masterSources,
  unifyStagePalette,
  MASTER_MAX,
  OUTLINE_COLOR,
  VFX_RAMPS,
} from './master';
import { preparePalette } from './palette';
import { STAGE_INFO } from '@/stages/info';

describe('master palette (shared/UNIFICATION.md §2)', () => {
  const m = masterPalette();

  it('is the union of the approved ramps, merged to 96–128 colours, every colour once', () => {
    expect(m.colors.length).toBeGreaterThanOrEqual(96);
    expect(m.colors.length).toBeLessThanOrEqual(MASTER_MAX);
    expect(new Set(m.colors).size).toBe(m.colors.length);
    expect(m.sourceCount).toBeGreaterThan(m.colors.length);
    expect(m.rampLengths.reduce((a, c) => a + c, 0)).toBe(m.colors.length);
    // usable by the dither LUT as is
    expect(() => preparePalette(m.colors, m.rampLengths)).not.toThrow();
  });

  it("keeps the locked titans' colours (우리's stone, the Mouth's flesh) all but exact", () => {
    // a locked colour only ever merges into a practically identical one
    expect(m.lockedShift).toBeLessThan(0.02);
    for (const h of ['#cfb79a', '#b3a8bd', '#ffd890', '#ffc480', '#e8866a', '#fbe8d6', '#ff8a40'])
      expect(m.colors).toContain(h);
    expect(m.ramps['uri.s1']).toHaveLength(11);
  });

  it('has every effect ramp and the outline colour (possibly merged into a twin)', () => {
    for (const name of ['vfx.flash', 'vfx.dust', 'vfx.rock', 'outline'])
      expect(m.ramps[name]!.length).toBeGreaterThan(0);
    expect(m.ramps['vfx.flash']!.length).toBeGreaterThanOrEqual(4);
    expect(VFX_RAMPS.flash).toHaveLength(6);
    expect(OUTLINE_COLOR).toBe('#040408');
  });

  it('the highlight ceiling: a non-glowing ramp top maps one step down; glowing tops and inner steps map to themselves', () => {
    const s1 = m.ramps['uri.s1']!;
    const top1 = s1[s1.length - 1]!;
    expect(m.ceiling[top1]).not.toBe(top1);
    // steps down to a colour that is not capped itself
    expect(m.ceiling[m.ceiling[top1]!]).toBe(m.ceiling[top1]);
    expect(m.ceiling[s1[3]!]).toBe(s1[3]);
    const civ = m.ramps['uri.civ']!;
    const top = civ[civ.length - 1]!;
    // a glowing top keeps itself unless a non-glowing ramp shares that exact colour as its own top
    const cappedElsewhere = masterSources().some(
      (s) => !s.glow && (m.ramps[s.name] ?? []).slice(-1)[0] === top && (m.ramps[s.name] ?? []).length > 1,
    );
    if (!cappedElsewhere) expect(m.ceiling[top]).toBe(top);
  });

  it('a smaller budget merges more, never by inventing colours', () => {
    const small = buildMasterPalette(masterSources(), 96);
    const all = new Set(masterSources().flatMap((s) => s.colors.map((c) => c.toLowerCase())));
    expect(small.colors.length).toBe(96);
    for (const c of small.colors) expect(all.has(c)).toBe(true);
  });

  it('pulls stage palettes toward the master while keeping each arena its own accents', () => {
    for (const info of Object.values(STAGE_INFO)) {
      const u = unifyStagePalette(info.palette);
      expect(u.colors).toHaveLength(info.palette.length);
      expect(u.snapped).toBeGreaterThan(0);
      expect(u.snapped).toBeLessThan(info.palette.length);
    }
  });
});
