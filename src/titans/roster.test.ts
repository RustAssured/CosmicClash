import { describe, expect, it } from 'vitest';
import { ROSTER_IDS, SLICE, TITAN_IDS, validateTitanDef, type TitanId } from '@/contracts';
import { KIT_BEHAVIOURS } from '@/combat/behaviours/kit';
import { motionProblems } from '@/combat/behaviours/kit/motion';
import { createTitanVoice } from '@/audio/voices';
import {
  IMPLEMENTED_TITANS,
  KIT_TITANS,
  ROSTER,
  SITE_ROSTER,
  WIP_IDS,
  getTitanDef,
  isTitanOffered,
  paintTitanMap,
} from '@/titans';
import { DEFAULT_LIGHTING } from '@/contracts';
import {
  BALANCE_BAND,
  balanceSweep,
  checkAiCoverage,
  checkPalette,
  checkReplay,
  checkSize,
} from '../../tools/titans/checks';

/**
 * THE ROSTER CHECKS: data-driven over the roster (src/contracts/roster.ts), so a new titan is covered the moment it is
 * registered (`npm run new:titan`), with no new tests. The slow balance sweep runs only with TITAN_BALANCE=1 (or per titan,
 * with a report: `npm run titan:check -- <id>`).
 */
const IDS = [...ROSTER_IDS] as TitanId[];

describe('the roster is one list', () => {
  it('derives the ids, the menus and the implemented titans from it', () => {
    expect(TITAN_IDS).toEqual([...ROSTER_IDS, 'mouth']);
    expect([...SLICE.titans]).toEqual(IDS);
    expect(IMPLEMENTED_TITANS).toEqual(IDS);
    expect(ROSTER.map((r) => r.id)).toEqual(IDS);
    // work-in-progress titans stay off the site and the press kit until they ship
    const shipped = IDS.filter((id) => !WIP_IDS.includes(id));
    expect(new Set(SITE_ROSTER.map((r) => r.id))).toEqual(new Set(shipped));
    expect(new Set(SITE_ROSTER.map((r) => r.site.file)).size).toBe(shipped.length);
    for (const id of WIP_IDS) expect(isTitanOffered(id), `${id} is locked without ?wip=`).toBe(false);
  });

  it('registers every kit titan in every layer (definition, painter, behaviour, voice, card)', () => {
    for (const k of KIT_TITANS) {
      const id = k.def.id;
      expect(IDS, `${id} is in src/contracts/roster.ts`).toContain(id);
      expect(KIT_BEHAVIOURS[id], `${id} has a behaviour in src/combat/behaviours/kit`).toBeDefined();
      expect(k.def.kit, `${id}'s JSON carries its kit block`).toBeDefined();
      expect(createTitanVoice(id).onHitDealt, `${id} is voiced (kit.voice)`).toBeDefined();
      expect(motionProblems(k.def), `${id}'s animation presets (kit.motion)`).toEqual([]);
    }
  });
});

describe.each(IDS)('roster titan %s', (id) => {
  it('passes the contract validator', () => {
    expect(validateTitanDef(getTitanDef(id))).toEqual([]);
  });

  it('fits the arena and its size class', () => {
    const r = checkSize(id);
    expect(r.problems, r.detail).toEqual([]);
  });

  it("wears its own colours (no clash with another titan's signature)", () => {
    const r = checkPalette(id);
    expect(r.problems, r.detail).toEqual([]);
  });

  it('gives the AI a model of every attack it has (coverage)', () => {
    const r = checkAiCoverage(id);
    expect(r.problems, r.detail).toEqual([]);
  });

  it('replays deterministically (the same AI fight twice, the same hash)', () => {
    const r = checkReplay(id, 300);
    expect(r.problems, r.detail).toEqual([]);
  }, 120_000);
});

describe.each(KIT_TITANS.map((k) => k.def.id))('kit titan %s', (id) => {
  it('paints deterministically and with a core inside its body', () => {
    const def = getTitanDef(id);
    const a = paintTitanMap(def, 7, DEFAULT_LIGHTING).map;
    const b = paintTitanMap(def, 7, DEFAULT_LIGHTING).map;
    expect(Buffer.compare(Buffer.from(a.baseColor.buffer), Buffer.from(b.baseColor.buffer))).toBe(0);
    expect(a.material[a.coreY * a.w + a.coreX]).not.toBe(0);
  });
});

describe.runIf(process.env.TITAN_BALANCE === '1').each(IDS)('balance sweep: %s', (id) => {
  it(`wins ${BALANCE_BAND[0] * 100}–${BALANCE_BAND[1] * 100} % against the roster at AI level 4`, () => {
    const { rate, rows } = balanceSweep(id, 4, 1);
    expect(rate, `${id}: ${(rate * 100).toFixed(0)} % of ${rows.length}`).toBeGreaterThanOrEqual(
      BALANCE_BAND[0],
    );
    expect(rate).toBeLessThanOrEqual(BALANCE_BAND[1]);
  }, 1_800_000);
});
