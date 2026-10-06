import { WITNESS_MATERIALS } from '@/titans/art/lastone';
import { getTitanDef } from '@/titans/defs';
import { linearToOklab, srgbToLinear } from './palette';

/**
 * The MASTER PALETTE (shared/UNIFICATION.md §2, D31-4): one set of colours for every titan and every effect, built as the union
 * of the approved ramps and snapped to by the renderer's final pass (Bayer-dithered, never a smooth gradient).
 *
 * Sources, dark → light per ramp (the oracles are the reference: uri/src/10_parts_render.js, mouth/src/10_mouth_render_lib.js,
 * uri/src/00_shared_helpers.js PAL for the effect ramps):
 *  - 우리 (locked): stone s1 (warm umber, 11) and s2 (cool lavender, 11), civilization light, field blue, hot core, cold core;
 *  - the Mouth (locked): wet black, raw red, pale sinew, old bone, throat glow;
 *  - effects: the star flash (white → pale yellow → orange → red → deep red), lingering dust, rock debris, the outline colour;
 *  - the Witness and the Planet: their material ramps as they are today.
 * Near-duplicates are merged (closest OKLab pair first) until the palette fits MASTER_MAX. A merge always keeps the colour of
 * the higher-priority source (locked titans > effects > Witness / Planet), so 우리 and the Mouth keep their exact colours unless
 * two of their own colours are practically identical.
 */

export interface MasterRampSource {
  name: string;
  /** 3 = locked oracle titan, 2 = shared effects, 1 = existing titans. */
  priority: number;
  /** Emissive / wet ramps may reach their top step on a titan; the rest stop one step below (UNIFICATION §3). */
  glow: boolean;
  colors: readonly string[];
}

/** Upper bound of the master palette (and the palette texture width). */
export const MASTER_MAX = 128;

const URI_RAMPS: readonly MasterRampSource[] = [
  {
    name: 'uri.s1',
    priority: 3,
    glow: false,
    colors: [
      '#08060a',
      '#120d11',
      '#1d1619',
      '#2a1f21',
      '#382a29',
      '#4a3834',
      '#5f4a42',
      '#776053',
      '#937a68',
      '#b3987f',
      '#cfb79a',
    ],
  },
  {
    name: 'uri.s2',
    priority: 3,
    glow: false,
    colors: [
      '#07070c',
      '#100f17',
      '#1a1824',
      '#252232',
      '#312c40',
      '#3f3850',
      '#504762',
      '#645a76',
      '#7c708c',
      '#978ba5',
      '#b3a8bd',
    ],
  },
  { name: 'uri.civ', priority: 3, glow: true, colors: ['#e88a3a', '#ffb060', '#ffd890'] },
  { name: 'uri.field', priority: 3, glow: true, colors: ['#3a5ac8', '#6a92f8', '#b0ccff'] },
  {
    name: 'uri.hot',
    priority: 3,
    glow: true,
    colors: ['#1a0604', '#3a0c06', '#6a1a0a', '#9a300e', '#c45018', '#e07428', '#f49a48', '#ffc480'],
  },
  {
    name: 'uri.cold',
    priority: 3,
    glow: true,
    colors: ['#0c0a2a', '#1e1a5a', '#3a2e8e', '#5a4ac0', '#8a6ee0', '#c08ef0', '#f0b8f8', '#fff0ff'],
  },
];

const MOUTH_RAMPS: readonly MasterRampSource[] = [
  {
    name: 'mouth.black',
    priority: 3,
    glow: true,
    colors: ['#040205', '#0a050a', '#120810', '#1c0c17', '#28121f', '#36192a', '#472337'],
  },
  {
    name: 'mouth.red',
    priority: 3,
    glow: true,
    colors: [
      '#0e0207',
      '#1c040b',
      '#300810',
      '#480c18',
      '#621320',
      '#7e1c28',
      '#9c2a30',
      '#ba3e3c',
      '#d45e50',
      '#e8866a',
    ],
  },
  {
    name: 'mouth.pale',
    priority: 3,
    glow: true,
    colors: [
      '#200e12',
      '#3a1a1e',
      '#5a2c2c',
      '#7e443c',
      '#a2604e',
      '#c28268',
      '#dca88c',
      '#efcdb2',
      '#fbe8d6',
    ],
  },
  {
    name: 'mouth.bone',
    priority: 3,
    glow: false,
    colors: [
      '#160e0e',
      '#2e201e',
      '#4e3a34',
      '#73594e',
      '#9a7e70',
      '#bfa392',
      '#dbc6b4',
      '#efe2d4',
      '#fcf6ee',
    ],
  },
  {
    name: 'mouth.maw',
    priority: 3,
    glow: true,
    colors: [
      '#080103',
      '#170206',
      '#2c040a',
      '#4a080e',
      '#701010',
      '#9c1a12',
      '#c82e16',
      '#ee5420',
      '#ff8a40',
    ],
  },
];

