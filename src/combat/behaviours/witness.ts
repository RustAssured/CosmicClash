import {
  angleToStep,
  clamp01,
  makeLayer,
  rgba,
  type DamageEvent,
  type DamageShape,
  type FighterTickCtx,
  type MatterBody,
  type MatterMap,
  type MatterWorld,
  type RenderLayer,
  type RenderPart,
  type ViewRect,
} from '@/contracts';
import { WITNESS_SHRINE_LIGHT_Y, type WitnessBody, type WitnessRegion, type WitnessTitanRig } from '@/titans';
import { Behaviour } from '../behaviour';
import { addDamageResult, type DamageSum } from '../damageSum';
import type { FighterImpl } from '../fighter';
import { buildWitnessRig, setWitnessHeading, type WitnessRig } from '../rig/witnessRig';
import { WitnessKit, type WitnessKitHost } from './witnessKit';
import { shapeBounds, type Bounds } from '../shapes';
import { WoundVeil } from '../fx/woundVeil';

/**
 * THE WITNESS in game (Phase 2, behind `witness=1`): one matter body per rigid region (D27), driven by the XPBD rig, drawn as
 * one atlas layer with rotated `parts`.
 *
 *  - The fighter's primary body is the eye cradle (the KO core). Every other region is created through the world with its
 *    pivot as the anchor corner, a quantised `rot`, and its joint patch as `anchorCells`, and registered with
 *    `FighterImpl.addRegion` (mass and integrity aggregate across them; halo arcs are a resource and do not count).
 *  - The rig runs in a FACING frame (x mirrored when the Witness faces left): rest geometry is authored facing right. On a
 *    facing flip the rig state is mirrored, so nothing jumps.
 *  - Hits reach the regions through `routeDamage`, FRONT TO BACK: each region passes on what its matter does not stop, so the
 *    carapace shields the reveal layers behind it. The load then travels through the structure: the carapace sways first and
 *    a delayed, ramped wave reaches the arms and the halo (D28: a blow makes the colossus sway and lag, never scatter).
 *  - Joints live in the matter: each region's joint patch (`world.jointHealth`) sets its rig joint's health; a joint that
 *    fails severs the region (the arm beyond it too) into debris (`removeRegion`, then `bodyToChunk`).
 *  - The six moves and the damage-changes-the-kit rules are in `WitnessKit`.
 *  - On KO the structure fails over ~3.5 s: the constraints give, the halo arcs drift off one by one, the arms fall, the eye
 *    goes out last.
 */

/** A region the fighter owns besides its primary body. */
interface Region {
  index: number;
  kind: WitnessRegion['kind'];
  body: MatterBody;
  /** Pivot corner in the region's map (integer: the rotation contract pivots on pixel corners). */
  ax: number;
  ay: number;
  /** Atlas placement of the map. */
  sx: number;
  sy: number;
  version: number;
  part: RenderPart;
  z: number;
  /** Joint patch (map cell indices) and whether the region left the Witness. */
  anchor: Int32Array;
  lost: boolean;
  /** Reveal-stack layer (0 carapace, 1–3 interiors; −1 = not in the stack) and the radius round the pivot holding the map. */
  layer: number;
  reach: number;
  /** Consecutive ticks its joint patch has been (nearly) gone. */
  failing: number;
}

/** An eye that opens with damage: an inner eye behind the carapace or an orb-eye on an arm joint. */
interface EyeSpot {
  /** Region (index into WitnessBody.regions) the eye sits in, and the region that must break for it to open. */
  region: number;
  cover: number;
  /** Rig-frame point and body-coordinate point (for the cover test). */
  lx: number;
  ly: number;
  bx: number;
  by: number;
  inner: boolean;
  open: number;
}

/** A ramped angular impulse: the load of a blow travelling through the structure. */
const MAX_PULSES = 32;
const PULSE_TICKS = 10;
/** The failure process (ticks after KO). */
const FAIL = {
  give: 120,
  haloStart: 30,
  haloEvery: 22,
  armStart: 60,
  armEvery: 24,
  shrine: 150,
  eyeOut: 210,
} as const;

/** A blow covering at least this share of its shape with a stack layer's matter stops at that layer. */
const STACK_EXPOSED = 0.3;
/** A joint fails once its patch health stays below this for this many ticks. */
const JOINT_FAIL_HEALTH = 0.15;
const JOINT_FAIL_TICKS = 30;

/** A root move larger than this in one tick (px) is a jump, not motion: the rig is carried along rigidly. */
const ROOT_JUMP = 24;

const ATLAS_ROW = 1024;
const WHITE_GOLD = rgba(255, 241, 201, 255);
const CYAN = rgba(127, 232, 255, 255);

type WorldWithWounds = MatterWorld & {
  setFissureGlow?(bodyId: number, colour: number | null | undefined): void;
};

