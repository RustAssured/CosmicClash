import {
  angleToStep,
  makeLayer,
  rgba,
  type FighterTickCtx,
  type MatterBody,
  type MatterMap,
  type RenderLayer,
  type RenderPart,
  type ViewRect,
} from '@/contracts';
import { registerDiagnostics, registerTuning, type DiagCtx, type TuningKnob } from '@/debug/tuning';
import { cloneUriMap, URI_PRIMARY, type UriTitanRig } from '@/titans';
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
import type { UriLiveFx } from '@/render/uriLive';
import { Behaviour } from '../behaviour';
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

  constructor(f: FighterImpl) {
    super(f);
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
    for (const k of regionKeys) {
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
      f.addRegion(body, true);
      const isBack = BACK_PARTS.includes(k);
      const [sx, sy] = (isBack ? pb : pf).at.get(k)!;
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
      const reg: Region = { key: k, body, ax, ay, sx, sy, version: -1, part, back: isBack };
      this.regions.push(reg);
      this.byKey.set(k, reg);
    }
    for (const p of rig.parts) this.mass.set(p.key, massOf(p.map));
    this.packPlanes(rig);
    this.kin = new UriKinetics(f.seed);
    this.pose = this.kin.currentPose();
    this.kinTick = -1;
    this.wroteX = NaN;
    this.place();
    this.registerDebug();
  }

  /**
   * The part pass's static planes (S5, proposal 172 extension): per atlas cell `light` (nx, ny, nz, form), `shade` (surf, tone,
   * edge, material code) and `chunk` (the fists are drawn chunk by chunk), at the same (sx, sy) as the pixels. The primary
   * (pelvis) is drawn by the fighter's own body layer: it gets its part's planes too (a structural bridge until a behaviour hook
   * for the body layer exists; S1). 2C repacks torn cells and bumps the layer version.
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
    const pel = rig.parts.find((p) => p.key === URI_PRIMARY)!;
    const body = (this.f as unknown as { bodyLayer?: RenderLayerLit }).bodyLayer;
    if (body) {
      body.light = pel.light;
      body.shade = pel.shade;
      body.chunk = pel.chunks;
    }
  }

  override reset(_heal: number): void {
    // the fighter heals every region body itself; the kinetic system starts again at rest
    this.kin.reset(this.f.seed);
    this.pose = this.kin.currentPose();
    this.kinTick = -1;
    this.wroteX = NaN;
    this.place();
  }

  override update(_ctx: FighterTickCtx): void {}

  /** A move begins: the kinetic system plays the authored move this slot maps to (D31). */
  override onMoveStart(m: ActiveMove): void {
    const name = m.def?.extra?.['uri'] as UriMoveName | undefined;
    if (name && !m.feint) this.kin.begin(name);
  }

  /**
   * Called right after the primary's transform (and again after a contact moved the root): once per tick the kinetic system
   * advances (two 120 Hz substeps) toward the opponent, then every part goes where the rig says.
   */
  override placeRegions(): void {
    const f = this.f;
    if (f.tickNo !== this.kinTick) {
      this.kinTick = f.tickNo;
      // the opponent, in the rig's reference space (the reference → world offset of the last placement)
      const fv = f.foe?.view;
      if (fv) this.kin.target = [fv.x - this.ox, fv.y - this.oy];
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
      const meta = uriPart(r.key);
      const bt = r.body.transform;
      this.writeTransform(bt, this.places[r.key], meta.pivX, meta.pivY, r.ax, r.ay);
      bt.facing = 1;
      bt.lean = 0;
      r.part.wx = bt.x;
      r.part.wy = bt.y;
      r.part.step = bt.rot ?? 0;
    }
    // the world-cores ride the torso and jolt in their cradles, never leaving them (the cold one answers −0.7 / −0.6)
    const B = bodyTransforms(this.pose);
    const c = this.kview.core;
    apply(B.torso, URI_HOT_CORE[0] + c.x, URI_HOT_CORE[1] + c.y, this.hot);
    apply(B.torso, URI_COLD_CORE[0] - c.x * 0.7, URI_COLD_CORE[1] - c.y * 0.6, this.cold);
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

  /** World centre of mass, radius of gyration and outer radius of the whole body (live cells at rest proportions). */
  private massCentre(): void {
    let M = 0;
    let sx = 0;
    let sy = 0;
    for (const k of URI_ORDER) {
      const pm = this.mass.get(k);
      if (!pm || pm.m <= 0) continue;
      const meta = uriPart(k);
      const pl = this.places[k];
      const c = Math.cos(pl.a);
      const s = Math.sin(pl.a);
      const lx = pm.cx - meta.pivX;
      const ly = pm.cy - meta.pivY;
      sx += pm.m * (this.ox + pl.x + lx * c - ly * s);
      sy += pm.m * (this.oy + pl.y + lx * s + ly * c);
      M += pm.m;
    }
    const cx = M > 0 ? sx / M : this.rootX;
    const cy = M > 0 ? sy / M : this.rootY;
    let I = 0;
    let R = 0;
    for (const k of URI_ORDER) {
      const pm = this.mass.get(k);
      if (!pm || pm.m <= 0) continue;
      const meta = uriPart(k);
      const pl = this.places[k];
      const c = Math.cos(pl.a);
      const s = Math.sin(pl.a);
      const lx = pm.cx - meta.pivX;
      const ly = pm.cy - meta.pivY;
      const wx = this.ox + pl.x + lx * c - ly * s - cx;
      const wy = this.oy + pl.y + lx * s + ly * c - cy;
      I += pm.i2 + pm.m * (wx * wx + wy * wy);
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

  /** The kinetic system is simulation state: fold it into the match hash. */
  override hash(h: number): number {
    return this.kin.hash(h);
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
        if ((L === this.back) !== r.back) continue;
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
    live.hotX = this.ox + this.hot.x;
    live.hotY = this.oy + this.hot.y;
    live.coldX = this.ox + this.cold.x;
    live.coldY = this.oy + this.cold.y;
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
    (this.front as RenderLayerLit).uriLive = live;
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
  /** Reference → world offset of this tick. */
  get offset(): { x: number; y: number } {
    return { x: this.ox, y: this.oy };
  }
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
