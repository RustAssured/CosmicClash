import {
  angleToStep,
  DamageFlag,
  makeLayer,
  rgba,
  type BlowWeight,
  type DamageEvent,
  type FighterTickCtx,
  type MatterBody,
  type MatterWorld,
  type OverlapResult,
  type MatterMap,
  type MoveSlot,
  type RenderLayer,
  type RenderPart,
  type ViewRect,
} from '@/contracts';
import { registerDiagnostics, registerTuning, type DiagCtx, type TuningKnob } from '@/debug/tuning';
import { cloneUriMap, URI_MATERIALS, URI_PRIMARY, type UriTitanRig } from '@/titans';
import {
  apply,
  bodyTransforms,
  emptyPlaces,
  placeParts,
  URI_COLD_CORE,
  URI_HOT_CORE,
  URI_ORDER,
  uriPart,
  type UriPartKey,
  type UriPlaces,
  type UriPose,
} from '@/titans/uri/rig';
import type { RenderLayerLit } from '@/render/unified';
import type { UriLiveFx, UriPylon } from '@/render/uriLive';
import { URI_MAT } from '@/titans/uri/maps';
import { Behaviour } from '../behaviour';
import { addDamageResult, type DamageSum } from '../damageSum';
import { makeFatShape, type FatShape } from '../shapes';
import type { UriBlow } from '@/titans/uri/def';
import type { ActiveMove } from '../move';
import { UriKinetics, type UriKineticView, type UriMoveName, type UriTune } from '../uri/kinetics';
import type { FighterImpl } from '../fighter';

/**
 * 우리 (URI) in the game, Phase 2A (uri/docs/URI_SPEC.md §3–5): a multi-body fighter like the Witness.
 *
 * - **Bodies:** the pelvis is the fighter's primary body (the rig's root); the other 12 parts of `uri/data/uri_rig.json` are
 *   region bodies, created through the world with their pivot (rounded to a cell corner) as the anchor and registered with
 *   `addRegion`.
 * - **Rig:** `src/titans/uri/rig.ts` composes the hierarchy parent → child (hips → pylons; torso → chamber, cores, moon anchor;
 *   ark → upper arm → forearm → fist) from a pose of links. 2A holds the pose at rest; 2B's kinetic system drives it.
 * - **Never mirrored** (spec §5): every body (the primary included) and every layer is drawn with facing +1 whatever side the
 *   opponent is on. The fighter's own facing still says where the opponent is (the kinetic system reads arm roles from it).
 * - **Draw order** (spec §4): pylons behind the pelvis (the fighter's own body layer), everything else in front of it, in the
 *   asset's order: upper arms, domes, chamber, forearms, fists, moon.
 * - **Diagnostics** (spec §9, the debug overlay): centre of mass, barycentre of the cores, part pivots, the target vector.
 * - **Damage** (2C, spec §7): the loop is the health; a blow tears the struck chunk out (S4's chunk groups), necks fail and send
 *   the hanging chain away whole, a limb / pylon / moon at half goes in pieces, loop 0 breaks everything apart around the cores.
 */

/** A region the fighter owns besides its primary body. */
interface Region {
  key: UriPartKey;
  body: MatterBody;
  /** Pivot corner in the map (integer) and the fractional pivot it stands for. */
  ax: number;
  ay: number;
  /** Atlas placement. */
  sx: number;
  sy: number;
  version: number;
  part: RenderPart;
  back: boolean;
  /** Left the body (severed or shattered): no longer placed, drawn or hit. */
  lost: boolean;
  /** The load-bearing neck's cells (map indices) for a part carried by a neck (the oracle's `prepParts`), else null. */
  neck: Int32Array | null;
}

/** Mass properties of a part in its local grid: cell count, centroid and second moment about the centroid. */
interface PartMass {
  m: number;
  cx: number;
  cy: number;
  i2: number;
}

const ATLAS_ROW = 1024;
/** Pylons are drawn behind the pelvis (the primary); every other part in front of it. */
const BACK_PARTS: readonly UriPartKey[] = ['pyL', 'pyR'];

/**
 * A blow's power in the oracle's terms (TUNING "Damage": the loop loses 3 × power per hit) from the weight it landed with
 * (proposal 171). The values are the powers the oracle itself hits with: its light and heavy demo hits (1.1 / 2.2), a click
 * (1.6), its test-hit button (2.4).
 */
export const URI_HIT_POWER: Readonly<Record<BlowWeight, number>> = {
  light: 1.1,
  medium: 1.6,
  heavy: 2.2,
  catastrophic: 2.4,
};
/** TUNING "Damage": a neck below this fails; a limb / pylon / moon below half of itself goes in pieces. */
const NECK_FAIL = 0.38;
const HALF_RULE = 0.5;
/** The load-bearing connections (the oracle's `prepParts`): the part, the joint it is carried by, the neck radius (px). */
const NECKS: readonly [UriPartKey, 'ja' | 'jb', UriPartKey, number][] = [
  ['uaL', 'ja', 'uaL', 13],
  ['faL', 'ja', 'faL', 13],
  ['fistL', 'jb', 'faL', 14],
  ['uaR', 'ja', 'uaR', 13],
  ['faR', 'ja', 'faR', 13],
  ['fistR', 'jb', 'faR', 14],
  ['pyL', 'ja', 'pyL', 12],
  ['pyR', 'ja', 'pyR', 12],
];
/** What hangs from each neck and drifts away with it. */
const CHAIN: Partial<Record<UriPartKey, readonly UriPartKey[]>> = {
  uaL: ['uaL', 'faL', 'fistL'],
  faL: ['faL', 'fistL'],
  fistL: ['fistL'],
  uaR: ['uaR', 'faR', 'fistR'],
  faR: ['faR', 'fistR'],
  fistR: ['fistR'],
  pyL: ['pyL'],
  pyR: ['pyR'],
};
/** Domes and chamber stay whatever they lose (spec §7). (The pelvis follows the 50 % rule: `routeDamage`.) */
const KEEPS: readonly UriPartKey[] = ['chamber', 'domeL', 'domeR'];
const MAT_HABITAT = URI_MATERIALS.findIndex((m) => m.key === 'habitat') + 1;
const MAT_CRACK = URI_MATERIALS.findIndex((m) => m.key === 'crack') + 1;
/** Who takes a blow first: the front atlas top part down, then the pelvis (the fighter's own layer), then the pylons behind. */
const FRONT_TO_BACK: readonly UriPartKey[] = [
  ...URI_ORDER.filter((k) => k !== URI_PRIMARY && !BACK_PARTS.includes(k)).reverse(),
  URI_PRIMARY,
  ...URI_ORDER.filter((k) => BACK_PARTS.includes(k)).reverse(),
];

/**
 * S4's chunk groups (src/matter/groups.ts, MatterWorldEx; Gate 2C): optional on the contract's world, like `bodyToChunk`.
 * Without them 우리 takes blows the default way (the loop still loses integrity).
 */
type GroupWorld = MatterWorld & {
  setCellGroups?(bodyId: number, groups: Uint16Array): boolean;
  setFieldHeld?(bodyId: number, on: boolean): boolean;
  hitTear?(bodyId: number, wx: number, wy: number, power: number): number;
  groupAt?(bodyId: number, wx: number, wy: number): number;
  releaseGroups?(bodyId: number, fx: number, fy: number, power: number, maxPieces?: number): number;
  releaseBudgets?(bodyIds: readonly number[]): number[];
  liveFraction?(bodyId: number, cells: ArrayLike<number>): number;
};

