import { describe, expect, it } from 'vitest';
import { STAGE_IDS } from '@/contracts';
import { STAGE_INFO } from '@/stages/info';
import { TITAN_DEFS } from '@/titans';
import { DAMAGE_BLURB } from './labels';
import { BODY_GLYPHS, MICRO_GLYPHS } from './pixel/font-data';
import { measureText, wrapText } from './pixel/text';

/**
 * Every string the screens draw that comes from DATA (titan and stage definitions) must fit the box it is drawn in, in the
 * longest real case, with nothing cut off. The limits mirror the layout constants of `screens/select.ts`, `screens/stage.ts`
 * and `hud.ts`; a longer string in a definition fails here instead of being clipped on screen.
 */
const IDENTITY_W = 214 - 108 - 6; // the select panel's identity column
const TEXT_W = 214 - 24;
const micro = { font: 'micro' } as const;

describe('titan strings fit the select panel and the HUD', () => {
  for (const def of Object.values(TITAN_DEFS)) {
    it(`${def.id}`, () => {
      const dmg = DAMAGE_BLURB[def.destruction];
      expect(measureText(def.name.toUpperCase(), { tracking: 1 }), 'name').toBeLessThanOrEqual(IDENTITY_W);
      expect(measureText(def.nameKo), 'name (Hangeul)').toBeLessThanOrEqual(IDENTITY_W);
      expect(
        measureText(def.epithet.toUpperCase(), { font: 'micro', tracking: 1 }),
        'epithet',
      ).toBeLessThanOrEqual(IDENTITY_W);
      expect(
        measureText(def.resource.name.toUpperCase(), { font: 'micro', tracking: 1 }),
        'resource',
      ).toBeLessThanOrEqual(IDENTITY_W);
      expect(wrapText(def.ui.tagline, TEXT_W).length, 'tagline lines').toBeLessThanOrEqual(2);
      expect(wrapText(dmg.text, TEXT_W, micro).length, 'destruction text lines').toBeLessThanOrEqual(2);
      expect(
        measureText(`FAILURE  ${def.failureMode.name.toUpperCase()}`, { font: 'micro', tracking: 1 }),
        'failure name',
      ).toBeLessThanOrEqual(TEXT_W);
      expect(wrapText(def.failureMode.text, TEXT_W, micro).length, 'failure text lines').toBeLessThanOrEqual(
        5,
      );
      // the HUD name plate: the Latin name, a gap and the Hangeul name on one line
      expect(
        measureText(def.name.toUpperCase()) + 14 + measureText(def.nameKo),
        'HUD plate',
      ).toBeLessThanOrEqual(224 - 24);
    });
  }
});

describe('stage strings fit the stage card and the detail panel', () => {
  for (const id of STAGE_IDS) {
    it(id, () => {
      const st = STAGE_INFO[id];
      expect(measureText(st.name.toUpperCase()), 'card name').toBeLessThanOrEqual(120);
      expect(measureText(st.nameKo), 'card name (Hangeul)').toBeLessThanOrEqual(120);
      expect(wrapText(st.blurb, 330).length, 'blurb lines').toBeLessThanOrEqual(3);
      // (the detail title falls back from double to single size when it would run into the palette: it must fit at single size)
      expect(
        measureText(st.name.toUpperCase(), { tracking: 2 }) + 14 + measureText(st.nameKo),
        'detail title',
      ).toBeLessThanOrEqual(360);
    });
  }
});

describe('the micro face has a glyph for every character the data strings use in it', () => {
  it('destruction blurbs, failure texts and epithets (a missing glyph drew a stray letter: ";" showed as "o")', () => {
    const texts: string[] = [];
    for (const d of Object.values(TITAN_DEFS))
      texts.push(d.failureMode.text, d.failureMode.name, d.epithet, d.resource.name, d.ui.tagline);
    for (const b of Object.values(DAMAGE_BLURB)) texts.push(b.text, b.name);
    const missing = new Set<string>();
    for (const t of texts)
      for (const ch of t)
        if (ch !== ' ' && !MICRO_GLYPHS[ch] && !MICRO_GLYPHS[ch.toUpperCase()]) missing.add(ch);
    expect([...missing]).toEqual([]);
  });
});

describe('the body face has a glyph for every Latin character the data strings use in it', () => {
  it('names, taglines, stage names and blurbs', () => {
    const texts: string[] = [];
    for (const d of Object.values(TITAN_DEFS)) texts.push(d.name, d.ui.tagline, d.epithet);
    for (const id of STAGE_IDS) texts.push(STAGE_INFO[id].name, STAGE_INFO[id].blurb);
    const missing = new Set<string>();
    for (const t of texts)
      for (const ch of t) {
        const code = ch.codePointAt(0)!;
        const hangeul = code >= 0xac00 && code <= 0xd7a3;
        if (ch !== ' ' && !hangeul && !BODY_GLYPHS[ch] && !BODY_GLYPHS[ch.toUpperCase()]) missing.add(ch);
      }
    expect([...missing]).toEqual([]);
  });
});