export class WitnessBehaviour extends Behaviour {
  private W!: WitnessBody;
  private wr!: WitnessRig;
  private regions: Region[] = [];
  /** Regions in front-to-back order for hit routing. */
  private frontToBack: Region[] = [];
  private byIndex: (Region | undefined)[] = [];
  private facing: 1 | -1 = 1;
  /** The tick the rig last advanced (placeRegions may run twice in a tick). */
  private rigTick = -1;
  private atlas!: RenderLayer;
  private atlasEmis!: Uint8Array;
  private places: { sx: number; sy: number }[] = [];
  private kit!: WitnessKit;
  private host!: WitnessKitHost;
  private eyes: EyeSpot[] = [];
  /** Rest drive frequencies (the failure process lowers them). */
  private baseHz!: Float64Array;
  /** Current halo / arm swing caps (eased back after a move widened them). */
  private haloCap = 0;
  private armCap = 0;
  private readonly pBody = new Int16Array(MAX_PULSES).fill(-1);
  private readonly pDw = new Float64Array(MAX_PULSES);
  private readonly pStart = new Int32Array(MAX_PULSES);
  private pCursor = 0;
  /** Tick the failure process began (−1 = alive). */
  private dying = -1;
  private light = 1;
  private readonly veil = new WoundVeil();
  /** Root jumps the rig was carried across (instrumentation; see ROOT_JUMP). */
  jumps = 0;
  private pupilX = 0;
  private pupilY = 0;
  private readonly fr = { x: 0, y: 0, a: 0 };
  private readonly pt = { x: 0, y: 0 };
  private readonly bounds: Bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly ev2: DamageEvent = {
    type: 'FRACTURE',
    shape: { kind: 'point', x: 0, y: 0, r: 1 } as DamageShape,
    energy: 0,
    dirX: 1,
    dirY: 0,
    duration: 1,
    sourceMass: 1,
    sourceBodyId: -1,
    originX: 0,
    originY: 0,
    flags: 0,
    params: {},
  };

  constructor(f: FighterImpl) {
    super(f);
  }

  override attach(): void {
    const f = this.f;
    const rigDef = f.rig as WitnessTitanRig;
    this.W = rigDef.body;
    this.facing = f.facing;
    this.buildRig();
    // the atlas: every region map packed in rows
    let x = 0;
    let y = 0;
    let rowH = 0;
    this.places = [];
    for (let i = 1; i < this.W.regions.length; i++) {
      const m = this.W.regions[i]!.map;
      if (x + m.w > ATLAS_ROW) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      this.places[i] = { sx: x, sy: y };
      x += m.w;
      rowH = Math.max(rowH, m.h);
    }
    const aw = ATLAS_ROW;
    const ah = y + rowH;
    this.atlas = makeLayer(`witness-${f.slot}`, 'world', -0.5, aw, ah);
    this.atlasEmis = new Uint8Array(aw * ah);
    this.atlas.emissive = this.atlasEmis;
    this.atlas.parts = [];
    this.regions = [];
    this.byIndex = [];
    for (let i = 1; i < this.W.regions.length; i++) this.createRegion(i, false);
    this.frontToBack = this.regions.slice().sort((a, b) => b.z - a.z || a.index - b.index);
    (f.world as WorldWithWounds).setFissureGlow?.(f.body.id, WHITE_GOLD);
    this.kit = new WitnessKit(this.wr.halo.length);
    this.host = this.makeHost();
    this.findEyes(rigDef.ids);
    this.place();
    f.resourceMax = this.haloCount();
    f.resource = f.resourceMax;
  }

  private buildRig(): void {
    const eye = this.eyeCentre();
    this.wr = buildWitnessRig(this.W, this.f.body.materials, eye.x * this.facing, eye.y);
    this.baseHz = Float64Array.from(this.wr.rig.drives, (d) => d.hz);
    this.haloCap = this.wr.tuning.haloLimit;
    this.armCap = this.wr.tuning.armAbsLimit;
    this.pBody.fill(-1);
    this.dying = -1;
    this.light = 1;
  }

  /** Create region `i`'s matter body (attach, or regrown between rounds) and its atlas part. */
  private createRegion(i: number, regrown: boolean): void {
    const f = this.f;
    const r = this.W.regions[i]!;
    const map = cloneRegionMap(r.map);
    const ax = Math.round(r.pivotX - r.ox);
    const ay = Math.round(r.pivotY - r.oy);
    const anchor = anchorPatch(map);
    const body = f.world.createBody({
      kind: 'part',
      ownerSlot: f.slot,
      map,
      materials: f.body.materials,
      attributes: f.def.attributes,
      seed: f.seed + 977 * i,
      transform: { x: 0, y: 0, anchorX: ax, anchorY: ay, facing: this.facing, lean: 0, rot: 0 },
      anchorCells: anchor,
      takesDebrisImpacts: true,
    });
    // the wound light: cyan in the channels, none in the abyss, white-gold everywhere else (never the default magma)
    const glow = r.layer === 1 ? CYAN : r.layer === 3 ? null : WHITE_GOLD;
    (f.world as WorldWithWounds).setFissureGlow?.(body.id, glow);
    f.addRegion(body, r.kind !== 'halo', regrown);
    const part: RenderPart = {
      sx: this.places[i]!.sx,
      sy: this.places[i]!.sy,
      sw: map.w,
      sh: map.h,
      px: ax,
      py: ay,
      wx: 0,
      wy: 0,
      step: 0,
      z: r.z,
    };
    this.atlas.parts!.push(part);
    const reg: Region = {
      index: i,
      kind: r.kind,
      body,
      ax,
      ay,
      sx: part.sx,
      sy: part.sy,
      version: -1,
      part,
      z: r.z,
      anchor,
      lost: false,
      layer: r.layer,
      reach: liveReach(map, ax, ay),
      failing: 0,
    };
    const old = this.byIndex[i];
    if (old) {
      this.regions[this.regions.indexOf(old)] = reg;
      const k = this.frontToBack.indexOf(old);
      if (k >= 0) this.frontToBack[k] = reg;
    } else this.regions.push(reg);
    this.byIndex[i] = reg;
  }

  override reset(_heal: number): void {
    const f = this.f;
    this.facing = f.facing;
    // severed regions grow back between rounds (the fighter heals the ones still attached)
    for (const r of this.regions) if (r.lost) this.createRegion(r.index, true);
    this.buildRig();
    this.host = this.makeHost();
    for (const e of this.eyes) e.open = 0;
    this.kit.reset();
    this.veil.reset();
    this.rigTick = -1;
    this.place();
  }