/** Effect ramps (VFX_SPEC), every colour taken from the oracles' shared palette (uri/src/00_shared_helpers.js PAL). */
export const VFX_RAMPS = {
  /** The stepped star flash, cooling outward and frame by frame: deep red → red → orange → pale yellow → white. */
  flash: ['#5a1014', '#b84a2a', '#ff9a3c', '#ffd27a', '#fff4d6', '#ffffff'],
  /** Lingering dust and vapour: low-contrast cool greys. */
  dust: ['#1e1e23', '#2c2c32', '#3b3b42', '#4d4c53', '#626067', '#7a777c', '#95918f'],
  /** Rock debris: dark stone with a lit edge. */
  rock: ['#0d0c0f', '#1c1a1f', '#2e2a2e', '#47403d', '#6b5f55', '#93857a'],
} as const;

/** The one dark outline colour around every titan silhouette (the oracles' compose(): rgb 4, 4, 8). */
export const OUTLINE_COLOR = '#040408';

const EFFECT_RAMPS: readonly MasterRampSource[] = [
  { name: 'vfx.flash', priority: 2, glow: true, colors: VFX_RAMPS.flash },
  { name: 'vfx.dust', priority: 2, glow: false, colors: VFX_RAMPS.dust },
  { name: 'vfx.rock', priority: 2, glow: false, colors: VFX_RAMPS.rock },
  { name: 'outline', priority: 2, glow: false, colors: [OUTLINE_COLOR] },
];

/** The existing titans' ramps (the Witness's materials and the Planet's), read from their definitions. */
function titanRamps(): MasterRampSource[] {
  const out: MasterRampSource[] = [];
  for (const m of WITNESS_MATERIALS)
    out.push({ name: `witness.${m.key}`, priority: 1, glow: m.visual.emissive >= 60, colors: m.visual.ramp });
  out.push({
    name: 'witness.glow',
    priority: 1,
    glow: true,
    colors: WITNESS_MATERIALS[0]!.visual.glowRamp ?? [],
  });
  const planet = getTitanDef('planet');
  for (const m of planet.materials) {
    const v = m.visual;
    out.push({ name: `planet.${m.key}`, priority: 1, glow: v.emissive >= 60, colors: v.ramp });
    if (v.glowRamp) out.push({ name: `planet.${m.key}.glow`, priority: 1, glow: true, colors: v.glowRamp });
  }
  return out.filter((r) => r.colors.length > 0);
}

export interface MasterPalette {
  /** The colours, ramp by ramp, dark → light within a ramp. */
  readonly colors: readonly string[];
  /** Length of each ramp in `colors` (for the dither: only neighbours of one ramp are mixed). */
  readonly rampLengths: readonly number[];
  /** Per colour: the index to use instead on a NON-glowing titan pixel (the step below a ramp's top), or itself. */
  readonly ceiling: Uint8Array;
  /** Per source ramp: its colours as master indices after the merge (in order, duplicates collapsed). */
  readonly ramps: Readonly<Record<string, readonly number[]>>;
  /** Largest OKLab distance a locked (priority 3) colour moved by in the merge (0 = every locked colour kept exactly). */
  readonly lockedShift: number;
  /** Colours before the merge. */
  readonly sourceCount: number;
}

interface Entry {
  hex: string;
  lab: [number, number, number];
  priority: number;
  /** Source ramps this colour stands for (after merges). */
  alive: boolean;
}

