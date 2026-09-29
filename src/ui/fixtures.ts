import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  createMatterMap,
  hex,
  hsl,
  rgba,
  type BodyStats,
  type EffectiveStats,
  type FighterView,
  type HudState,
  type MatchApi,
  type MatterBody,
  type MoveDef,
  type RoundPhase,
  type TitanDef,
  type TitanId,
} from '@/contracts';
import type { PortraitSprite, TitanInfo } from './types';

/**
 * Synthetic data for tests, the UI sandbox and the screenshot tool: the six titans' roster numbers from the design bible,
 * procedural stand-in portraits, and fake `HudState`s at intact / 50 % / 10 %. NEVER imported by the shipped app.
 */

export const FIXTURE_TITANS: TitanInfo[] = [
  {
    id: 'lastone',
    name: 'The Last One',
    nameKo: '마지막 하나',
    epithet: 'De Laatste',
    accent: '#a8bdb2',
    accent2: '#e8f2ec',
    tagline: 'One ancient eye. A halo of tendrils.',
    attributes: { mass: 5, cohesion: 8, heat: 5, gravity: 3, reach: 7, tempo: 7 },
    resource: { name: 'Tendrils', nameKo: '촉수', display: 'pips', max: 24 },
    destruction: 'FRACTURE',
    passive: { name: 'Stillness', text: 'Tendrils sense the coming blow.' },
    failureMode: { name: 'Severed', text: 'Tendrils sever one by one; the exposed eye takes heavy damage.' },
  },
  {
    id: 'nexus',
    name: 'The Nexus',
    nameKo: '넥서스',
    epithet: 'De Nexus',
    accent: '#e0526a',
    accent2: '#ffd0d6',
    tagline: 'A graph of nodes and hardened chains.',
    attributes: { mass: 6, cohesion: 6, heat: 4, gravity: 4, reach: 8, tempo: 4 },
    resource: { name: 'Nodes', nameKo: '노드', display: 'pips', max: 8 },
    destruction: 'ASSIMILATION',
    passive: { name: 'Growth', text: 'Harvested lattice becomes new nodes.' },
    failureMode: { name: 'Snapped', text: 'Edges snap, nodes go dark, disconnected islands die.' },
  },
  {
    id: 'blackhole',
    name: 'Black Hole',
    nameKo: '블랙홀',
    epithet: 'Event Horizon',
    accent: '#f2a54e',
    accent2: '#ffe2b0',
    tagline: 'Everything falls in. Nothing returns.',
    attributes: { mass: 8, cohesion: 9, heat: 10, gravity: 10, reach: 5, tempo: 2 },
    resource: { name: 'Accreted', nameKo: '강착', display: 'bar', max: 100 },
    destruction: 'TIDAL',
    passive: { name: 'Feeding', text: 'Grows heavier and stronger as it feeds.' },
    failureMode: { name: 'Evaporation', text: 'A disrupted disk sheds mass; at low mass it evaporates.' },
  },
  {
    id: 'supernova',
    name: 'Supernova',
    nameKo: '초신성',
    epithet: 'Dying Star',
    accent: '#ff8a3d',
    accent2: '#ffe0a0',
    tagline: 'Burning brightest at the end.',
    attributes: { mass: 7, cohesion: 3, heat: 10, gravity: 6, reach: 6, tempo: 5 },
    resource: { name: 'Fuel', nameKo: '연료', display: 'bar', max: 100 },
    destruction: 'THERMAL',
    passive: { name: 'Corona', text: 'Heat bleeds into everything nearby.' },
    failureMode: {
      name: 'Collapse',
      text: 'Outer layers blow off; at zero fuel it collapses in a final nova.',
    },
  },
  {
    id: 'planet',
    name: 'Planet',
    nameKo: '행성',
    epithet: 'Living World',
    accent: '#58a8d8',
    accent2: '#c8e8ff',
    tagline: 'Oceans, storms and a molten heart.',
    attributes: { mass: 8, cohesion: 7, heat: 6, gravity: 7, reach: 6, tempo: 3 },
    resource: { name: 'Moons', nameKo: '위성', display: 'pips', max: 2 },
    destruction: 'CRUSH',
    passive: { name: 'Atmosphere', text: 'Air soaks heat until it is stripped away.' },
    failureMode: { name: 'Cracked', text: 'Crust splits to reveal magma; moons can be knocked from orbit.' },
  },
  {
    id: 'asteroid',
    name: 'Asteroid',
    nameKo: '소행성',
    epithet: 'Iron Wanderer',
    accent: '#c9a26e',
    accent2: '#f0dcb4',
    tagline: 'Small, fast, and still very heavy.',
    attributes: { mass: 3, cohesion: 6, heat: 5, gravity: 1, reach: 4, tempo: 9 },
    resource: { name: 'Fragments', nameKo: '파편', display: 'pips', max: 6 },
    destruction: 'KINETIC',
    passive: { name: 'Tumble', text: 'Momentum carries through every hit.' },
    failureMode: { name: 'Rubble', text: 'At low mass it becomes a rubble pile held by weak gravity.' },
  },
];