/** The break-apart (the oracle's `breakApart`): the loop snaps, everything flies apart slowly around the two cores. */
const BREAK = {
  /** Tear power of the pieces: the chamber 0.35, every other part 0.55. */
  chamber: 0.35,
  rest: 0.55,
  /** The oracle's slowmo = 0.3, recovering at +0.35 per second: back to 1 after 2 s (120 ticks). */
  timeScale: 0.3,
  timeScaleTicks: 120,
  /** The oracle's shake = 14 (px). */
  shake: 14,
  /** Parts released per tick (S4: ~35 ms all in one tick); the chamber (≈220 pieces) gets a tick of its own. */
  perTick: 2,
  /** …and at most this many pieces a tick unless one part alone has more (S4: ~0.05 ms a piece → ≤ ~6 ms). */
  piecesPerTick: 120,
} as const;
/** A neck failing (the oracle's `hitAt`): shake = 8; the hanging chain drifts at (U − 0.5)·1.2, 0.3 + 0.3·U px per frame. */
const NECK_SHAKE = 8;
/** A limb that lost half of itself goes in pieces with tear power 1.2 (the oracle's `shatterPart(P, x, y, 1.2)`). */
const SHATTER_POWER = 1.2;
/**
 * A CONTINUOUS blow (energy per tick) counts as one hit per second of contact. PROVISIONAL: the oracle has no continuous blows;
 * 우리's opponents in the slice have none either.
 */
const CONTINUOUS_HIT_TICKS = 60;
/** Intent buffer (2D): a move waits this long at most for the committed blow before it to land (0.75 s). */
const PENDING_MAX = 45;
const PENDING_ID: Record<UriMoveName, number> = { punch: 1, cross: 2, slam: 3, upper: 4 };
/** The fighter's move for each kinetic move (D31-2). */
const MOVE_OF: Record<UriMoveName, { id: string; slot: MoveSlot }> = {
  punch: { id: 'uri.punch', slot: 'strike' },
  cross: { id: 'uri.cross', slot: 'crush' },
  upper: { id: 'uri.upper', slot: 'signature' },
  slam: { id: 'uri.slam', slot: 'ultimate' },
};

const DIAG = {
  cm: rgba(255, 238, 170),
  bary: rgba(170, 200, 255),
  pivot: rgba(255, 150, 90),
  target: rgba(150, 230, 170),
  text: rgba(230, 236, 245),
  cone: rgba(255, 210, 122),
  pylon: rgba(159, 243, 255),
};

export class UriBehaviour extends Behaviour {
  private regions: Region[] = [];
  private readonly byKey = new Map<UriPartKey, Region>();
  private back!: RenderLayer;
  private front!: RenderLayer;
  /** The kinetic system (2B) and the pose of the links it drives. */
  private kin!: UriKinetics;
  private pose!: UriPose;
  readonly kview: UriKineticView = {
    move: null,
    phase: null,
    lead: null,
    rear: null,
    loop: { l: 1, r: 1, sh: 0, vt: 1, br: 1 },
    stress: 0,
    torque: 0,
    core: { x: 0, y: 0 },
    pylon: { L: { th: 0, ang: 0 }, R: { th: 0, ang: 0 } },
    moon: null,
    spread: { L: 1.14, R: 1.14 },
  };
  /** The tick the kinetic system last advanced (placeRegions may run twice in a tick). */
  private kinTick = -1;
  /** Where every part is (reference coordinates), and the reference → world offset of this tick. */
  readonly places: UriPlaces = emptyPlaces();
  private ox = 0;
  private oy = 0;
  /** The root the fighter last wrote into the primary's transform, and what this behaviour wrote back. */
  private rootX = 0;
  private rootY = 0;
  private wroteX = NaN;
  private wroteY = NaN;
  private readonly mass = new Map<UriPartKey, PartMass>();
  /** World centre of mass of the whole body (diagnostics, massFrame). */
  readonly cm = { x: 0, y: 0, gyration: 0, radius: 0 };
  private readonly hot = { x: 0, y: 0 };
  private readonly cold = { x: 0, y: 0 };
  /** What S5's live pass draws (cores, loop, orbit, fist field), refreshed every frame. */
  private readonly live: UriLiveFx = {
    hotX: 0,
    hotY: 0,
    coldX: 0,
    coldY: 0,
    hotR: Math.round(URI_HOT_CORE[2]),
    coldR: Math.round(URI_COLD_CORE[2]),
    t: 0,
    spin: 0,
    hp: 100,
    loop: { l: 1, r: 1, sh: 0, vt: 1, br: 1, stress: 0, gain: 1 },
    afterZ: URI_ORDER.indexOf('chamber'),
    fistSpread: [1.14, 1.14],
  };
  private untune: (() => void) | null = null;
  /** Atlas placement of every region part (fixed: a regrown part goes back where it was). */
  private readonly atlasAt = new Map<UriPartKey, [number, number]>();
  /** The pelvis's shade plane on the fighter's own body layer (a copy: wound cells re-code it) and its map version. */
  private bodyShade: Uint8Array | null = null;
  private bodyVersion = -1;
  /** Part integrity (live cells / pristine cells; 0 once lost), refreshed once per tick for the kinetic system. */
  private readonly integ = new Map<UriPartKey, number>();
  /** The hits' own random stream (mulberry32 state; hashed). */
  private rs = 0;
  /** CONTINUOUS contact ticks toward the next counted hit. */
  private contTicks = 0;
  /**
   * Ticks of CONTINUOUS contact that count as one hit on the loop. PROVISIONAL (the oracle has no continuous blows): a
   * debug-overlay knob marked "to tune", not a final number.
   */
  contHitTicks = CONTINUOUS_HIT_TICKS;
  /** Multiplier on the fists' provisional blow energies (`UriBlow`, def.ts): a debug-overlay knob for the balance pass. */
  powerMul = 1;
  /** The blow (foe move instance) that last cost the loop, and the power it cost it at. */
  private blowInst: string | null = null;
  private blowPower = 0;
  private blowAt = -1e9;
  /**
   * Hits of one move within this many ticks count as one blow on the loop. PROVISIONAL (no oracle number: the oracle's hits
   * are single; the game's moves have many volumes): a debug-overlay knob marked "to tune".
   */
  blowTicks = 45;
  /** The pelvis went in pieces (50 % rule). */
  private pelvisLost = false;
  /**
   * Intent (2D): a move pressed while the kinetic system is still committed to the last one (before its impact) waits here and
   * begins as soon as that blow has landed: it then grows out of the follow-through / taper (spec §6.3, §10). Kept at most
   * PENDING_MAX ticks.
   */
  private pending: UriMoveName | null = null;
  private pendingAt = 0;
  /** The loop has snapped (break-apart), the parts still to release, their piece budgets, and the cores' frozen world spots. */
  private broken = false;
  private releaseQueue: UriPartKey[] = [];
  private readonly budgets = new Map<UriPartKey, number>();
  private readonly coreAt = { hx: 0, hy: 0, cx: 0, cy: 0 };
  private readonly pylons: [UriPylon, UriPylon] = [
    { x: 0, y: 0, a: Math.PI / 2, th: 0 },
    { x: 0, y: 0, a: Math.PI / 2, th: 0 },
  ];
  private readonly ov: OverlapResult = {
    cells: 0,
    x: NaN,
    y: NaN,
    nearestX: NaN,
    nearestY: NaN,
    coverage: 0,
  };

