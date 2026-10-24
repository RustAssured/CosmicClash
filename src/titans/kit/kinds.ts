import type {
  DamageType,
  KitVoiceTuning,
  MaterialSpec,
  ParticleKind,
  SizeClass,
  TitanKind,
} from '@/contracts';
import { buildRamp } from './palette';

/**
 * TITAN KINDS: what a titan fundamentally is, as an authoring preset. Picking a kind for a new titan (the builder at
 * dev/builder/, or `npm run new:titan -- … --kind=<kind>`) gives the blob template's five materials (skin, flesh, marking,
 * eye, core) their physics archetype and ramp shape, the body its outline character, and the voice and movement wake their
 * defaults. Nothing in the game reads the kind: it is a starting point and a label, and every number stays editable.
 *
 * Pure data, no DOM; the ramps are built around the titan's hue by `kindMaterials`.
 */

/** The blob template's material keys, outside to inside (src/titans/kit/blob.ts). */
export const BLOB_KEYS = ['skin', 'flesh', 'marking', 'eye', 'core'] as const;
export type BlobKey = (typeof BLOB_KEYS)[number];

/** One blob material of a kind: its archetype (src/matter/archetypes.ts) and its ramp around the titan's hue. */
export interface KindMaterial {
  base: string;
  physics?: MaterialSpec['physics'];
  /** Hue offset from the titan's hue (degrees), ramp steps, saturation, darkest and lightest lightness. */
  dh: number;
  n: number;
  sat: number;
  lo: number;
  hi: number;
  emissive: number;
}

/** The blob painter's look numbers a kind sets (src/titans/kit/blob.ts `BlobParams`, unscaled). */
export interface KindShape {
  lobes: number;
  lobeSize: number;
  wobble: number;
  skin: number;
  markings: number;
  markingSize: number;
  eyes: number;
}

export interface KindPreset {
  id: TitanKind;
  label: string;
  ko: string;
  /** One line: what belongs to this kind. */
  blurb: string;
  /** The damage type that suits it best (a suggestion: the blob's moves are KINETIC until changed). */
  destruction: DamageType;
  materials: Record<BlobKey, KindMaterial>;
  shape: KindShape;
  voice: KitVoiceTuning;
  /** The movement wake's particle kind (`feel.fx.kind`). */
  wake: ParticleKind;
}