/* ------------------------------------------------------------------------------------------------ *
 *  stand-in portraits
 * ------------------------------------------------------------------------------------------------ */
function hash2(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, s);
  const b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s);
  const d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, y: number, s: number): number =>
  vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15;

/** A lit-sphere shader with a hue-shifted ramp: the look of the real titans in miniature. */
function shade(nx: number, ny: number, h: number, sat: number, light: number, rim = 0): number {
  const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
  const l = Math.max(0, -0.5 * nx - 0.55 * ny + 0.68 * nz);
  const t = Math.min(1, light * (0.18 + 0.85 * l) + rim);
  return hsl(
    h + (t - 0.5) * 0.09,
    sat * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.05))),
    0.06 + t * 0.78,
  );
}

export function fixturePortrait(id: TitanId, size = 112): PortraitSprite {
  const px = new Uint32Array(size * size);
  const c = size / 2;
  const seed = id.length * 31 + id.charCodeAt(0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c + 0.5) / (size * 0.5);
      const dy = (y - c + 0.5) / (size * 0.5);
      const r = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      let col = 0;
      switch (id) {
        case 'lastone': {
          const body = 0.62 + (fbm(Math.cos(a) * 1.6 + 3, Math.sin(a) * 1.6 + 3, seed) - 0.5) * 0.35;
          if (r < body) {
            const n = fbm(x * 0.09, y * 0.09, seed);
            col = shade(dx / body, dy / body, 0.42, 0.22 + n * 0.1, 0.95, 0);
            const er = Math.hypot(dx * 1.0, (dy + 0.02) * 1.5);
            if (er < 0.22)
              col = er < 0.09 ? rgba(20, 30, 28) : shade(dx * 3, dy * 3.5, 0.13, 0.7, 1.05, 0.15);
            if (er < 0.24 && er > 0.2) col = hex('#1b2a26');
          } else if (r < 0.98) {
            // tendrils: sparse radial filaments
            const k = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 22);
            const ta = ((k + 0.5) / 22) * Math.PI * 2 - Math.PI;
            const sway = Math.sin(r * 9 + k) * 0.06;
            const d = Math.abs(Math.atan2(Math.sin(a - ta - sway), Math.cos(a - ta - sway))) * r;
            if (d < 0.018 * (1.3 - r) && hash2(k, 3, seed) > 0.25) col = shade(0.2, -0.3, 0.4, 0.2, 0.9);
          }
          break;
        }
        case 'nexus': {
          const gx = Math.floor((x + 6) / 22);
          const gy = Math.floor((y + 6) / 22);
          const nxp = gx * 22 + 8 + hash2(gx, gy, seed) * 16 - 6;
          const nyp = gy * 22 + 8 + hash2(gx, gy, seed + 1) * 16 - 6;
          const inside = r < 0.92;
          if (inside) {
            if (Math.hypot(x - nxp, y - nyp) < 5.5)
              col = shade((x - nxp) / 6, (y - nyp) / 6, 0.97, 0.8, 1.0, 0.1);
            const hub = Math.hypot(dx, dy) < 0.24;
            if (hub) col = shade(dx * 4, dy * 4, 0.99, 0.6, 1.1, 0.12);
            // chains: edges to hub from nodes on a ring
            for (let k = 0; k < 7; k++) {
              const na = (k / 7) * Math.PI * 2 + hash2(k, 9, seed);
              const ex = Math.cos(na) * 0.66 * c + c;
              const ey = Math.sin(na) * 0.66 * c + c;
              const t = ((x - c) * (ex - c) + (y - c) * (ey - c)) / ((ex - c) ** 2 + (ey - c) ** 2);
              if (t > 0 && t < 1) {
                const px2 = c + (ex - c) * t;
                const py2 = c + (ey - c) * t;
                if (Math.hypot(x - px2, y - py2) < 1.2) col = hex('#b4384c');
              }
              if (Math.hypot(x - ex, y - ey) < 6)
                col = shade((x - ex) / 6, (y - ey) / 6, 0.97, 0.8, 1.0, 0.1);
            }
          }
          break;
        }
        case 'blackhole': {
          if (r < 0.34) col = hex('#02030a');
          else if (r < 0.37) col = hex('#ffe3b0');
          // accretion disk: an inclined ellipse with Doppler brightening on the left
          const ex = dx;
          const ey = dy * 3.2;
          const er = Math.hypot(ex, ey);
          if (er > 0.42 && er < 0.98 && Math.abs(dy) < 0.28) {
            const v = fbm(a * 3 + er * 4, er * 6, seed);
            const bright = 0.55 + 0.45 * -dx;
            col = hsl(
              0.08 + (1 - er) * 0.05,
              0.9,
              Math.min(0.9, 0.16 + bright * 0.55 * (0.5 + v * 0.6) * (1.2 - er * 0.7)),
            );
            if (r < 0.34) col = hex('#02030a');
          }
          break;
        }
        case 'supernova': {
          const flick = fbm(Math.cos(a) * 2 + 5, Math.sin(a) * 2 + 5, seed);
          const body = 0.56 + (flick - 0.5) * 0.06;
          if (r < body) {
            const g = fbm(x * 0.12, y * 0.12, seed);
            col = hsl(0.06 + g * 0.06, 0.95, 0.42 + g * 0.42 - r * 0.28);
          } else if (r < 0.98) {
            const f = fbm(a * 4 + r * 3, r * 5, seed + 3);
            const life = Math.max(0, 1 - (r - body) / (0.98 - body));
            if (f * life > 0.36) col = hsl(0.05 + f * 0.05, 0.9, 0.3 + life * 0.5);
          }
          break;
        }
        case 'planet': {
          if (r < 0.66) {
            const n = fbm(x * 0.05 + 4, y * 0.05, seed);
            const band = Math.sin(dy * 9 + n * 4);
            const land = n > 0.56;
            const h = land ? 0.3 : 0.57;
            col = shade(dx / 0.66, dy / 0.66, h, land ? 0.45 : 0.6, 0.95 + band * 0.08, r > 0.6 ? 0.18 : 0);
          }
          if (Math.hypot(dx - 0.7, dy + 0.62) < 0.13)
            col = shade((dx - 0.7) / 0.13, (dy + 0.62) / 0.13, 0.1, 0.15, 0.95);
          break;
        }
        case 'asteroid': {
          const body = 0.68 + (fbm(Math.cos(a) * 1.9 + 9, Math.sin(a) * 1.9 + 9, seed) - 0.5) * 0.55;
          if (r < body) {
            const n = fbm(x * 0.13, y * 0.13, seed);
            let l = 0.9 + (n - 0.5) * 0.6;
            for (const [cx, cy, cr] of [
              [-0.15, -0.12, 0.16],
              [0.22, 0.2, 0.12],
              [-0.28, 0.25, 0.09],
            ] as const) {
              const d = Math.hypot(dx - cx, dy - cy);
              if (d < cr) l *= d > cr * 0.75 ? 1.25 : 0.62;
            }
            col = shade(dx / body, dy / body, 0.09, 0.4, l, 0);
          }
          break;
        }
      }
      px[y * size + x] = col;
    }
  }
  return { pixels: px, w: size, h: size };
}