const lab = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16);
  const o = [0, 0, 0];
  linearToOklab(
    srgbToLinear(((v >> 16) & 255) / 255),
    srgbToLinear(((v >> 8) & 255) / 255),
    srgbToLinear((v & 255) / 255),
    o,
  );
  return [o[0]!, o[1]!, o[2]!];
};
const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** Build a master palette from ramp sources (exported for tests; the game uses `MASTER`). */
export function buildMasterPalette(sources: readonly MasterRampSource[], max = MASTER_MAX): MasterPalette {
  const entries: Entry[] = [];
  const byHex = new Map<string, number>();
  const srcIdx: number[][] = [];
  for (const s of sources) {
    const idx: number[] = [];
    for (const h of s.colors) {
      const hex = h.toLowerCase();
      let i = byHex.get(hex);
      if (i === undefined) {
        i = entries.push({ hex, lab: lab(hex), priority: s.priority, alive: true }) - 1;
        byHex.set(hex, i);
      } else entries[i]!.priority = Math.max(entries[i]!.priority, s.priority);
      idx.push(i);
    }
    srcIdx.push(idx);
  }
  const sourceCount = entries.length;
  // where each entry went (union-find without ranks: tiny sets)
  const to = entries.map((_, i) => i);
  const find = (i: number): number => (to[i] === i ? i : (to[i] = find(to[i]!)));
  let alive = entries.length;
  let lockedShift = 0;
  while (alive > max) {
    let bi = -1;
    let bj = -1;
    let bd = Infinity;
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i]!.alive) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (!entries[j]!.alive) continue;
        // merging two locked colours costs more: they are the oracles' own
        const w = entries[i]!.priority === 3 && entries[j]!.priority === 3 ? 2 : 1;
        const d = dist(entries[i]!.lab, entries[j]!.lab) * w;
        if (d < bd) {
          bd = d;
          bi = i;
          bj = j;
        }
      }
    }
    // keep the higher-priority colour (ties: the one listed first)
    const keep = entries[bj]!.priority > entries[bi]!.priority ? bj : bi;
    const drop = keep === bi ? bj : bi;
    if (entries[drop]!.priority === 3)
      lockedShift = Math.max(lockedShift, dist(entries[drop]!.lab, entries[keep]!.lab));
    entries[drop]!.alive = false;
    to[drop] = keep;
    alive--;
  }
  // final order: ramp by ramp in source order, each surviving colour once (where it first appears)
  const order: number[] = [];
  const pos = new Map<number, number>();
  const rampLengths: number[] = [];
  const ramps: Record<string, number[]> = {};
  sources.forEach((s, si) => {
    let n = 0;
    const r: number[] = [];
    for (const i of srcIdx[si]!) {
      const k = find(i);
      if (!pos.has(k)) {
        pos.set(k, order.length);
        order.push(k);
        n++;
      }
      const m = pos.get(k)!;
      if (r[r.length - 1] !== m) r.push(m);
    }
    if (n > 0) rampLengths.push(n);
    ramps[s.name] = r;
  });
  // the highlight ceiling: a colour that tops a NON-glowing ramp maps to that ramp's step below
  const ceiling = new Uint8Array(order.length);
  for (let i = 0; i < ceiling.length; i++) ceiling[i] = i;
  sources.forEach((s) => {
    const r = ramps[s.name]!;
    if (s.glow || r.length < 2) return;
    const top = r[r.length - 1]!;
    if (ceiling[top] === top) ceiling[top] = r[r.length - 2]!;
  });
  // a step below that is itself another non-glowing ramp's top steps down again (merged ramps share colours)
  for (let i = 0; i < ceiling.length; i++) {
    let c = ceiling[i]!;
    for (let guard = 0; guard < 8 && ceiling[c] !== c; guard++) c = ceiling[c]!;
    ceiling[i] = c;
  }
  return {
    colors: order.map((i) => entries[i]!.hex),
    rampLengths,
    ceiling,
    ramps,
    lockedShift,
    sourceCount,
  };
}

/** Every ramp the master palette is built from, in priority order. */
export function masterSources(): MasterRampSource[] {
  return [...URI_RAMPS, ...MOUTH_RAMPS, ...EFFECT_RAMPS, ...titanRamps()];
}

let cached: MasterPalette | null = null;
/** The game's master palette (built once). */
export function masterPalette(): MasterPalette {
  return (cached ??= buildMasterPalette(masterSources()));
}

/**
 * Pull a stage palette into the shared universe: a stage colour within `snap` (OKLab) of a master colour becomes that master
 * colour; the rest are the stage's own accents and stay (arenas keep their nebulae).
 */
export function unifyStagePalette(
  stage: readonly string[],
  snap = 0.035,
): { colors: string[]; snapped: number } {
  const m = masterPalette().colors.map((h) => ({ h, l: lab(h) }));
  let snapped = 0;
  const colors = stage.map((h) => {
    const l = lab(h.toLowerCase());
    let best = '';
    let bd = Infinity;
    for (const c of m) {
      const d = dist(l, c.l);
      if (d < bd) {
        bd = d;
        best = c.h;
      }
    }
    if (bd <= snap) {
      snapped++;
      return best;
    }
    return h;
  });
  return { colors, snapped };
}