export const KIND_PRESETS: Readonly<Record<TitanKind, KindPreset>> = {
  celestial: {
    id: 'celestial',
    label: 'Celestial body',
    ko: '천체',
    blurb: 'Stars, planets, holes in space: round, layered, glowing from within.',
    destruction: 'THERMAL',
    materials: {
      skin: { base: 'mantle', dh: 0, n: 8, sat: 0.55, lo: 0.1, hi: 0.86, emissive: 6 },
      flesh: { base: 'magma', dh: -18, n: 7, sat: 0.75, lo: 0.14, hi: 0.8, emissive: 24 },
      marking: { base: 'crystal', dh: 30, n: 6, sat: 0.7, lo: 0.2, hi: 0.9, emissive: 30 },
      eye: { base: 'crystal', dh: 180, n: 6, sat: 0.8, lo: 0.2, hi: 0.95, emissive: 56 },
      core: {
        base: 'core',
        dh: 40,
        n: 6,
        sat: 0.9,
        lo: 0.3,
        hi: 0.97,
        emissive: 72,
        physics: { density: 3 },
      },
    },
    // one 'eye': a bright hotspot on the surface (every authored material must show in the body)
    shape: { lobes: 0, lobeSize: 0.3, wobble: 1.5, skin: 6, markings: 0.5, markingSize: 15, eyes: 1 },
    voice: { pitch: 32, grit: 0.2, ring: 0.55, wet: 0.85 },
    wake: 'ember',
  },
  mineral: {
    id: 'mineral',
    label: 'Rock & metal',
    ko: '암석',
    blurb: 'Asteroids, ores, crystal masses: hard, faceted, breaking into shards and chunks.',
    destruction: 'KINETIC',
    materials: {
      skin: {
        base: 'rock',
        dh: 0,
        n: 8,
        sat: 0.28,
        lo: 0.07,
        hi: 0.78,
        emissive: 0,
        physics: { toughness: 0.7 },
      },
      flesh: { base: 'regolith', dh: -10, n: 7, sat: 0.32, lo: 0.1, hi: 0.72, emissive: 0 },
      marking: { base: 'ice', dh: 170, n: 6, sat: 0.6, lo: 0.2, hi: 0.9, emissive: 18 },
      eye: { base: 'crystal', dh: 180, n: 6, sat: 0.7, lo: 0.12, hi: 0.92, emissive: 40 },
      core: {
        base: 'ironNickel',
        dh: 150,
        n: 6,
        sat: 0.7,
        lo: 0.2,
        hi: 0.92,
        emissive: 48,
        physics: { density: 3, toughness: 0.9 },
      },
    },
    shape: { lobes: 3, lobeSize: 0.45, wobble: 3, skin: 5, markings: 0.25, markingSize: 11, eyes: 1 },
    voice: { pitch: 60, grit: 0.85, ring: 0.35, wet: 0.4 },
    wake: 'dust',
  },
  organic: {
    id: 'organic',
    label: 'Organic',
    ko: '생물',
    // the blob template as it always was (materials, outline, voice, wake): a new blob without a --kind is organic
    blurb: 'Flesh, membrane, tendrils: soft, lobed, wet, tearing rather than shattering.',
    destruction: 'KINETIC',
    materials: {
      skin: {
        base: 'regolith',
        dh: 0,
        n: 8,
        sat: 0.45,
        lo: 0.07,
        hi: 0.82,
        emissive: 0,
        physics: { toughness: 0.95 },
      },
      flesh: { base: 'regolith', dh: -12, n: 7, sat: 0.55, lo: 0.1, hi: 0.78, emissive: 0 },
      marking: { base: 'crystal', dh: 150, n: 6, sat: 0.65, lo: 0.12, hi: 0.85, emissive: 20 },
      eye: { base: 'crystal', dh: 180, n: 6, sat: 0.75, lo: 0.1, hi: 0.92, emissive: 48 },
      core: {
        base: 'ironNickel',
        dh: 170,
        n: 6,
        sat: 0.85,
        lo: 0.2,
        hi: 0.95,
        emissive: 60,
        physics: { density: 3, toughness: 0.9 },
      },
    },
    shape: { lobes: 5, lobeSize: 0.38, wobble: 6, skin: 4, markings: 0.35, markingSize: 13, eyes: 3 },
    voice: { pitch: 55, grit: 0.5, ring: 0.3, wet: 0.5 },
    wake: 'dust',
  },
  construct: {
    id: 'construct',
    label: 'Construct',
    ko: '구조체',
    blurb: 'Idols, engines, made things: glazed, banded, clean seams that shear along their lines.',
    destruction: 'FRACTURE',
    materials: {
      skin: { base: 'celadon', dh: 0, n: 8, sat: 0.35, lo: 0.1, hi: 0.86, emissive: 0 },
      flesh: { base: 'rock', dh: -20, n: 7, sat: 0.25, lo: 0.1, hi: 0.7, emissive: 0 },
      marking: { base: 'chain', dh: 50, n: 6, sat: 0.6, lo: 0.2, hi: 0.88, emissive: 12 },
      eye: { base: 'eye', dh: 180, n: 6, sat: 0.75, lo: 0.15, hi: 0.95, emissive: 52 },
      core: {
        base: 'node',
        dh: 45,
        n: 6,
        sat: 0.8,
        lo: 0.25,
        hi: 0.95,
        emissive: 64,
        physics: { density: 2.5 },
      },
    },
    shape: { lobes: 4, lobeSize: 0.3, wobble: 1, skin: 6, markings: 0.3, markingSize: 16, eyes: 1 },
    voice: { pitch: 70, grit: 0.5, ring: 0.8, wet: 0.5 },
    wake: 'glint',
  },
  cosmic: {
    id: 'cosmic',
    label: 'Cosmic being',
    ko: '우주적 존재',
    blurb: 'Watchers, possessors, things with too many eyes: luminous, crystalline, unsettling.',
    destruction: 'FRACTURE',
    materials: {
      skin: { base: 'crystal', dh: 0, n: 8, sat: 0.5, lo: 0.08, hi: 0.88, emissive: 8 },
      flesh: { base: 'tendril', dh: 25, n: 7, sat: 0.6, lo: 0.1, hi: 0.8, emissive: 10 },
      marking: { base: 'glass', dh: 200, n: 6, sat: 0.7, lo: 0.2, hi: 0.92, emissive: 28 },
      eye: { base: 'eye', dh: 180, n: 6, sat: 0.85, lo: 0.15, hi: 0.97, emissive: 60 },
      core: {
        base: 'core',
        dh: 150,
        n: 6,
        sat: 0.9,
        lo: 0.3,
        hi: 0.98,
        emissive: 72,
        physics: { density: 3 },
      },
    },
    shape: { lobes: 2, lobeSize: 0.5, wobble: 4, skin: 4, markings: 0.45, markingSize: 12, eyes: 5 },
    voice: { pitch: 38, grit: 0.3, ring: 0.5, wet: 0.9 },
    wake: 'plasma',
  },
};

/** The blob's look numbers are authored for a medium body; a size class scales its lengths (radii, wobble, markings). */
export const BLOB_SIZE_SCALE: Readonly<Record<SizeClass, number>> = {
  small: 0.72,
  medium: 1,
  large: 1.3,
  huge: 1.3,
};

/** One kind material as a JSON material entry, its ramp built around `hue`. */
export function kindMaterial(key: string, km: KindMaterial, hue: number): MaterialSpec {
  const ramp = buildRamp(hue + km.dh, km.n, km.sat, km.lo, km.hi);
  return {
    key,
    base: km.base,
    ...(km.physics ? { physics: { ...km.physics } } : {}),
    visual: {
      ramp,
      emissive: km.emissive,
      char: ramp[1]!,
      crack: ramp[0]!,
      debris: ramp[Math.floor(ramp.length / 2)]!,
    },
  };
}

/** The blob template's five materials for a kind, around `hue`. */
export const kindMaterials = (kind: TitanKind, hue: number): MaterialSpec[] =>
  BLOB_KEYS.map((k) => kindMaterial(k, KIND_PRESETS[kind].materials[k], hue));