export const fixturePortraitProvider = (() => {
  const cache = new Map<TitanId, PortraitSprite>();
  return (id: TitanId): PortraitSprite => {
    let p = cache.get(id);
    if (!p) {
      p = fixturePortrait(id);
      cache.set(id, p);
    }
    return p;
  };
})();

/* ------------------------------------------------------------------------------------------------ *
 *  fake fight state
 * ------------------------------------------------------------------------------------------------ */
const noStats: EffectiveStats = { speedMul: 1, damageMul: 1, mass: 5, reachMul: 1, tempoMul: 1 };

function carve(src: PortraitSprite, keep: number, seed: number): Uint32Array {
  // remove connected-ish blobs until ~keep of the cells remain
  const px = src.pixels.slice();
  let total = 0;
  for (const c of px) if (c >>> 24) total++;
  let left = total;
  let k = 0;
  while (left > total * keep && k < 400) {
    const cx = hash2(k, 1, seed) * src.w;
    const cy = hash2(k, 2, seed) * src.h;
    const r = 6 + hash2(k, 3, seed) * 14;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(src.h, cy + r); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(src.w, cx + r); x++) {
        if (
          Math.hypot(x - cx, y - cy) < r * (0.75 + 0.5 * vnoise(x * 0.4, y * 0.4, seed)) &&
          px[y * src.w + x]! >>> 24
        ) {
          px[y * src.w + x] = 0;
          left--;
        }
      }
    }
    k++;
  }
  return px;
}