  constructor(f: FighterImpl) {
    super(f);
  }

  /** Never mirrored (spec §5): arm roles come from the opponent's side, the body is drawn and hit as authored. */
  override mirrors(): boolean {
    return false;
  }

  private get gw(): GroupWorld {
    return this.f.world as GroupWorld;
  }

  /** Mulberry32 over the behaviour's own state (hashed). */
  private rand(): number {
    this.rs = (this.rs + 0x6d2b79f5) | 0;
    let t = Math.imul(this.rs ^ (this.rs >>> 15), 1 | this.rs);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  override attach(): void {
    const f = this.f;
    const rig = f.rig as UriTitanRig;
    // the atlases: every region map packed in rows (pylons in the back atlas, the rest in the front one)
    const pack = (
      keys: readonly UriPartKey[],
    ): { w: number; h: number; at: Map<UriPartKey, [number, number]> } => {
      let x = 0;
      let y = 0;
      let rowH = 0;
      const at = new Map<UriPartKey, [number, number]>();
      for (const k of keys) {
        const p = uriPart(k);
        if (x + p.w > ATLAS_ROW) {
          x = 0;
          y += rowH;
          rowH = 0;
        }
        at.set(k, [x, y]);
        x += p.w;
        rowH = Math.max(rowH, p.h);
      }
      return { w: ATLAS_ROW, h: y + rowH, at };
    };
    const regionKeys = URI_ORDER.filter((k) => k !== URI_PRIMARY);
    const backKeys = regionKeys.filter((k) => BACK_PARTS.includes(k));
    const frontKeys = regionKeys.filter((k) => !BACK_PARTS.includes(k));
    const pb = pack(backKeys);
    const pf = pack(frontKeys);
    this.back = makeLayer(`uri-back-${f.slot}`, 'world', -0.5, pb.w, pb.h);
    this.front = makeLayer(`uri-front-${f.slot}`, 'world', 0.5, pf.w, pf.h);
    for (const L of [this.back, this.front]) {
      L.emissive = new Uint8Array(L.w * L.h);
      L.parts = [];
      L.facing = 1;
    }
    this.regions = [];
    this.byKey.clear();
    this.atlasAt.clear();
    for (const k of backKeys) this.atlasAt.set(k, pb.at.get(k)!);
    for (const k of frontKeys) this.atlasAt.set(k, pf.at.get(k)!);
    for (const k of regionKeys) this.createRegion(k, false);
    // the primary carries its chunk ids too (it tears like every part)
    this.gw.setCellGroups?.(f.body.id, rig.parts.find((p) => p.key === URI_PRIMARY)!.chunks);
    this.gw.setFieldHeld?.(f.body.id, true);
    for (const p of rig.parts) this.mass.set(p.key, massOf(p.map));
    this.packPlanes(rig);
    this.kin = new UriKinetics(f.seed);
    this.kin.integrity = (k) => this.integ.get(k) ?? 1;
    this.kin.gone = (k) => this.byKey.get(k)!.lost;
    this.resetDamage();
    this.pose = this.kin.currentPose();
    this.kinTick = -1;
    this.wroteX = NaN;
    this.place();
    this.registerDebug();
  }

  /**
   * Create part `k`'s matter body and its atlas part (attach, or grown back between rounds after it left), with its chunk ids
   * (S4's cell groups: what a blow tears out) and its load-bearing neck.
   */
  private createRegion(k: UriPartKey, regrown: boolean): void {
    const f = this.f;
    const rig = f.rig as UriTitanRig;
    const src = rig.parts.find((p) => p.key === k)!;
    const meta = uriPart(k);
    const map = cloneUriMap(src.map);
    const ax = Math.round(meta.pivX);
    const ay = Math.round(meta.pivY);
    const body = f.world.createBody({
      kind: 'part',
      ownerSlot: f.slot,
      map,
      materials: f.body.materials,
      attributes: f.def.attributes,
      seed: f.seed + 1009 * (URI_ORDER.indexOf(k) + 1),
      transform: { x: 0, y: 0, anchorX: ax, anchorY: ay, facing: 1, lean: 0, rot: 0 },
      anchorCells: anchorPatch(map, ax, ay),
      takesDebrisImpacts: true,
      sampler: 'majority4', // proposal 174 (S4): hit-tested with 우리's own rotation rule
    });
    this.gw.setCellGroups?.(body.id, src.chunks);
    // held by fields (URI_SPEC §1): a piece a hole cuts off stays put; matter leaves only by tears and releases (S4)
    this.gw.setFieldHeld?.(body.id, true);
    f.addRegion(body, true, regrown);
    const isBack = BACK_PARTS.includes(k);
    const [sx, sy] = this.atlasAt.get(k)!;
    const part: RenderPart = {
      sx,
      sy,
      sw: map.w,
      sh: map.h,
      px: ax,
      py: ay,
      wx: 0,
      wy: 0,
      step: 0,
      z: URI_ORDER.indexOf(k),
      sampler: 'majority4', // proposal 174 (S4): drawn with the same rule it is hit with
    };
    (isBack ? this.back : this.front).parts!.push(part);
    const reg: Region = {
      key: k,
      body,
      ax,
      ay,
      sx,
      sy,
      version: -1,
      part,
      back: isBack,
      lost: false,
      neck: uriNeckCells(k, map),
    };
    const old = this.byKey.get(k);
    if (old) this.regions[this.regions.indexOf(old)] = reg;
    else this.regions.push(reg);
    this.byKey.set(k, reg);
  }

  /**
   * The part pass's static planes (S5, proposal 172 extension): per atlas cell `light` (nx, ny, nz, form), `shade` (surf, tone,
   * edge, material code) and `chunk` (the fists are drawn chunk by chunk), at the same (sx, sy) as the pixels. The primary
   * (pelvis) is drawn by the fighter's own body layer: it gets its part's planes in `decorateBodyLayer`. Wound cells (habitat /
   * crack) are re-coded in the shade plane whenever a part's map changes (`recode`).
   */
  private packPlanes(rig: UriTitanRig): void {
    for (const L of [this.back, this.front] as RenderLayerLit[]) {
      L.light = new Uint8Array(L.w * L.h * 4);
      L.shade = new Uint8Array(L.w * L.h * 4);
      L.chunk = new Uint16Array(L.w * L.h);
    }
    for (const r of this.regions) {
      const src = rig.parts.find((p) => p.key === r.key)!;
      const L = (r.back ? this.back : this.front) as RenderLayerLit;
      const w = src.map.w;
      for (let y = 0; y < src.map.h; y++) {
        const s = y * w;
        const d = (r.sy + y) * L.w + r.sx;
        L.light!.set(src.light.subarray(s * 4, (s + w) * 4), d * 4);
        L.shade!.set(src.shade.subarray(s * 4, (s + w) * 4), d * 4);
        L.chunk!.set(src.chunks.subarray(s, s + w), d);
      }
    }
  }

  /** The pelvis's planes on the fighter's own body layer (S1's hook, 57afe0a); its shade plane is a copy (wounds re-code it). */
  override decorateBodyLayer(layer: RenderLayer): void {
    const pel = (this.f.rig as UriTitanRig).parts.find((p) => p.key === URI_PRIMARY)!;
    const L = layer as RenderLayerLit;
    this.bodyShade = pel.shade.slice();
    L.light = pel.light;
    L.shade = this.bodyShade;
    L.chunk = pel.chunks;
    this.bodyVersion = -1;
  }

  override reset(_heal: number): void {
    // the fighter heals every region body still attached; the parts that left grow back; the kinetic system starts at rest
    for (const r of [...this.regions]) if (r.lost) this.createRegion(r.key, true);
    this.kin.reset(this.f.seed);
    this.resetDamage();
    this.pose = this.kin.currentPose();
    this.kinTick = -1;
    this.wroteX = NaN;
    this.place();
  }

  /** The damage state of a fresh round: the loop whole, nothing breaking, the hits' stream reseeded. */
  private resetDamage(): void {
    this.kin.hp = 100;
    this.broken = false;
    this.pelvisLost = false;
    this.pending = null;
    this.blowInst = null;
    this.blowPower = 0;
    this.blowAt = -1e9;
    this.releaseQueue = [];
    this.budgets.clear();
    this.contTicks = 0;
    this.rs = (this.f.seed ^ 0x5552) | 0;
    this.refreshIntegrity();
  }

  /** Each tick: the parts' integrity for the kinetic system, the break-apart's releases, the loop as the HUD's integrity. */
  override update(_ctx: FighterTickCtx): void {
    if (this.releaseQueue.length) this.releaseSome();
    this.showHealth();
  }

  /** The loop is 우리's health (D31-3, proposal 176): the fighter's HUD integrity and its KO read it directly. */
  override healthPct(): number | null {
    return this.kin ? this.kin.hp : 100;
  }
  /** The view between a blow and the fighter's next refresh (the fighter writes the same value on its own refresh). */
  private showHealth(): void {
    this.f.view.integrityPct = this.kin.hp;
  }

  /** Live cells / pristine cells per part (0 once it left), read by the kinetic system's integrity callbacks. */
  private refreshIntegrity(): void {
    const w = this.f.world;
    for (const r of this.regions) {
      if (r.lost) {
        this.integ.set(r.key, 0);
        continue;
      }
      const s = w.stats(r.body.id);
      this.integ.set(r.key, s.initialCells > 0 ? s.cells / s.initialCells : 0);
    }
    const p = w.stats(this.f.body.id);
    this.integ.set(URI_PRIMARY, p.initialCells > 0 ? p.cells / p.initialCells : 0);
  }

  /**
   * A move begins (2D intent): the kinetic system plays the authored move this slot maps to (D31-2), growing out of whatever
   * the body is doing (the links never reset). While the last blow is still committed (before its impact) the new one waits
   * (`pending`) and begins the moment that blow lands. Arm roles come from the opponent's side when it begins (`begin`).
   */
  override onMoveStart(m: ActiveMove): void {
    const name = m.def?.extra?.['uri'] as UriMoveName | undefined;
    if (!name || m.feint || this.broken) return;
    if (this.canGrow()) {
      this.kin.begin(name);
      this.pending = null;
    } else {
      this.pending = name;
      this.pendingAt = this.f.tickNo;
    }
  }

  /** A new move may begin now: at rest, or once the current blow has landed (follow-through, taper). */
  private canGrow(): boolean {
    const ph = this.kview.phase;
    return !this.kin.busy || ph === 'follow' || ph === 'taper';
  }

  /**
   * The blow lands (2D): when the kinetic system's striking arms ARRIVE (its impact), each acting fist strikes the foe with
   * its own matter (a disc over the fist's live bounds), with the move's provisional blow. Connected: the game's hit-stop
   * (the kinetic system's own hold, ×its hitstop knob) freezes the whole match, and the kinetic system's private hold is
   * dropped so the body is not held twice; missed: the body keeps its own hold and the oracle's shake.
   */
  override resolveVolumes(_ctx: FighterTickCtx): void {
    const imp = this.kin.takeImpact();
    if (!imp || this.broken) return;
    const f = this.f;
    const mv = MOVE_OF[imp.move];
    const def = f.moveById(mv.id);
    const blow = def?.extra?.['blow'] as UriBlow | undefined;
    if (!blow) return;
    const fists: UriPartKey[] =
      imp.move === 'slam'
        ? ['fistL', 'fistR']
        : [`fist${imp.move === 'cross' ? imp.rear : imp.lead}` as UriPartKey];
    let hit = false;
    for (const k of fists) {
      const r = this.byKey.get(k)!;
      if (r.lost || !f.world.liveBounds(r.body.id, this.fistBox)) continue;
      const b = this.fistBox;
      const s = this.fistShape;
      s.kind = 'point';
      s.x = (b.x0 + b.x1) * 0.5;
      s.y = (b.y0 + b.y1) * 0.5;
      s.r = Math.max(4, 0.5 * Math.min(b.x1 - b.x0, b.y1 - b.y0));
      const ok = f.strike(
        s,
        {
          type: 'KINETIC',
          energy: (blow.energy * this.powerMul) / fists.length,
          duration: 1,
          flags: 0,
          params: blow.params,
        },
        blow.knockback[0],
        blow.knockback[1],
        blow.guardPressure,
        Math.round(imp.hitstop * 60),
        mv.slot,
        mv.id,
      );
      hit = hit || ok;
    }
    if (hit) {
      // the match's freeze is the hold now (the kinetic system does not step while the match is frozen)
      f.events.push({ t: 'hitstop', ticks: Math.round(imp.hitstop * 60) });
      this.kin.hitstop = 0;
    } else f.events.push({ t: 'shake', dirX: 0, dirY: imp.move === 'slam' ? 1 : 0.3, amp: imp.shake });
  }

  private readonly fistBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly fistShape: FatShape = makeFatShape();

  /**
   * Called right after the primary's transform (and again after a contact moved the root): once per tick the kinetic system
   * advances (two 120 Hz substeps) toward the opponent, then every part goes where the rig says.
   */
  override placeRegions(): void {
    const f = this.f;
    if (f.tickNo !== this.kinTick) {
      this.kinTick = f.tickNo;
      // a buffered move begins the moment the blow before it has landed (or is dropped when it waited too long)
      if (this.pending) {
        if (this.canGrow()) {
          this.kin.begin(this.pending);
          this.pending = null;
        } else if (f.tickNo - this.pendingAt > PENDING_MAX) this.pending = null;
      }
      // the opponent, in the rig's reference space (the reference → world offset of the last placement)
      const fv = f.foe?.view;
      if (fv) this.kin.target = [fv.x - this.ox, fv.y - this.oy];
      this.refreshIntegrity();
      this.kin.step(1 / 60);
      this.pose = this.kin.currentPose();
      this.kin.view(this.kview);
    }
    this.place();
  }

  private place(): void {
    const f = this.f;
    const t = f.body.transform;
    // the root: what the fighter wrote this tick (a second call after a contact may bring a new one)
    if (t.x !== this.wroteX || t.y !== this.wroteY) {
      this.rootX = t.x;
      this.rootY = t.y;
    }
    placeParts(this.pose, this.places);
    // the command moon is not carried: the kinetic system tethers it (spec §6.6)
    const mv = this.kview.moon;
    if (mv) {
      this.places.moon.x = mv.x;
      this.places.moon.y = mv.y;
      this.places.moon.a = mv.a;
    }
    // reference → world: the primary's anchor cell sits on the fighter's root when the hips are at rest; the whole body
    // breathes with the oracle's slow idle bob (frame(): sin(t·0.37)·1.2, sin(t·0.53)·1.6)
    const pel = uriPart(URI_PRIMARY);
    const restAx = pel.x0 + t.anchorX;
    const restAy = pel.y0 + t.anchorY;
    const kt = this.kin ? this.kin.t : 0;
    this.ox = this.rootX - restAx + Math.sin(kt * 0.37) * 1.2;
    this.oy = this.rootY - restAy + Math.sin(kt * 0.53) * 1.6;
    // never mirrored (spec §5): the primary is drawn and hit as authored, whatever side the opponent is on
    this.writeTransform(t, this.places[URI_PRIMARY], pel.pivX, pel.pivY, t.anchorX, t.anchorY);
    t.facing = 1;
    t.lean = 0;
    this.wroteX = t.x;
    this.wroteY = t.y;
    for (const r of this.regions) {
      if (r.lost) continue;
      const meta = uriPart(r.key);
      const bt = r.body.transform;
      this.writeTransform(bt, this.places[r.key], meta.pivX, meta.pivY, r.ax, r.ay);
      bt.facing = 1;
      bt.lean = 0;
      r.part.wx = bt.x;
      r.part.wy = bt.y;
      r.part.step = bt.rot ?? 0;
    }
    // the world-cores ride the torso and jolt in their cradles, never leaving them (the cold one answers −0.7 / −0.6); once the
    // loop has snapped they stay where they were while everything else flies apart around them
    if (this.broken) {
      this.hot.x = this.coreAt.hx - this.ox;
      this.hot.y = this.coreAt.hy - this.oy;
      this.cold.x = this.coreAt.cx - this.ox;
      this.cold.y = this.coreAt.cy - this.oy;
    } else {
      const B = bodyTransforms(this.pose);
      const c = this.kview.core;
      apply(B.torso, URI_HOT_CORE[0] + c.x, URI_HOT_CORE[1] + c.y, this.hot);
      apply(B.torso, URI_COLD_CORE[0] - c.x * 0.7, URI_COLD_CORE[1] - c.y * 0.6, this.cold);
    }
    this.massCentre();
  }

  /** A body's transform from its part's place: the anchor cell's corner (ax, ay) goes where the pivot's rotation puts it. */
  private writeTransform(
    bt: MatterBody['transform'],
    pl: { x: number; y: number; a: number },
    pivX: number,
    pivY: number,
    ax: number,
    ay: number,
  ): void {
    const c = Math.cos(pl.a);
    const s = Math.sin(pl.a);
    const dx = ax - pivX;
    const dy = ay - pivY;
    bt.x = Math.round(this.ox + pl.x + dx * c - dy * s);
    bt.y = Math.round(this.oy + pl.y + dx * s + dy * c);
    bt.rot = angleToStep(pl.a);
  }

  /**
   * World centre of mass, radius of gyration and outer radius of the whole body: each part at its rest proportions weighted by
   * its integrity (live / pristine cells); a part that left counts for nothing.
   */
  private massCentre(): void {
    let M = 0;
    let sx = 0;
    let sy = 0;
    for (const k of URI_ORDER) {
      const pm = this.mass.get(k);
      const q = this.integ.get(k) ?? 1;
      if (!pm || pm.m <= 0 || q <= 0) continue;
      const meta = uriPart(k);
      const pl = this.places[k];
      const c = Math.cos(pl.a);
      const s = Math.sin(pl.a);
      const lx = pm.cx - meta.pivX;
      const ly = pm.cy - meta.pivY;
      sx += pm.m * q * (this.ox + pl.x + lx * c - ly * s);
      sy += pm.m * q * (this.oy + pl.y + lx * s + ly * c);
      M += pm.m * q;
    }
    const cx = M > 0 ? sx / M : this.rootX;
    const cy = M > 0 ? sy / M : this.rootY;
    let I = 0;
    let R = 0;
    for (const k of URI_ORDER) {
      const pm = this.mass.get(k);
      const q = this.integ.get(k) ?? 1;
      if (!pm || pm.m <= 0 || q <= 0) continue;
      const meta = uriPart(k);
      const pl = this.places[k];
      const c = Math.cos(pl.a);
      const s = Math.sin(pl.a);
      const lx = pm.cx - meta.pivX;
      const ly = pm.cy - meta.pivY;
      const wx = this.ox + pl.x + lx * c - ly * s - cx;
      const wy = this.oy + pl.y + lx * s + ly * c - cy;
      I += (pm.i2 + pm.m * (wx * wx + wy * wy)) * q;
      R = Math.max(R, Math.hypot(wx, wy) + Math.sqrt(pm.i2 / pm.m) * 1.5);
    }
    this.cm.x = cx;
    this.cm.y = cy;
    this.cm.gyration = M > 0 ? Math.sqrt(I / M) : 0;
    this.cm.radius = R;
  }

  override massFrame(out: { x: number; y: number; gyration: number; radius: number }): boolean {
    out.x = this.cm.x;
    out.y = this.cm.y;
    out.gyration = this.cm.gyration;
    out.radius = this.cm.radius;
    return true;
  }

  /** The kinetic system (the loop's hp included) and the damage state are simulation state: fold them into the match hash. */
  override hash(h: number): number {
    let x = this.kin.hash(h);
    x = Math.imul(x ^ this.rs, 0x01000193);
    x = Math.imul(
      x ^ (this.contTicks | (this.broken ? 1 << 16 : 0) | (this.pelvisLost ? 1 << 17 : 0)),
      0x01000193,
    );
    x = Math.imul(x ^ (this.pending ? PENDING_ID[this.pending] : 0) ^ (this.pendingAt << 4), 0x01000193);
    x = Math.imul(x ^ this.blowAt ^ Math.round(this.blowPower * 10), 0x01000193);
    x = Math.imul(x ^ this.releaseQueue.length, 0x01000193);
    for (const r of this.regions) x = Math.imul(x ^ (r.lost ? 1 : 2), 0x01000193);
    return x >>> 0;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  damage and breaking (URI_SPEC §7, TUNING "Damage", the oracle's 30_breaking_compose.js)
   * ---------------------------------------------------------------------------------------------- */

  /**
   * A blow (the oracle's `hitAt`): the front-most part under it takes it. Its struck chunk tears out as a tumbling piece with its
   * own colours, a heavy blow takes neighbouring chunks, the hole's border glows (S4's `hitTear`). The loop loses 3 × power.
   * Then the struck part's load-bearing neck may fail (the chain hanging from it drifts away whole), a limb / pylon / moon that
   * has lost half of itself goes in pieces, and a loop at 0 breaks 우리 apart.
   */
  override routeDamage(ev: DamageEvent, out: DamageSum): boolean {
    const f = this.f;
    const w = this.gw;
    if (this.broken || !w.hitTear) return false;
    // the front-most part under the blow: the front atlas (top part first), the pelvis, the pylons behind it
    const ov = this.ov;
    let key: UriPartKey | null = null;
    let id = -1;
    for (const k of FRONT_TO_BACK) {
      if (k === URI_PRIMARY ? this.pelvisLost : this.byKey.get(k)!.lost) continue;
      const bid = k === URI_PRIMARY ? f.body.id : this.byKey.get(k)!.body.id;
      w.overlap(bid, ev.shape, ov);
      if (ov.cells > 0) {
        key = k;
        id = bid;
        break;
      }
    }
    if (key === null) return false;
    const power = URI_HIT_POWER[ev.weight ?? 'medium'];
    // a CONTINUOUS blow counts as one hit per second of contact
    let counts = true;
    if ((ev.flags & DamageFlag.CONTINUOUS) !== 0) {
      counts = ++this.contTicks >= this.contHitTicks;
      if (counts) this.contTicks = 0;
    }
    const s0 = w.stats(id);
    const cells0 = s0.cells;
    const mass0 = s0.mass;
    let hx = ov.nearestX;
    let hy = ov.nearestY;
    if (counts) {
      const at = this.tearAt(id, power);
      hx = at.x;
      hy = at.y;
    }
    const s1 = w.stats(id);
    // what the fighter learns (DamageResult): the contract's impulse 30·√(energy·sourceMass)·√coverage along the blow
    const J =
      30 *
      Math.sqrt(Math.max(0, ev.energy) * Math.max(0, ev.sourceMass)) *
      Math.sqrt(Math.min(1, ov.coverage));
    addDamageResult(out, {
      cellsTouched: ov.cells,
      cellsRemoved: Math.max(0, cells0 - s1.cells),
      massRemoved: Math.max(0, mass0 - s1.mass),
      massTransferred: 0,
      contactX: hx,
      contactY: hy,
      impulseX: ev.dirX * J,
      impulseY: ev.dirY * J,
      onDamagedFraction: 0,
      revealedInterior: false,
    });
    if (!counts) return true;
    // the loop pays once per BLOW (the oracle's "one hit"), not once per hit volume: a sweep's blades, a halo's shards or a
    // volley of delayed fractures each tear their chunk, but the hits of one move within `blowTicks` of the first cost the
    // loop as one blow (at the heaviest volume's power). A hit without a move (debris, a hazard) is a blow of its own.
    const mid = (f as unknown as { incomingMoveId?: string }).incomingMoveId ?? '';
    const same = mid !== '' && mid === this.blowInst && f.tickNo - this.blowAt <= this.blowTicks;
    if (!same) {
      this.blowInst = mid === '' ? null : mid;
      this.blowAt = f.tickNo;
      this.blowPower = power;
      this.kin.hp = Math.max(0, this.kin.hp - 3 * power);
    } else if (power > this.blowPower) {
      this.kin.hp = Math.max(0, this.kin.hp - 3 * (power - this.blowPower));
      this.blowPower = power;
    }
    if (key !== URI_PRIMARY) {
      const r = this.byKey.get(key)!;
      if (CHAIN[key] && r.neck && (w.liveFraction?.(id, r.neck) ?? 1) < NECK_FAIL) this.severChain(key);
      else if (!KEEPS.includes(key) && s1.initialCells > 0 && s1.cells / s1.initialCells < HALF_RULE)
        this.shatter(r, hx, hy, SHATTER_POWER);
    } else if (!this.pelvisLost && s1.initialCells > 0 && s1.cells / s1.initialCells < HALF_RULE) {
      // the oracle's 50 % rule holds for the pelvis too (proposal 176: the loop, not the matter, is the KO now): it goes in
      // pieces; the fighter keeps its (empty) primary as the frame it moves, and the rig keeps placing the rest
      this.pelvisLost = true;
      w.releaseGroups?.(f.body.id, hx, hy, SHATTER_POWER);
    }
    this.refreshIntegrity();
    if (this.kin.hp <= 0) this.breakApart();
    this.showHealth();
    return true;
  }

  /**
   * Tear at the blow's contact: the overlap's nearest cell, its centroid, then the cells around the nearest one (a rotated
   * part's sampled cell may sit on a hole's edge). Returns the world point it tore at.
   */
  private tearAt(id: number, power: number): { x: number; y: number } {
    const w = this.gw;
    const ov = this.ov;
    const tries: [number, number][] = [
      [ov.nearestX, ov.nearestY],
      [ov.x, ov.y],
    ];
    for (let r = 1; r <= 3; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) tries.push([ov.nearestX + dx, ov.nearestY + dy]);
    for (const [x, y] of tries) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (w.groupAt && w.groupAt(id, x, y) < 0) continue;
      if (w.hitTear!(id, x, y, power) > 0) return { x, y };
    }
    return { x: ov.nearestX, y: ov.nearestY };
  }

  /** A part leaves the fighter (its pristine mass keeps counting toward KO) and the drawing. */
  private loseRegion(r: Region): void {
    r.lost = true;
    this.f.removeRegion(r.body.id);
    const parts = (r.back ? this.back : this.front).parts!;
    const i = parts.indexOf(r.part);
    if (i >= 0) parts.splice(i, 1);
    this.integ.set(r.key, 0);
  }

  /** A load-bearing neck failed: everything hanging from it drifts away whole, slowly (one velocity for the whole chain). */
  private severChain(key: UriPartKey): void {
    const f = this.f;
    const vx = (this.rand() - 0.5) * 1.2 * 60;
    const vy = (0.3 + this.rand() * 0.3) * 60;
    const va = (this.rand() - 0.5) * 0.25 * 0.6;
    for (const k of CHAIN[key]!) {
      const r = this.byKey.get(k)!;
      if (r.lost) continue;
      this.loseRegion(r);
      if (f.world.bodyToChunk) f.world.bodyToChunk(r.body.id, vx, vy, va);
    }
    f.events.push({ t: 'shake', dirX: 0, dirY: 1, amp: NECK_SHAKE });
  }

  /** A part goes in pieces (the 50 % rule, the break-apart): every chunk it still has tears out, flung from (x, y). */
  private shatter(r: Region, x: number, y: number, power: number, maxPieces?: number): void {
    const f = this.f;
    const w = this.gw;
    this.loseRegion(r);
    if (w.releaseGroups) w.releaseGroups(r.body.id, x, y, power, maxPieces);
    // the emptied body leaves the world (or, without chunk groups, the whole part goes as one piece)
    if (f.world.bodyToChunk) f.world.bodyToChunk(r.body.id, 0, 0, 0);
  }

  /**
   * The loop snaps (the oracle's `breakApart`): a white flash and a ring at the hot core, time slows to 0.3×, and every part
   * flies apart into its chunks, slowly, around the two cores, which stay where they were. The releases are spread over ticks
   * (two parts a tick, the chamber on a tick of its own; S4), the pelvis first so the fighter goes down at once.
   */
  private breakApart(): void {
    if (this.broken) return;
    const f = this.f;
    this.broken = true;
    this.kin.hp = 0;
    this.coreAt.hx = this.ox + this.hot.x;
    this.coreAt.hy = this.oy + this.hot.y;
    this.coreAt.cx = this.ox + this.cold.x;
    this.coreAt.cy = this.oy + this.cold.y;
    const x = this.coreAt.hx;
    const y = this.coreAt.hy;
    f.events.push({ t: 'flash', amount: 1, x, y });
    // S5's snap ring (src/app/fx.ts) keys on this cue at the hot core
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id: 'break-apart', x, y, amount: 1 });
    f.events.push({ t: 'shockwave', x, y, strength: 1, radius: 240, hue: 0.1 });
    f.events.push({ t: 'shake', dirX: 0, dirY: 1, amp: BREAK.shake });
    f.events.push({ t: 'timescale', scale: BREAK.timeScale, ticks: BREAK.timeScaleTicks });
    const keys: UriPartKey[] = [URI_PRIMARY];
    for (const k of URI_ORDER) if (k !== URI_PRIMARY && !this.byKey.get(k)!.lost) keys.push(k);
    this.releaseQueue = keys;
    this.budgets.clear();
    const ids = keys.map((k) => (k === URI_PRIMARY ? f.body.id : this.byKey.get(k)!.body.id));
    const b = this.gw.releaseBudgets?.(ids);
    if (b) keys.forEach((k, i) => this.budgets.set(k, b[i]!));
    this.releaseSome();
  }