  /** World position of the eye's centre (body coordinate origin), from the primary body's transform. */
  private eyeCentre(continuous = false): { x: number; y: number } {
    const t = this.f.body.transform;
    const eye = this.W.regions[0]!;
    let x = t.x;
    let y = t.y;
    if (continuous) {
      // the root itself, without the hit shudder / follow offsets (those move the drawn structure rigidly, see place())
      x = this.f.px;
      y = this.f.py;
    }
    return { x: x + (-eye.ox - t.anchorX) * t.facing, y: y + (-eye.oy - t.anchorY) };
  }

  /**
   * The fighter turned round. The rig works in the facing frame (x · facing), where the structure is always the canonical,
   * unmirrored one: turning round mirrors it in the world about the eye, which in the facing frame is a pure translation that
   * brings the eye to its new place. The pose (angles, spins, the motion relative to the eye) is kept; only the eye's own
   * velocity changes sign, because the root keeps its world velocity. (Negating x, angle and spin instead mirrored each part's
   * pose inside the canonical frame: every joint anchor landed up to twice its lever arm away, and the solver blew the rig
   * apart, flinging the regions hundreds of px each tick and severing them.)
   */
  private flipRig(): void {
    const wr = this.wr;
    const rig = wr.rig;
    const e = wr.eye;
    rig.frame(e, this.fr);
    const eye = this.eyeCentre(true);
    const dx = eye.x * this.facing - this.fr.x;
    const dvx = -2 * rig.vx[e]!;
    for (let i = 0; i < rig.n; i++) {
      rig.x[i] = rig.x[i]! + dx;
      rig.vx[i] = rig.vx[i]! + dvx;
    }
  }

  /** The kit's view of the body: halo arcs (rest midpoint and angle about the eye) and arm blades. */
  private makeHost(): WitnessKitHost {
    const W = this.W;
    const wr = this.wr;
    const halo: WitnessKitHost['halo'] = [];
    for (let i = 1; i < W.regions.length; i++) {
      const r = W.regions[i]!;
      if (r.kind !== 'halo') continue;
      const mx = r.ox + r.map.coreX + 0.5 - r.pivotX;
      const my = r.oy + r.map.coreY + 0.5 - r.pivotY;
      halo.push({ body: wr.bodyOf[i]!, mx, my, angle: Math.atan2(my, mx), alive: true });
    }
    const arms: WitnessKitHost['arms'] = W.arms.map(() => ({
      elbowBody: -1,
      ex: 0,
      ey: 0,
      tipBody: -1,
      tx: 0,
      ty: 0,
      alive: false,
    }));
    return {
      f: this.f,
      wr,
      facing: this.facing,
      eyeX: 0,
      eyeY: 0,
      halo,
      arms,
      openEyes: 0,
      openEyeX: [],
      openEyeY: [],
    };
  }

  /** Refresh the kit's view: what is still attached, where the eye is, how many inner eyes are open. */
  private updateHost(): void {
    const h = this.host;
    const W = this.W;
    h.facing = this.facing;
    const e = this.eyeCentre();
    h.eyeX = e.x;
    h.eyeY = e.y;
    let k = 0;
    for (let i = 1; i < W.regions.length; i++) {
      if (W.regions[i]!.kind !== 'halo') continue;
      const r = this.byIndex[i]!;
      h.halo[k++]!.alive = !r.lost && this.f.world.stats(r.body.id).massFrac > 0.3;
    }
    // a blade runs from the start of the segment before the last surviving one to that segment's end: a severed arm is shorter
    W.arms.forEach((arm, a) => {
      const out = h.arms[a]!;
      let last = -1;
      for (let s = 0; s < arm.regions.length; s++) {
        if (this.byIndex[arm.regions[s]!]!.lost) break;
        last = s;
      }
      out.alive = last >= 0;
      if (last < 0) return;
      const seg = W.regions[arm.regions[last]!]!;
      const first = Math.max(0, last - 1);
      out.elbowBody = this.wr.bodyOf[arm.regions[first]!]!;
      out.ex = 0;
      out.ey = 0;
      out.tipBody = this.wr.bodyOf[arm.regions[last]!]!;
      out.tx = arm.points[last + 1]!.x - seg.pivotX;
      out.ty = arm.points[last + 1]!.y - seg.pivotY;
    });
    let open = 0;
    for (const s of this.eyes) {
      if (!s.inner || open >= 5 || !this.eyeUncovered(s)) continue;
      this.wr.rig.worldPoint(this.wr.bodyOf[s.region]!, s.lx, s.ly, this.pt);
      h.openEyeX[open] = this.pt.x * this.facing;
      h.openEyeY[open] = this.pt.y;
      open++;
    }
    h.openEyes = open;
  }