export interface FakeFighterOpts {
  slot: 0 | 1;
  titan: TitanId;
  /** Fraction of the body still present (1, 0.5, 0.1). */
  massFrac?: number;
  state?: FighterView['state'];
  moveId?: string | null;
  phase?: FighterView['phase'];
  moveTick?: number;
  moveTotal?: number;
  guardUp?: boolean;
  resource?: number;
  meter?: number;
  hitstun?: number;
}

function fakeMove(id: string, slot: MoveDef['slot'], s: number, a: number, r: number): MoveDef {
  const variant = { hitboxes: [], movement: [] };
  return {
    id,
    slot,
    name: id.replace(/-/g, ' '),
    frame: { startup: s, active: a, recovery: r, cancelWindow: 0.4, chargeMax: 0, hitstop: 8 },
    variants: { up: variant, forward: variant, down: variant },
    resourceCost: 0,
    meterCost: 0,
    tags: [],
  };
}

export function fakeFighter(o: FakeFighterOpts): {
  def: TitanDef;
  view: FighterView;
  moveById: (id: string) => MoveDef | undefined;
} {
  const info = FIXTURE_TITANS.find((t) => t.id === o.titan)!;
  const port = fixturePortraitProvider(o.titan);
  const frac = o.massFrac ?? 1;
  const map = createMatterMap(port.w, port.h);
  map.baseColor.set(port.pixels);
  map.pixels.set(frac >= 0.999 ? port.pixels : carve(port, frac, o.slot * 17 + o.titan.length));
  map.version = 1;
  const stats: BodyStats = {
    mass: 100 * frac,
    initialMass: 100,
    massFrac: frac,
    cells: 1,
    initialCells: 1,
    coreIntegrity: Math.min(1, 0.3 + frac),
    anchoredFrac: 1,
    exposedCoreFrac: 1 - frac,
    burningCells: 0,
    infectedCells: 0,
    crackedCells: 0,
    massGained: 0,
    massLost: 0,
    regionGrid: new Float32Array(64).fill(frac),
  };
  const body = {
    id: o.slot,
    kind: 'titan',
    ownerSlot: o.slot,
    map,
    materials: [],
    transform: { x: 0, y: 0, anchorX: 0, anchorY: 0, facing: o.slot === 0 ? 1 : -1, lean: 0 },
    attributes: info.attributes,
    cohesionScale: 1,
    heatScale: 1,
  } as unknown as MatterBody;
  const moves = [
    fakeMove('tendril-lash', 'strike', 12, 6, 16),
    fakeMove('shatter-blow', 'crush', 30, 8, 44),
    fakeMove('sidestep', 'surge', 4, 12, 10),
  ];
  const def = {
    id: o.titan,
    name: info.name,
    nameKo: info.nameKo,
    epithet: info.epithet,
    attributes: info.attributes,
    resource: {
      id: 'tendrils',
      name: info.resource.name,
      nameKo: info.resource.nameKo,
      max: info.resource.max,
      start: info.resource.max,
      display: info.resource.display,
    },
    destruction: info.destruction,
    passive: info.passive,
    failureMode: info.failureMode,
    materials: [],
    art: { w: port.w, h: port.h, coreX: 0, coreY: 0, coreRadius: 6, params: {} },
    moves,
    ai: { weights: {}, style: '' },
    ui: { accent: info.accent, accent2: info.accent2, tagline: info.tagline },
  } as TitanDef;
  const total = o.moveTotal ?? 0;
  const view = {
    slot: o.slot,
    titan: o.titan,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facing: o.slot === 0 ? 1 : -1,
    boundsX0: 0,
    boundsY0: 0,
    boundsX1: 0,
    boundsY1: 0,
    state: o.state ?? 'idle',
    moveId: o.moveId ?? null,
    moveSlot: null,
    aim: 'forward',
    phase: o.phase ?? null,
    moveTick: o.moveTick ?? 0,
    phaseTick: 0,
    moveTotal: total,
    chargeFrac: 0,
    cancellable: false,
    hitstunTicks: o.hitstun ?? 0,
    guardUp: !!o.guardUp,
    guardHealth: 0.72,
    intangible: false,
    stats: noStats,
    bodyStats: stats,
    integrityPct: Math.round(Math.max(0, Math.min(100, ((frac - 0.22) / 0.78) * 100))),
    resource: o.resource ?? info.resource.max * 0.7,
    resourceMax: info.resource.max,
    meter: o.meter ?? 0.42,
    ko: false,
    threats: [],
    parts: 3,
    lensRadius: 0,
    lensStrength: 0,
    freezeTicks: 0,
    body,
  } as unknown as FighterView;
  return { def, view, moveById: (id) => moves.find((m) => m.id === id) };
}