  private releaseSome(): void {
    let n = 0;
    let pieces = 0;
    while (this.releaseQueue.length && n < BREAK.perTick) {
      const k = this.releaseQueue[0]!;
      // a big part (the chamber, the pelvis) on a tick of its own; two small ones share one within the piece budget
      const want = this.budgets.get(k) ?? 0;
      if (n > 0 && (k === 'chamber' || pieces + want > BREAK.piecesPerTick)) break;
      this.releaseQueue.shift();
      n++;
      pieces += want;
      const power = k === 'chamber' ? BREAK.chamber : BREAK.rest;
      const budget = this.budgets.get(k);
      if (k === URI_PRIMARY)
        this.gw.releaseGroups?.(this.f.body.id, this.coreAt.hx, this.coreAt.hy, power, budget);
      else this.shatter(this.byKey.get(k)!, this.coreAt.hx, this.coreAt.hy, power, budget);
      if (k === 'chamber') break;
    }
    this.refreshIntegrity();
  }

  /** Going down any other way (the matter's KO rule until proposal 176) breaks 우리 apart too. */
  override onKo(): void {
    if (!this.broken) this.breakApart();
  }

  /** The fists and the command moon (the parts that should move at colossal scale) for `tools/feel/scale.ts`. */
  override trackPoints(out: number[]): number {
    for (const k of ['fistL', 'fistR', 'moon'] as const)
      out.push(this.ox + this.places[k].x, this.oy + this.places[k].y);
    return 3;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing and diagnostics
   * ---------------------------------------------------------------------------------------------- */

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    for (const L of [this.back, this.front]) {
      let changed = false;
      for (const r of this.regions) {
        if ((L === this.back) !== r.back || r.lost) continue;
        const m = r.body.map;
        if (m.version === r.version) continue;
        r.version = m.version;
        changed = true;
        for (let y = 0; y < m.h; y++) {
          const src = y * m.w;
          const dst = (r.sy + y) * L.w + r.sx;
          L.pixels.set(m.pixels.subarray(src, src + m.w), dst);
          L.emissive!.set(m.emissive.subarray(src, src + m.w), dst);
        }
        recode(m, this.pristineShade(r.key), (L as RenderLayerLit).shade!, r.sx, r.sy, L.w);
      }
      if (changed) {
        L.version++;
        L.dirty = null;
      }
      const t = this.f.body.transform;
      L.x = L.prevX = t.x;
      L.y = L.prevY = t.y;
      L.facing = 1;
      L.visible = true;
      out.push(L);
    }
    // the live elements (S5's uriLive pass): cores where the kinetic system jolts them, the loop's deformation, the fists' spread
    const live = this.live;
    const kv = this.kview;
    // once the loop has snapped the cores stay where they were (the frozen spots), not on the torso that flew apart
    live.broken = this.broken;
    live.hotX = this.broken ? this.coreAt.hx : this.ox + this.hot.x;
    live.hotY = this.broken ? this.coreAt.hy : this.oy + this.hot.y;
    live.coldX = this.broken ? this.coreAt.cx : this.ox + this.cold.x;
    live.coldY = this.broken ? this.coreAt.cy : this.oy + this.cold.y;
    live.t = this.kin.t;
    live.spin = 0.25 * this.kin.t;
    live.hp = this.kin.hp;
    live.loop.l = kv.loop.l;
    live.loop.r = kv.loop.r;
    live.loop.sh = kv.loop.sh;
    live.loop.vt = kv.loop.vt;
    live.loop.br = kv.loop.br;
    live.loop.stress = kv.stress;
    live.loop.gain = this.kin.tune.loop;
    live.fistSpread = [kv.spread.L, kv.spread.R];
    live.fistZ = FIST_Z;
    // the pylons' plumes: the exhaust point (the bone's end joints.b, carried by the part), π/2 + part angle + vectoring, thrust
    for (const s of ['L', 'R'] as const) {
      const k = s === 'L' ? 'pyL' : 'pyR';
      const meta = uriPart(k);
      const pl = this.places[k];
      const p = this.pylons[s === 'L' ? 0 : 1];
      const dx = meta.jb![0] - meta.pgX;
      const dy = meta.jb![1] - meta.pgY;
      const c = Math.cos(pl.a);
      const sn = Math.sin(pl.a);
      p.x = this.ox + pl.x + dx * c - dy * sn;
      p.y = this.oy + pl.y + dx * sn + dy * c;
      p.a = Math.PI / 2 + pl.a + kv.pylon[s].ang;
      p.th = this.byKey.get(k)!.lost ? 0 : kv.pylon[s].th;
    }
    live.pylons = this.pylons;
    (this.front as RenderLayerLit).uriLive = live;
    // the pelvis's wound cells in the body layer's shade plane
    const bm = this.f.body.map;
    if (this.bodyShade && bm.version !== this.bodyVersion) {
      this.bodyVersion = bm.version;
      recode(bm, this.pristineShade(URI_PRIMARY), this.bodyShade, 0, 0, bm.w);
    }
    this.showHealth();
  }

