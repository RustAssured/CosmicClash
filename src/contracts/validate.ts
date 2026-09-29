import { CANCEL_WINDOW_FRACTION, STAGE_PALETTE_MAX, STAGE_PALETTE_MIN } from './constants';
import {
  AIM_DIRS,
  MOVE_SLOTS,
  TITAN_IDS,
  totalTicks,
  type FrameData,
  type MoveDef,
  type TitanDef,
} from './titan';
import type { StageInfo } from './render';
import { DAMAGE_TYPES } from './damage';

/** Feel targets in ticks (60 Hz). Ranges are inclusive. See titan.ts. */
export const FEEL_TARGETS = {
  strike: { total: [30, 48] as const },
  crush: { total: [72, 120] as const, startup: [21, 42] as const },
  ultimate: { total: [180, 300] as const },
} as const;

const inRange = (v: number, r: readonly [number, number]): boolean => v >= r[0] && v <= r[1];

/** Returns human-readable problems (empty = valid). Used by tests for every /src/titans/*.json. */
export function validateTitanDef(def: TitanDef): string[] {
  const errs: string[] = [];
  const e = (m: string): void => {
    errs.push(`${def.id}: ${m}`);
  };
  if (!(TITAN_IDS as readonly string[]).includes(def.id)) e(`unknown id ${def.id}`);
  for (const [k, v] of Object.entries(def.attributes)) {
    if (!Number.isInteger(v) || v < 1 || v > 10) e(`attribute ${k}=${v} must be an integer 1..10`);
  }
  if (!(DAMAGE_TYPES as readonly string[]).includes(def.destruction))
    e(`bad destruction type ${def.destruction}`);
  const keys = new Set<string>();
  for (const m of def.materials) {
    if (keys.has(m.key)) e(`duplicate material key ${m.key}`);
    keys.add(m.key);
    if (m.visual.ramp.length < 3) e(`material ${m.key}: ramp needs ≥3 colours`);
  }
  if (def.materials.length > 60) e('too many materials (material ids must fit a Uint8 with headroom)');
  for (const slot of MOVE_SLOTS) {
    if (!def.moves.some((mv) => mv.slot === slot)) e(`missing move slot ${slot}`);
  }
  const ids = new Set<string>();
  for (const mv of def.moves) {
    if (ids.has(mv.id)) e(`duplicate move id ${mv.id}`);
    ids.add(mv.id);
    validateMove(def, mv, e);
  }
  if (def.resource.max <= 0 || def.resource.start > def.resource.max) e('bad resource range');
  if (def.art.w > 224 || def.art.h > 224) e('map too large');
  return errs;
}

function validateFrame(f: FrameData, e: (m: string) => void, label: string): void {
  for (const k of ['startup', 'active', 'recovery', 'chargeMax', 'hitstop'] as const) {
    if (!Number.isInteger(f[k]) || f[k] < 0) e(`${label}: ${k}=${f[k]} must be a non-negative integer`);
  }
  if (f.startup < 1) e(`${label}: startup must be ≥1 (anticipation pose starts on tick 1)`);
  if (f.cancelWindow < 0 || f.cancelWindow > 1) e(`${label}: cancelWindow out of 0..1`);
}

function validateMove(def: TitanDef, mv: MoveDef, e: (m: string) => void): void {
  validateFrame(mv.frame, e, mv.id);
  for (const aim of AIM_DIRS) {
    const v = mv.variants[aim];
    if (!v) {
      e(`${mv.id}: missing aim variant ${aim}`);
      continue;
    }
    const f = { ...mv.frame, ...(v.frame ?? {}) };
    validateFrame(f, e, `${mv.id}/${aim}`);
    const total = totalTicks(f);
    if (mv.slot === 'strike' && !inRange(total, FEEL_TARGETS.strike.total))
      e(`${mv.id}/${aim}: strike total ${total} ticks outside ${FEEL_TARGETS.strike.total.join('–')}`);
    if (mv.slot === 'crush') {
      if (!inRange(total, FEEL_TARGETS.crush.total))
        e(`${mv.id}/${aim}: crush total ${total} outside ${FEEL_TARGETS.crush.total.join('–')}`);
      if (!inRange(f.startup, FEEL_TARGETS.crush.startup))
        e(`${mv.id}/${aim}: crush startup ${f.startup} outside ${FEEL_TARGETS.crush.startup.join('–')}`);
    }
    if (mv.slot === 'ultimate' && !inRange(total, FEEL_TARGETS.ultimate.total))
      e(`${mv.id}/${aim}: ultimate total ${total} outside ${FEEL_TARGETS.ultimate.total.join('–')}`);
    if (mv.slot !== 'surge' && mv.slot !== 'guard' && v.hitboxes.length === 0)
      e(`${mv.id}/${aim}: no hitboxes`);
    for (const hb of v.hitboxes) {
      if (hb.to <= hb.from) e(`${mv.id}/${aim}/${hb.id}: empty window`);
      if (hb.damage.energy <= 0) e(`${mv.id}/${aim}/${hb.id}: energy must be > 0`);
    }
  }
  if (mv.frame.cancelWindow > CANCEL_WINDOW_FRACTION + 1e-9 && (mv.slot === 'strike' || mv.slot === 'crush'))
    e(`${mv.id}: cancelWindow ${mv.frame.cancelWindow} > ${CANCEL_WINDOW_FRACTION} (spec: first 40%)`);
  if (mv.slot === 'ultimate' && mv.meterCost !== 1) e(`${mv.id}: ultimate meterCost must be 1`);
  void def;
}

export function validateStageInfo(s: StageInfo): string[] {
  const errs: string[] = [];
  const n = s.palette.length;
  if (n < STAGE_PALETTE_MIN || n > STAGE_PALETTE_MAX)
    errs.push(`${s.id}: palette has ${n} colours (need ${STAGE_PALETTE_MIN}–${STAGE_PALETTE_MAX})`);
  for (const c of s.palette) if (!/^#[0-9a-fA-F]{6}$/.test(c)) errs.push(`${s.id}: bad palette colour ${c}`);
  const [x, y, z] = s.lighting.dir;
  if (Math.abs(Math.hypot(x, y, z) - 1) > 1e-3) errs.push(`${s.id}: lighting.dir must be unit length`);
  if (s.arena.maxX <= s.arena.minX || s.arena.maxY <= s.arena.minY) errs.push(`${s.id}: degenerate arena`);
  return errs;
}