export interface FakeHudOpts {
  a?: FakeFighterOpts;
  b?: FakeFighterOpts;
  phase?: RoundPhase;
  phaseTick?: number;
  round?: number;
  wins?: [number, number];
  ticksLeft?: number;
  announcer?: string | null;
  training?: boolean;
  paused?: boolean;
  mode?: 'versus' | 'vsai' | 'training' | 'attract';
  tick?: number;
}

/** A structurally sufficient HudState for the UI (the UI reads only what a real one exposes). */
export function fakeHud(o: FakeHudOpts = {}): HudState {
  const fa = fakeFighter({ slot: 0, titan: 'lastone', ...o.a });
  const fb = fakeFighter({ slot: 1, titan: 'asteroid', ...o.b });
  const match = {
    config: {
      seed: 1,
      stage: 'nursery',
      mode: o.mode ?? 'versus',
      slots: [
        { titan: fa.def.id, controller: 'human' },
        { titan: fb.def.id, controller: o.mode === 'training' ? 'dummy' : 'human' },
      ],
    },
    fighters: [
      { slot: 0, def: fa.def, view: fa.view, moveById: fa.moveById },
      { slot: 1, def: fb.def, view: fb.view, moveById: fb.moveById },
    ],
    tick: o.tick ?? 600,
    phase: o.phase ?? 'fight',
    phaseTick: o.phaseTick ?? 200,
    round: o.round ?? 1,
    wins: o.wins ?? [0, 0],
    winner: -1,
    roundTicksLeft: o.ticksLeft ?? 62 * 60,
    hitstopTicks: 0,
    timeScale: 1,
    events: [],
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
    stage: 'nursery',
  } as unknown as MatchApi;
  return {
    match,
    round: o.round ?? 1,
    wins: o.wins ?? [0, 0],
    roundTicksLeft: o.ticksLeft ?? 62 * 60,
    phase: o.phase ?? 'fight',
    announcer: o.announcer ?? null,
    training: !!o.training,
    paused: !!o.paused,
  };
}