  private pristineShade(k: UriPartKey): Uint8Array {
    return (this.f.rig as UriTitanRig).parts.find((p) => p.key === k)!.shade;
  }

  /** The debug overlay (spec §9): the seven sliders of the oracle's panel, and the diagnostics. */
  private registerDebug(): void {
    this.untune?.();
    const owner = `match.p${this.f.slot + 1}.uri.rig`;
    const T = this.kin.tune;
    const knob = (key: keyof UriTune, label: string, min: number, max: number): TuningKnob => ({
      key,
      label,
      min,
      max,
      step: 0.05,
      get: () => T[key],
      set: (v) => (T[key] = v),
    });
    // the oracle page's slider ranges (uri/src/page_head.html)
    registerTuning(owner, [
      knob('stiff', 'STIFFNESS', 0.3, 2.5),
      knob('damp', 'DAMPING', 0.3, 2.5),
      knob('mass', 'MASS', 0.4, 2.5),
      knob('react', 'COUNTER-TORQUE', 0, 2.5),
      knob('thrust', 'PYLON COMP', 0, 2.5),
      knob('loop', 'LOOP DEFORM', 0, 3),
      knob('hitstop', 'HITSTOP', 0, 3),
      // 2D gameplay values that no oracle fixes: provisional, for the balance pass
      {
        key: 'power',
        label: 'BLOW POWER X (TUNE)',
        min: 0.2,
        max: 3,
        step: 0.05,
        get: () => this.powerMul,
        set: (v) => (this.powerMul = v),
      },
      {
        key: 'blowTicks',
        label: 'ONE-BLOW TICKS (TUNE)',
        min: 0,
        max: 120,
        step: 3,
        get: () => this.blowTicks,
        set: (v) => (this.blowTicks = v),
      },
      {
        key: 'contHit',
        label: 'BEAM TICKS/HIT (TUNE)',
        min: 6,
        max: 180,
        step: 6,
        get: () => this.contHitTicks,
        set: (v) => (this.contHitTicks = v),
      },
    ]);
    const un = registerDiagnostics(owner, (d) => this.drawDiagnostics(d));
    this.untune = (): void => {
      un();
    };
  }
  drawDiagnostics(d: DiagCtx): void {
    // part pivots
    for (const k of URI_ORDER) {
      const pl = this.places[k];
      const x = d.sx(this.ox + pl.x);
      const y = d.sy(this.oy + pl.y);
      d.line(x - 1, y, x + 1, y, DIAG.pivot);
      d.line(x, y - 1, x, y + 1, DIAG.pivot);
    }
    // the barycentre of the two world-cores, and the cores themselves
    const hx = d.sx(this.ox + this.hot.x);
    const hy = d.sy(this.oy + this.hot.y);
    const cx = d.sx(this.ox + this.cold.x);
    const cy = d.sy(this.oy + this.cold.y);
    d.circle(hx, hy, URI_HOT_CORE[2] * 0.25, DIAG.bary);
    d.circle(cx, cy, URI_COLD_CORE[2] * 0.25, DIAG.bary);
    d.line(hx, hy, cx, cy, DIAG.bary);
    // centre of mass
    const mx = d.sx(this.cm.x);
    const my = d.sy(this.cm.y);
    d.circle(mx, my, 3, DIAG.cm);
    d.line(mx - 5, my, mx + 5, my, DIAG.cm);
    d.line(mx, my - 5, mx, my + 5, DIAG.cm);
    // the target vector: from the centre of mass toward the opponent
    const fv = this.f.foe?.view;
    if (fv) {
      const tx = d.sx(fv.x) - mx;
      const ty = d.sy(fv.y) - my;
      const l = Math.hypot(tx, ty) || 1;
      d.arrow(mx, my, (tx / l) * 40, (ty / l) * 40, DIAG.target);
    }
    d.text(mx + 6, my + 4, `CM R${Math.round(this.cm.radius)} G${Math.round(this.cm.gyration)}`, DIAG.text);
    // the attack cone (±36°) about the target vector
    if (fv) {
      const a = Math.atan2(d.sy(fv.y) - my, d.sx(fv.x) - mx);
      for (const s of [-1, 1])
        d.line(mx, my, mx + Math.cos(a + s * 0.628) * 70, my + Math.sin(a + s * 0.628) * 70, DIAG.cone);
    }
    // pylon thrust vectors
    const kv = this.kview;
    for (const s of ['L', 'R'] as const) {
      const p = this.places[s === 'L' ? 'pyL' : 'pyR'];
      const x = d.sx(this.ox + p.x);
      const y = d.sy(this.oy + p.y) + 40;
      const a = Math.PI / 2 + p.a + kv.pylon[s].ang;
      d.arrow(x, y, Math.cos(a) * kv.pylon[s].th * 30, Math.sin(a) * kv.pylon[s].th * 30, DIAG.pylon);
    }
    // readouts: angular velocities, torque, loop stress, fist spread; the move and its phase
    const L = this.kin.L;
    const rows: [string, number][] = [
      ['ROOT W', L.ha.v],
      ['TORSO W', L.ta.v],
      ['SHOULDER L W', L.sL.v],
      ['SHOULDER R W', L.sR.v],
      ['TORQUE', kv.torque / 100],
      ['LOOP STRESS', kv.stress],
      ['FIST L SPREAD', kv.spread.L],
      ['FIST R SPREAD', kv.spread.R],
    ];
    const bx = d.sx(this.cm.x) - 150;
    const by = d.sy(this.cm.y) - 120;
    rows.forEach(([k, v], i) => d.text(bx, by + i * 7, `${k} ${v.toFixed(2)}`, DIAG.text));
    d.text(
      bx,
      by + rows.length * 7,
      kv.move ? `${kv.move.toUpperCase()} ${kv.phase ?? ''} ${kv.lead ?? ''}` : 'REST',
      DIAG.target,
    );
  }