  /**
   * Eyes that open with damage: the inner eyes in the abyss (sclera clusters) open once the carapace over them is broken
   * through; the orb-eyes on the arm joints open as their arm is hurt.
   */
  private findEyes(ids: Record<string, number>): void {
    const W = this.W;
    this.eyes = [];
    const carapace = W.regions.findIndex((r) => r.kind === 'carapace');
    const pupil = W.regions[0]!.map;
    const pid = ids['pupil'] ?? -1;
    // the main eye's pupil (the light that goes out last)
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < pupil.material.length; i++)
      if (pupil.material[i] === pid) {
        sx += i % pupil.w;
        sy += Math.floor(i / pupil.w);
        n++;
      }
    const eye0 = W.regions[0]!;
    this.pupilX = n > 0 ? eye0.ox + sx / n + 0.5 - eye0.pivotX : 0;
    this.pupilY = n > 0 ? eye0.oy + sy / n + 0.5 - eye0.pivotY : 0;
    for (let i = 1; i < W.regions.length; i++) {
      const r = W.regions[i]!;
      const inner = r.kind === 'interior' && r.layer === 3;
      // an eye is its lid / sclera together with the slit across it
      const want = inner
        ? [ids['sclera'], ids['pupil']]
        : r.kind === 'arm'
          ? [ids['orb'], ids['iris'], ids['pupil']]
          : [];
      const mats = new Set(want.filter((m): m is number => m !== undefined));
      if (mats.size === 0) continue;
      for (const c of clusters(r.map, mats)) {
        const bx = r.ox + c.x + 0.5;
        const by = r.oy + c.y + 0.5;
        this.eyes.push({
          region: i,
          cover: inner ? carapace : i,
          lx: bx - r.pivotX,
          ly: by - r.pivotY,
          bx,
          by,
          inner,
          open: 0,
        });
      }
    }
  }

  /** Inner eye: the carapace cells over it are mostly gone. Orb-eye: its arm segment lost a tenth of its matter. */
  private eyeUncovered(s: EyeSpot): boolean {
    const reg = this.byIndex[s.cover];
    if (!reg || reg.lost) return true;
    if (!s.inner) return this.f.world.stats(reg.body.id).massFrac < 0.9;
    const m = reg.body.map;
    const r = this.W.regions[s.cover]!;
    const cx = Math.floor(s.bx - r.ox);
    const cy = Math.floor(s.by - r.oy);
    let live = 0;
    let all = 0;
    for (let y = cy - 3; y <= cy + 3; y++)
      for (let x = cx - 3; x <= cx + 3; x++) {
        if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
        all++;
        if (m.material[y * m.w + x] !== 0) live++;
      }
    return all > 0 && live < all * 0.5;
  }

  override update(_ctx: FighterTickCtx): void {
    const f = this.f;
    f.resource = this.haloCount();
    f.view.parts = f.resource;
  }

  /** A heavy blow landed: its wound is kept clear of this overlay after the hit-stop (proposal 168). */
  override onDealt(energy: number): void {
    const f = this.f;
    this.veil.note(f.events, f.slot, energy, f.foe.view.x, f.foe.view.y, f.tickNo);
  }

  /** HALO CLOSE: the halo is the shield, every broken arc weakens it. */
  override guardMultiplier(): number {
    return this.kit.guardShare(this.host);
  }

  /**
   * Called by the fighter right after the primary's transform (and again after a contact shifts the root): advance the rig
   * once per tick, then put every region body where its rig body is (integer pivot pixel, quantised rotation).
   */
  override placeRegions(): void {
    const f = this.f;
    if (f.tickNo !== this.rigTick) {
      this.rigTick = f.tickNo;
      if (f.facing !== this.facing) {
        this.facing = f.facing;
        this.flipRig();
      }
      const wr = this.wr;
      // the intent: the eye is placed where the fighter is and turned by its angular state (facing-relative). The rig follows
      // the CONTINUOUS root, not the integer transform: a one-pixel step of the transform would kick the whole structure.
      const eye = this.eyeCentre(true);
      // a root that jumps (a respawn, a tether snap) carries the structure with it rigidly: dragged through the joints, a
      // jump of hundreds of px would fling every part (and a severed part would leave with that speed)
      wr.rig.frame(wr.eye, this.fr);
      const jx = eye.x * this.facing - this.fr.x;
      const jy = eye.y - this.fr.y;
      if (jx * jx + jy * jy > ROOT_JUMP * ROOT_JUMP) {
        wr.rig.translate(jx, jy);
        this.jumps++;
      }
      const heading = f.ang.angle;
      wr.rig.setKinematic(wr.eye, eye.x * this.facing, eye.y, heading);
      setWitnessHeading(wr, heading, f.tickNo);
      this.updateHost();
      this.checkJoints();
      if (f.view.state === 'ko' && this.dying < 0) this.dying = f.tickNo;
      if (this.dying >= 0) this.fail(f.tickNo - this.dying);
      else this.steerMoves();
      this.applyPulses();
      wr.rig.step();
      this.place();
      this.updateHost();
      this.drawFx();
      return;
    }
    this.place();
  }

  /** The move in progress bends the drives (and widens the swing caps while the halo / arms are weapons). */
  private steerMoves(): void {
    const kit = this.kit;
    const wr = this.wr;
    const t = wr.tuning;
    kit.steer(this.host);
    const d = wr.rig.drives;
    for (const k of wr.headingDrives) d[k]!.target += kit.armOffset;
    for (let k = 0; k < wr.haloDrives.length; k++) d[wr.haloDrives[k]!]!.target += kit.haloOffset[k]!;
    // caps open at once and close at 0.6 rad/s: the parts are guided home, never snapped
    this.haloCap = kit.haloFree ? t.haloLimit + 1.9 : Math.max(t.haloLimit, this.haloCap - 0.01);
    this.armCap =
      kit.armOffset !== 0
        ? Math.max(this.armCap, t.armAbsLimit + Math.abs(kit.armOffset) + 0.15)
        : Math.max(t.armAbsLimit, this.armCap - 0.01);
    for (const l of wr.haloLimits) {
      wr.rig.limits[l]!.min = -this.haloCap;
      wr.rig.limits[l]!.max = this.haloCap;
    }
    for (const l of wr.armLimits) {
      wr.rig.limits[l]!.min = -this.armCap;
      wr.rig.limits[l]!.max = this.armCap;
    }
  }

  /** Joint health from the matter around each joint; a failed joint severs its region (and the arm beyond it). */
  private checkJoints(): void {
    const f = this.f;
    const wr = this.wr;
    const world = f.world;
    for (const r of this.regions) {
      if (r.lost || this.W.regions[r.index]!.weld) continue;
      const rb = wr.bodyOf[r.index]!;
      const j = wr.jointOf[rb]!;
      if (j < 0) continue;
      const health = world.jointHealth ? world.jointHealth(r.body.id, r.anchor) : 1;
      // the carapace never leaves: it sags on a failing joint but stays (the eye cradle is the KO core)
      if (r.kind === 'carapace') {
        wr.rig.setHealth(j, Math.max(0.2, health));
        continue;
      }
      // a joint whose patch is gone gives way over half a second (the part sags on its last fibres), then fails
      r.failing = health < JOINT_FAIL_HEALTH ? r.failing + 1 : 0;
      if (this.dying < 0) wr.rig.setHealth(j, Math.max(health, r.failing < JOINT_FAIL_TICKS ? 0.05 : 0));
      if (wr.rig.joints[j]!.broken || world.stats(r.body.id).massFrac < 0.12) this.sever(r);
    }
  }

  /** Sever a region into debris; an arm segment takes the rest of its arm with it. */
  private sever(r: Region): void {
    const W = this.W;
    const reg = W.regions[r.index]!;
    if (reg.kind === 'arm') {
      const arm = W.arms[reg.arm]!;
      for (let s = reg.segment; s < arm.regions.length; s++) this.severOne(this.byIndex[arm.regions[s]!]!, 0);
    } else this.severOne(r, reg.kind === 'halo' ? 14 : 0);
  }

  private severOne(r: Region, drift: number): void {
    if (r.lost) return;
    const f = this.f;
    const world = f.world;
    if (!world.bodyToChunk) return;
    const rig = this.wr.rig;
    const rb = this.wr.bodyOf[r.index]!;
    rig.frame(rb, this.fr);
    const s = this.facing;
    let vx = rig.vx[rb]! * s;
    let vy = rig.vy[rb]!;
    // a halo arc drifts outward from the eye
    if (drift > 0) {
      const e = this.eyeCentre();
      const arc = this.host.halo.find((a) => a.body === rb);
      rig.worldPoint(rb, arc ? arc.mx : 0, arc ? arc.my : 0, this.pt);
      const dx = this.pt.x * s - e.x;
      const dy = this.pt.y - e.y;
      const l = Math.hypot(dx, dy) || 1;
      vx += (dx / l) * drift;
      vy += (dy / l) * drift;
    }
    r.lost = true;
    f.removeRegion(r.body.id);
    world.bodyToChunk(r.body.id, vx, vy, rig.w[rb]! * s);
    rig.detach(rb);
    const parts = this.atlas.parts!;
    const k = parts.indexOf(r.part);
    if (k >= 0) parts.splice(k, 1);
  }

  /**
   * The failure process (t ticks after KO): every constraint gives over 2 s, the halo arcs drift away one by one, the arms
   * fall from the root, then the shrine; the eye's light goes out last (`drawFx`).
   */
  private fail(t: number): void {
    const rig = this.wr.rig;
    const give = clamp01(t / FAIL.give);
    for (let d = 0; d < rig.drives.length; d++) rig.drives[d]!.hz = this.baseHz[d]! * (1 - 0.75 * give);
    for (let j = 0; j < rig.joints.length; j++)
      if (!rig.joints[j]!.broken)
        rig.setHealth(j, Math.min(rig.joints[j]!.health, Math.max(0.1, 1 - 0.9 * give)));
    const W = this.W;
    let hk = 0;
    let ak = 0;
    for (let i = 1; i < W.regions.length; i++) {
      const reg = W.regions[i]!;
      const r = this.byIndex[i]!;
      if (reg.kind === 'halo') {
        if (t === FAIL.haloStart + FAIL.haloEvery * hk) this.sever(r);
        hk++;
      } else if (reg.kind === 'arm' && reg.segment === 0) {
        if (t === FAIL.armStart + FAIL.armEvery * ak) this.sever(r);
        ak++;
      } else if (reg.kind === 'shrine' && t === FAIL.shrine) this.sever(r);
    }
  }

  /** Apply the ramped load pulses (each spreads its angular impulse over PULSE_TICKS ticks from its start). */
  private applyPulses(): void {
    const rig = this.wr.rig;
    const now = this.f.tickNo;
    for (let k = 0; k < MAX_PULSES; k++) {
      const b = this.pBody[k]!;
      if (b < 0) continue;
      const age = now - this.pStart[k]!;
      if (age < 0) continue;
      if (age >= PULSE_TICKS || rig.kinematic[b]) {
        this.pBody[k] = -1;
        continue;
      }
      rig.w[b] = rig.w[b]! + this.pDw[k]! / PULSE_TICKS;
    }
  }

  private pulse(body: number, dw: number, start: number): void {
    const k = this.pCursor;
    this.pCursor = (k + 1) % MAX_PULSES;
    this.pBody[k] = body;
    this.pDw[k] = dw;
    this.pStart[k] = start;
  }

  /**
   * A blow's load through the structure: the carapace turns first (from the next tick), then the arm roots and the halo arcs,
   * staggered 8–20 ticks later — each pulse ramped over 10 ticks (D28).
   */
  private redistribute(energy: number, hx: number, hy: number, dirX: number, dirY: number): void {
    const e = this.eyeCentre();
    const torque = (hx - e.x) * dirY - (hy - e.y) * dirX;
    if (Math.abs(torque) < 1e-6) return;
    const dw = Math.sign(torque) * this.facing * Math.min(1.25, energy / 850);
    if (dw === 0) return;
    const wr = this.wr;
    const now = this.f.tickNo + 1;
    this.pulse(wr.carapace, dw, now);
    wr.arms.forEach((a, k) => {
      if (!wr.rig.kinematic[a.bodies[0]!]) this.pulse(a.bodies[0]!, dw * 0.7, now + 8 + 3 * k);
    });
    wr.halo.forEach((b, k) => {
      if (!wr.rig.kinematic[b]) this.pulse(b, dw * 0.8, now + 16 + 3 * k);
    });
  }

  private place(): void {
    const fr = this.fr;
    const s = this.facing;
    // the rig runs on the smooth root; the structure is drawn where the primary actually is (shudder, rounding)
    // the rig ran on the smooth root as it was when it stepped; the structure is drawn hanging from where the primary IS now
    // (its shudder, its rounding, and any contact push since the rig step)
    const o = this.rigOffset(false);
    const ox = o.x;
    const oy = o.y;
    for (const r of this.regions) {
      if (r.lost) continue;
      this.wr.rig.frame(this.wr.bodyOf[r.index]!, fr);
      const t = r.body.transform;
      t.x = Math.round(fr.x * s + ox);
      t.y = Math.round(fr.y + oy);
      t.facing = s;
      t.lean = 0;
      t.rot = angleToStep(fr.a * s);
      r.part.wx = t.x;
      r.part.wy = t.y;
      r.part.step = t.rot;
    }
  }

  /** Halo arcs still bound to the Witness (the resource). */
  private haloCount(): number {
    let n = 0;
    for (const r of this.regions)
      if (r.kind === 'halo' && !r.lost && this.f.world.stats(r.body.id).massFrac > 0.3) n++;
    return n;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  hits
   * ---------------------------------------------------------------------------------------------- */

  /**
   * Front to back: the eye, the carapace, the reveal layers, the shrine, the arms, the halo. Each body takes what reaches it
   * and passes on what its matter does not cover. Then the load travels through the rig (`redistribute`).
   */
  override routeDamage(ev: DamageEvent, out: DamageSum): boolean {
    const f = this.f;
    let remaining = 1;
    let any = false;
    let hx = NaN;
    let hy = NaN;
    const b = shapeBounds(ev.shape, this.bounds);
    const area = Math.max(1, shapeArea(ev.shape));
    let stackHit = false;
    for (let k = -1; k < this.frontToBack.length; k++) {
      if (remaining < 0.05) break;
      const r = k >= 0 ? this.frontToBack[k]! : null;
      if (r) {
        if (r.lost) continue;
        // the carapace stack (carapace + reveal layers, one frame): only the EXPOSED layer under the blow takes it
        if (r.layer >= 0 && stackHit) continue;
        // cheap rejection: the blow's box against a circle round the region's pivot that holds all of its matter
        const t = r.body.transform;
        const cx = Math.max(b.x0, Math.min(t.x, b.x1));
        const cy = Math.max(b.y0, Math.min(t.y, b.y1));
        if ((cx - t.x) ** 2 + (cy - t.y) ** 2 > r.reach * r.reach) continue;
      }
      const id = r ? r.body.id : f.body.id;
      const e2 = this.ev2;
      e2.type = ev.type;
      e2.shape = ev.shape;
      e2.energy = ev.energy * remaining;
      e2.dirX = ev.dirX;
      e2.dirY = ev.dirY;
      e2.duration = ev.duration;
      e2.flags = ev.flags;
      e2.params = ev.params;
      e2.sourceMass = ev.sourceMass;
      e2.sourceBodyId = ev.sourceBodyId;
      e2.originX = ev.originX;
      e2.originY = ev.originY;
      e2.hitstop = ev.hitstop;
      // no separate overlap probe: the damage call reports what it touched (a probe per body per blow cost as much again)
      const res = f.world.applyDamage(id, e2);
      if (res.cellsTouched <= 0) continue;
      addDamageResult(out, res);
      any = true;
      if (Number.isNaN(hx)) {
        hx = res.contactX;
        hy = res.contactY;
      }
      const coverage = Math.min(1, res.cellsTouched / area);
      // a blow that lands mostly on a hole of a stack layer goes on to the layer behind; otherwise the stack is done
      if (r && r.layer >= 0 && coverage >= STACK_EXPOSED) stackHit = true;
      remaining *= 1 - Math.min(0.85, coverage * 1.5);
    }
    if (any && this.dying < 0) this.redistribute(ev.energy, hx, hy, ev.dirX, ev.dirY);
    return any;
  }

  /** The rig, the load pulses and the kit's pending fractures are simulation state: fold them into the match hash. */
  override hash(h: number): number {
    let x = Math.imul(h ^ this.wr.rig.hash(), 0x01000193);
    for (let k = 0; k < MAX_PULSES; k++) {
      if (this.pBody[k]! < 0) continue;
      x = Math.imul(x ^ (this.pBody[k]! * 65599 + this.pStart[k]!), 0x01000193);
      x = Math.imul(x ^ Math.round(this.pDw[k]! * 1e6), 0x01000193);
    }
    x = Math.imul(x ^ this.dying, 0x01000193);
    for (const r of this.regions) x = Math.imul(x ^ (r.lost ? 1 : 0) ^ (r.failing << 1), 0x01000193);
    return this.kit.hash(x >>> 0);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  drawing and instrumentation
   * ---------------------------------------------------------------------------------------------- */

  /** The kit's beams and fracture telegraphs, the opened eyes, and the main eye's light (it goes out last). */
  private drawFx(): void {
    const f = this.f;
    const kit = this.kit;
    const fx = kit.fx;
    const h = this.host;
    const fv = f.foe.view;
    fx.begin((h.eyeX + fv.x) * 0.5, (h.eyeY + fv.y) * 0.5);
    const rig = this.wr.rig;
    const s = this.facing;
    for (const e of this.eyes) {
      const want = this.eyeUncovered(e) ? 1 : 0;
      e.open += (want - e.open) * 0.04;
      if (e.open < 0.03) continue;
      const reg = this.byIndex[e.region];
      if (!reg || reg.lost) continue;
      rig.worldPoint(this.wr.bodyOf[e.region]!, e.lx, e.ly, this.pt);
      const x = this.pt.x * s;
      const y = this.pt.y;
      fx.glow(x, y, (e.inner ? 6 : 4) * e.open, 90, 200, 230, 0.9 * e.open);
      fx.glow(x, y, 1.6 * e.open, 255, 250, 225, e.open);
    }
    // the main eye's light: steady while it lives; in the failure it flickers and goes out after everything else has gone
    let light = 1;
    if (this.dying >= 0) {
      const t = f.tickNo - this.dying;
      const fade = clamp01((FAIL.eyeOut - t) / 60);
      const flicker = t > FAIL.eyeOut - 60 ? 0.55 + 0.45 * Math.sin(t * 0.9) * Math.sin(t * 0.37) : 1;
      light = fade * flicker;
    }
    this.light = light;
    if (light > 0.02) {
      rig.worldPoint(this.wr.eye, this.pupilX, this.pupilY, this.pt);
      fx.glow(this.pt.x * s, this.pt.y, 7, 120, 110, 80, 0.35 * light);
      fx.glow(this.pt.x * s, this.pt.y, 2.2, 160, 230, 255, 0.8 * light);
    }
    this.drawFragments(f.tickNo, light);
    if (this.dying < 0) kit.strike(h);
    this.veil.apply(fx, fv.x, fv.y, f.tickNo, f.view.freezeTicks > 0);
    fx.end();
  }

  /**
   * Presentation only: the arms' edges dissolve into fragments that drift off their tips and outer curves and fade, and the
   * hanging city's lowest spire carries a slow light (art v3). Deterministic in the tick; nothing here is matter.
   */
  private drawFragments(tick: number, light: number): void {
    const fx = this.kit.fx;
    const rig = this.wr.rig;
    const s = this.facing;
    const W = this.W;
    for (let a = 0; a < W.arms.length; a++) {
      const arm = W.arms[a]!;
      const last = arm.regions.length - 1;
      const reg = this.byIndex[arm.regions[last]!];
      if (!reg || reg.lost) continue;
      const seg = W.regions[arm.regions[last]!]!;
      const body = this.wr.bodyOf[arm.regions[last]!]!;
      const jx = arm.points[last]!.x - seg.pivotX;
      const jy = arm.points[last]!.y - seg.pivotY;
      const tx = arm.points[last + 1]!.x - seg.pivotX;
      const ty = arm.points[last + 1]!.y - seg.pivotY;
      const dx = tx - jx;
      const dy = ty - jy;
      const dl = Math.hypot(dx, dy) || 1;
      for (let k = 0; k < 7; k++) {
        const period = 110 + 17 * k;
        const age = (tick + a * 37 + k * 53) % period;
        const u = age / period;
        // born along the outer half of the piece, drifting outward past the tip, fading as it goes
        const along = 0.35 + 0.65 * ((k * 0.381966 + a * 0.17) % 1) + u * 0.5;
        const side = ((k * 7 + a) % 3) - 1;
        const lx = jx + dx * along + (-dy / dl) * side * (3 + 9 * u) + (dx / dl) * 4 * u;
        const ly = jy + dy * along + (dx / dl) * side * (3 + 9 * u) + (dy / dl) * 4 * u;
        rig.worldPoint(body, lx, ly, this.pt);
        const k2 = (1 - u) * (1 - u);
        fx.add(Math.round(this.pt.x * s), Math.round(this.pt.y), 40 * k2, 95 * k2, 100 * k2);
      }
    }
    // the light under the hanging city
    const sh = this.byIndex[W.regions.findIndex((r) => r.kind === 'shrine')];
    if (sh && !sh.lost) {
      const reg = W.regions[sh.index]!;
      rig.worldPoint(this.wr.bodyOf[sh.index]!, 1.5, WITNESS_SHRINE_LIGHT_Y - reg.pivotY, this.pt);
      const pulse = 0.75 + 0.25 * Math.sin(tick * 0.035);
      fx.glow(this.pt.x * s, this.pt.y, 9, 120, 105, 70, 0.55 * pulse * light);
      fx.glow(this.pt.x * s, this.pt.y, 2.5, 255, 245, 210, 0.9 * pulse * light);
    }
  }

  override renderLayers(_view: ViewRect, _alpha: number, out: RenderLayer[]): void {
    const L = this.atlas;
    let changed = false;
    for (const r of this.regions) {
      if (r.lost) continue;
      const m = r.body.map;
      if (m.version === r.version) continue;
      r.version = m.version;
      changed = true;
      for (let y = 0; y < m.h; y++) {
        const src = y * m.w;
        const dst = (r.sy + y) * L.w + r.sx;
        L.pixels.set(m.pixels.subarray(src, src + m.w), dst);
        this.atlasEmis.set(m.emissive.subarray(src, src + m.w), dst);
      }
    }
    if (changed) {
      L.version++;
      L.dirty = null;
    }
    const t = this.f.body.transform;
    L.x = L.prevX = t.x;
    L.y = L.prevY = t.y;
    L.facing = this.facing;
    L.visible = true;
    out.push(L);
    if (this.kit.fx.layer.visible) out.push(this.kit.fx.layer);
  }

  /** Arm tips and halo arcs (planet-scale parts) for `tools/feel/scale.ts`. */
  override trackPoints(out: number[]): number {
    const rig = this.wr.rig;
    const o = this.rigOffset(true);
    let n = 0;
    for (const arm of this.wr.arms) {
      const tip = arm.chain[arm.chain.length - 1]!;
      rig.worldPoint(tip.body, tip.x, tip.y, this.pt);
      out.push(this.pt.x * this.facing + o.x, this.pt.y + o.y);
      n++;
    }
    for (const a of this.host.halo) {
      rig.worldPoint(a.body, a.mx, a.my, this.pt);
      out.push(this.pt.x * this.facing + o.x, this.pt.y + o.y);
      n++;
    }
    return n;
  }

  /** Where the eye is now (smooth root, or the drawn primary) minus where the rig's eye is (world px). */
  private rigOffset(smooth: boolean): { x: number; y: number } {
    const e = this.eyeCentre(smooth);
    this.wr.rig.frame(this.wr.eye, this.fr);
    return { x: e.x - this.fr.x * this.facing, y: e.y - this.fr.y };
  }

  /** The rig, for tests and tools. */
  get rig(): WitnessRig {
    return this.wr;
  }
  get regionBodies(): readonly MatterBody[] {
    return this.regions.filter((r) => !r.lost).map((r) => r.body);
  }
  /** Inner eyes opened by damage (each adds a gaze beam). */
  get openEyes(): number {
    return this.host.openEyes;
  }
  /** Sever the region with this key now, as a failed joint would (tests and tools). */
  debugSever(key: string): void {
    const i = this.W.regions.findIndex((r) => r.key === key);
    const r = this.byIndex[i];
    if (r) this.sever(r);
  }
  /** The main eye's light (0..1): it goes out last in the failure process. */
  get eyeLight(): number {
    return this.light;
  }
  /** Regions severed so far. */
  get severed(): number {
    let n = 0;
    for (const r of this.regions) if (r.lost) n++;
    return n;
  }
}

/** A private copy of a painted region map (generation is cached and shared; matter mutates its maps). */
function cloneRegionMap(src: MatterMap): MatterMap {
  return {
    ...src,
    material: src.material.slice(),
    density: src.density.slice(),
    integrity: src.integrity.slice(),
    temperature: src.temperature.slice(),
    bondR: src.bondR.slice(),
    bondD: src.bondD.slice(),
    infection: src.infection.slice(),
    emissive: src.emissive.slice(),
    detached: src.detached.slice(),
    flags: src.flags.slice(),
    height: src.height.slice(),
    baseColor: src.baseColor.slice(),
    pixels: src.pixels.slice(),
    dirty: null,
    version: 0,
  };
}

/** The joint patch a region is anchored by: the live cells within a few px of its connectivity anchor. */
function anchorPatch(map: MatterMap): Int32Array {
  const out: number[] = [];
  const r = Math.max(2, map.coreRadius + 1);
  for (let y = Math.max(0, map.coreY - r); y <= Math.min(map.h - 1, map.coreY + r); y++)
    for (let x = Math.max(0, map.coreX - r); x <= Math.min(map.w - 1, map.coreX + r); x++) {
      const i = y * map.w + x;
      if (map.material[i] !== 0 && (x - map.coreX) ** 2 + (y - map.coreY) ** 2 <= r * r) out.push(i);
    }
  return Int32Array.from(out);
}

/** Radius round the pivot (map corner ax, ay) holding every live cell (matter only shrinks: it stays conservative). */
function liveReach(map: MatterMap, ax: number, ay: number): number {
  let r2 = 0;
  for (let y = 0; y < map.h; y++)
    for (let x = 0; x < map.w; x++) {
      if (map.material[y * map.w + x] === 0) continue;
      const dx = Math.max(Math.abs(x - ax), Math.abs(x + 1 - ax));
      const dy = Math.max(Math.abs(y - ay), Math.abs(y + 1 - ay));
      r2 = Math.max(r2, dx * dx + dy * dy);
    }
  return Math.sqrt(r2) + 1;
}

/** Area (px²) of a damage shape: what a body's touched cells are a share of (its coverage). */
function shapeArea(s: DamageShape): number {
  switch (s.kind) {
    case 'point':
    case 'field':
      return Math.PI * s.r * s.r;
    case 'line':
      return Math.hypot(s.x1 - s.x0, s.y1 - s.y0) * s.width + 1;
    case 'cone':
      return s.range * s.range * s.halfAngle;
    case 'ring':
      return Math.PI * (s.r1 * s.r1 - s.r0 * s.r0);
  }
  return 1;
}

/** Centroids (map cells) of the 8-connected clusters of the materials `mats` (≥ 3 cells). */
function clusters(map: MatterMap, mats: ReadonlySet<number>): { x: number; y: number }[] {
  const seen = new Uint8Array(map.w * map.h);
  const out: { x: number; y: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || !mats.has(map.material[i]!)) continue;
    let sx = 0;
    let sy = 0;
    let n = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % map.w;
      const cy = (c - cx) / map.w;
      sx += cx;
      sy += cy;
      n++;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
          const j = y * map.w + x;
          if (seen[j] || !mats.has(map.material[j]!)) continue;
          seen[j] = 1;
          stack.push(j);
        }
    }
    if (n >= 3) out.push({ x: sx / n, y: sy / n });
  }
  return out;
}