  /** The bodies, for tests and tools. */
  get regionBodies(): readonly MatterBody[] {
    return this.regions.map((r) => r.body);
  }
  bodyOf(k: UriPartKey): MatterBody {
    return k === URI_PRIMARY ? this.f.body : this.byKey.get(k)!.body;
  }
  /** The loop (0..100: 우리's health) and whether it has snapped. */
  get loop(): number {
    return this.kin.hp;
  }
  get brokenApart(): boolean {
    return this.broken;
  }
  isLost(k: UriPartKey): boolean {
    return k !== URI_PRIMARY && this.byKey.get(k)!.lost;
  }
  /** Reference → world offset of this tick. */
  get offset(): { x: number; y: number } {
    return { x: this.ox, y: this.oy };
  }
}

/** The fists' RenderPart.z (left, right) for the live pass's rubble drawing. */
const FIST_Z: readonly [number, number] = [URI_ORDER.indexOf('fistL'), URI_ORDER.indexOf('fistR')];

/**
 * Re-code a part's shade plane from its map (the shade's 4th byte is the asset's material code): wound cells read as exposed
 * habitat (7) or crack (8), every other cell its pristine code (a healed part reads as authored again).
 */
function recode(
  m: MatterMap,
  pristine: Uint8Array,
  shade: Uint8Array,
  sx: number,
  sy: number,
  rowW: number,
): void {
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      const mat = m.material[i];
      shade[((sy + y) * rowW + sx + x) * 4 + 3] =
        mat === MAT_HABITAT ? URI_MAT.habitat : mat === MAT_CRACK ? URI_MAT.crack : pristine[i * 4 + 3]!;
    }
}

/**
 * A part's load-bearing neck (the oracle's `prepParts` / `neckInt`): its live cells within the neck radius of the joint it is
 * carried by, in its own map. Null for a part no neck carries.
 */
export function uriNeckCells(k: UriPartKey, map: MatterMap): Int32Array | null {
  const n = NECKS.find((e) => e[0] === k);
  if (!n) return null;
  const [, j, from, R] = n;
  const J = uriPart(from)[j];
  if (!J) return null;
  const P = uriPart(k);
  const lx = J[0] - P.pgX + P.pivX;
  const ly = J[1] - P.pgY + P.pivY;
  const out: number[] = [];
  for (let iy = 0; iy < map.h; iy++)
    for (let ix = 0; ix < map.w; ix++) {
      const i = iy * map.w + ix;
      if (map.material[i] !== 0 && Math.hypot(ix - lx, iy - ly) < R) out.push(i);
    }
  return out.length ? Int32Array.from(out) : null;
}

/** The joint patch a part is anchored by: its live cells within a few px of the pivot. */
function anchorPatch(map: MatterMap, ax: number, ay: number): Int32Array {
  const out: number[] = [];
  const r = 4;
  for (let y = Math.max(0, ay - r); y <= Math.min(map.h - 1, ay + r); y++)
    for (let x = Math.max(0, ax - r); x <= Math.min(map.w - 1, ax + r); x++) {
      const i = y * map.w + x;
      if (map.material[i] !== 0 && (x - ax) ** 2 + (y - ay) ** 2 <= r * r) out.push(i);
    }
  if (out.length === 0) out.push(map.coreY * map.w + map.coreX);
  return Int32Array.from(out);
}

function massOf(map: MatterMap): PartMass {
  let m = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < map.material.length; i++) {
    if (!map.material[i]) continue;
    m++;
    sx += (i % map.w) + 0.5;
    sy += Math.floor(i / map.w) + 0.5;
  }
  const cx = m ? sx / m : 0;
  const cy = m ? sy / m : 0;
  let i2 = 0;
  for (let i = 0; i < map.material.length; i++) {
    if (!map.material[i]) continue;
    const dx = (i % map.w) + 0.5 - cx;
    const dy = Math.floor(i / map.w) + 0.5 - cy;
    i2 += dx * dx + dy * dy;
  }
  return { m, cx, cy, i2 };
}
