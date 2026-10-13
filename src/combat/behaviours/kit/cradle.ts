import {
  angleToStep,
  clamp,
  makeLayer,
  type DamageEvent,
  type FighterTickCtx,
  type OverlapResult,
  type MatterBody,
  type MatterMap,
  type RenderLayer,
  type RenderPart,
  type ViewRect,
} from '@/contracts';
import type { CradleRegion, CradleRig } from '@/titans/kit/cradle/paint';
import { transmute } from '@/titans/kit/cradle/grow';
import { addDamageResult, type DamageSum } from '../../damageSum';
import type { FighterImpl } from '../../fighter';
import type { FatShape } from '../../shapes';
import { massFromCells, wrapAngle, type MassProps } from '../../rig/xpbd';
import { KitBehaviour } from './base';
import { CRADLE_RIG, buildCradleRig, densityTable, type CradleRigBuild } from './cradle/rig';
import { Gestation } from './cradle/gestate';
import { Chambers } from './cradle/chambers';
import { Differentiation } from './cradle/wrong';
import { Overlay } from '../../fx/overlay';
import { drawTear, drawVeil, growPseudoOrgan } from './cradle/falsebirth';
import type { ActiveMove } from '../../move';

/**
 * THE CRADLE / 태반체 in the game (WJ's brief docs/titans/cradle/BRIEF.md).
 *
 *  - Bodies: the knot is the fighter's primary body (the KO core); the disc and every cord link are rig regions
 *    (`FighterImpl.addRegion`), drawn as one atlas layer of rotated parts behind the knot.
 *  - Motion (Gate 2, ./cradle/rig.ts): the disc is a SAIL on a slow under-damped drive (it tilts back into its travel, lags
 *    and overshoots); the cord is a chain of HEAVY links with slow drives falling along it, so it carries momentum, trails and
 *    swings like mass, never like a rope. Moves steer the drive targets; the jaw-organ's hitboxes ride on the real jaw
 *    (`attachHitShape`).
 *  - The cord can be cut, but only deliberately (WJ): its root joint has to lose most of its matter, then it strains for over
 *    half a second before it parts; the whole cord falls away with its momentum. After a while it REGROWS WRONG, link by link
 *    (calcified; malformed after a second cut): a hard club where the jaw-organ was.
 */

/** A region the fighter owns besides its primary body. */
interface Region {
  /** Index into CradleRig.regions (a regrown link reuses its original's index). */
  index: number;
  kind: CradleRegion['kind'];
  body: MatterBody;
  rigBody: number;
  part: RenderPart;
  version: number;
  /** Joint patch (map cells round its pivot). */
  anchor: Int32Array;
  lost: boolean;
  /** Grown wrong (0 = original tissue, 1 = calcified, 2+ = malformed). */
  wrong: number;
  /** The last tick a heavy blow (SEVER_BLOW) landed on it. */
  heavyAt: number;
  /** Counts toward the fighter's mass and integrity (only the disc: the cord is a limb and a resource). */
  counts: boolean;
}

/** The cord's root joint must fall below this share of its matter to start parting. */
const SEVER_HEALTH = 0.35;
/** …and only under a heavy blow: one of at least this energy has to land on that link within SEVER_BLOW_TICKS. */
const SEVER_BLOW = 600;
const SEVER_BLOW_TICKS = 45;
/** …and stay there this long (ticks) while it strains: the cut is an event, never a graze. */
const SEVER_STRAIN_TICKS = 40;
/** A link with less than this share of its matter left lets go of everything below it. */
const LINK_DEAD = 0.04;
/** The cord's share of a blow it is caught in (the rest is spent on its muscle). */
const CORD_TOUGH = 0.35;
/** Regrowth: the first new link after this many ticks, then one every REGROW_EVERY. */
const REGROW_DELAY = 420;
const REGROW_EVERY = 46;
/** A root move larger than this in one tick (px) is a jump (respawn, tether snap): the rig is carried along rigidly. */
const ROOT_JUMP = 24;
/** How far a throw unfolds the cord's painted S (0 = swung rigid, 1 = pulled straight). */
const UNFOLD = 0.6;
const ATLAS_ROW = 512;
/** FALSE BIRTH: the active tick the membrane throws open (the move's `birth` hitbox), and how long an organ stays. */
const BIRTH_AT = 72;
const ORGAN_TICKS = 420;
/** Mass per cell of the pseudo-organ (its throw is one uncapped blow: mass × speed). */
const ORGAN_MASS = 0.12;

type MoveId =
  | 'cradle.lash'
  | 'cradle.contraction'
  | 'cradle.billow'
  | 'cradle.implant'
  | 'cradle.falsebirth'
  | 'cradle.enfold';

export class CradleBehaviour extends KitBehaviour {
  private R!: CradleRig;
  private rb!: CradleRigBuild;
  private regions: Region[] = [];
  /** Live cord bodies root → tip (regions), for steering and the jaw. */
  private cordLive: Region[] = [];
  private facing: 1 | -1 = 1;
  private rigTick = -1;
  private atlas!: RenderLayer;
  private atlasEmis!: Uint8Array;
  private places: { sx: number; sy: number }[] = [];
  private knotCorner = { x: 0, y: 0 };
  private dens!: Float64Array;
  /** Base drive frequencies (moves scale them for a while). */
  private baseHz!: Float64Array;
  private lastVf = 0;
  /** The cord: straining ticks at the root, when it was cut (−1 = whole), how many times, next link to regrow. */
  private strain = 0;
  /** The live link whose joint is straining. */
  private strainAt = 0;
  private severedAt = -1;
  private cuts = 0;
  private regrowNext = 0;
  private readonly bend = new Float64Array(64);
  private readonly head = new Float64Array(64);
  private readonly headHz = new Float64Array(64);
  /** Per live cord link: how much a throw holds it (0..1), the throw's last target and frequency. */
  private readonly throwW = new Float64Array(64);
  private readonly throwT = new Float64Array(64);
  private readonly throwHz = new Float64Array(64);
  private firstCord = 2;
  /** The painted direction from the cord's root to the jaw-organ's end (facing frame, rad). */
  private jawRestDir = Math.PI / 2;
  /** Gate 3: what its blows develop in the foe, and the chambers its own wounds open. */
  private readonly gest = new Gestation();
  private readonly chambers = new Chambers();
  /** Gate 5: differentiation failure (it develops wrong as it is hurt). */
  private readonly diff = new Differentiation();
  /** IMPLANT: ticks the filaments stay latched on the foe (0 = none), and where on it (offset from its centre). */
  private latch = 0;
  private lastSite = -1000;
  private latchX = 0;
  private latchY = 0;
  private fx!: Overlay;
  /** FALSE BIRTH: the pseudo-organs on the field (chunk id, tick to retire it) and whether this move's birth happened. */
  private organs: { id: number; until: number }[] = [];
  private born = false;
  private readonly ov: OverlapResult = { cells: 0, x: 0, y: 0, nearestX: 0, nearestY: 0, coverage: 0 };
  private readonly touched: number[] = [];
  private readonly fr = { x: 0, y: 0, a: 0 };
  private readonly pt = { x: 0, y: 0 };
  private readonly mprops: MassProps = { mass: 0, cx: 0, cy: 0, inertia: 0, cells: 0 };

  constructor(f: FighterImpl) {
    super(f);
  }

  override attach(): void {
    const f = this.f;
    this.R = f.rig as CradleRig;
    this.facing = f.facing;
    this.dens = densityTable(f.body.materials);
    this.firstCord = this.R.regions.findIndex((r) => r.kind === 'cord');
    const root = this.R.regions[this.firstCord]!;
    this.jawRestDir = Math.atan2(this.R.jawTip.y - root.pivotY, this.R.jawTip.x - root.pivotX);
    const k = this.R.regions[0]!;
    this.knotCorner = { x: k.ox + f.body.transform.anchorX, y: k.oy + f.body.transform.anchorY };
    // the atlas: every region map packed in rows (a regrown link reuses its original's slot: same map size)
    let x = 0;
    let y = 0;
    let rowH = 0;
    this.places = [];
    for (let i = 1; i < this.R.regions.length; i++) {
      const m = this.R.regions[i]!.map;
      if (x + m.w > Math.max(ATLAS_ROW, m.w)) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      this.places[i] = { sx: x, sy: y };
      x += m.w;
      rowH = Math.max(rowH, m.h);
    }
    const aw = Math.max(ATLAS_ROW, ...this.R.regions.slice(1).map((r) => r.map.w));
    const ah = y + rowH;
    this.atlas = makeLayer(`cradle-${f.slot}`, 'world', -0.5, aw, ah);
    this.atlasEmis = new Uint8Array(aw * ah);
    this.atlas.emissive = this.atlasEmis;
    this.atlas.parts = [];
    this.regions = [];
    for (let i = 1; i < this.R.regions.length; i++) this.createRegion(i, 0, false);
    this.buildRig();
    this.place();
    this.diff.prepare(this.R);
    this.fx = new Overlay(`cradle-fx-${f.slot}`, 0.6, 900, 600, 'normal', true);
  }

  /** Create region i's matter body (attach, regrowth, a new round) and its atlas part; `wrong` grows it wrong. */
  private createRegion(i: number, wrong: number, regrown: boolean): Region {
    const f = this.f;
    const src = this.R.regions[i]!;
    const map = cloneMap(src.map);
    if (wrong > 0) this.growWrong(map, src.kind, wrong, i);
    const ax = Math.round(src.pivotX - src.ox);
    const ay = Math.round(src.pivotY - src.oy);
    const anchor = anchorPatch(map);
    const body = f.world.createBody({
      kind: 'part',
      ownerSlot: f.slot,
      map,
      materials: f.body.materials,
      attributes: f.def.attributes,
      seed: f.seed + 613 * i + 97 * wrong,
      transform: { x: 0, y: 0, anchorX: ax, anchorY: ay, facing: this.facing, lean: 0, rot: 0 },
      anchorCells: anchor,
      takesDebrisImpacts: true,
    });
    // the cord is a limb and a resource (its pips), not the Cradle's life: like the Witness's halo it does not count toward
    // its integrity, so cutting it costs its reach and its jaw, not a third of its health
    const counts = src.kind === 'disc';
    f.addRegion(body, counts, regrown && counts);
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
      z: src.z,
    };
    this.atlas.parts!.push(part);
    const reg: Region = {
      index: i,
      kind: src.kind,
      body,
      rigBody: -1,
      part,
      version: -1,
      anchor,
      lost: false,
      wrong,
      counts,
      heavyAt: -1000,
    };
    this.regions.push(reg);
    return reg;
  }

  /** Differentiation failure in a regrown link: calcified (1), then malformed, blistered with sacs (2+). */
  private growWrong(map: MatterMap, kind: CradleRegion['kind'], wrong: number, i: number): void {
    const ids = this.R.ids;
    const seed = this.f.seed + 31 * i + 7 * wrong;
    const hashAt = (x: number, y: number, s: number): number => {
      let h = Math.imul(x * 374761393 + y * 668265263, 1274126177) ^ (seed + s);
      h = Math.imul(h ^ (h >>> 13), 1103515245);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    // calcified: the cord's flesh hardens into bone in rings; the jaw-organ becomes a solid club
    transmute(
      map,
      this.R.ramps,
      (m, x, y) => {
        if (kind === 'jaw') return m === ids.core ? 0 : ids.bone;
        if (m === ids.collagen) return ids.bone;
        if (m === ids.muscle && (Math.floor((x + y * 0.6) / 3) % 2 === 0 || hashAt(x, y, 1) < 0.35))
          return ids.bone;
        return 0;
      },
      seed,
      0.05,
      200,
    );
    if (wrong < 2) return;
    // malformed: blisters of fluid where there should be structure
    for (let b = 0; b < 3; b++) {
      const cx = Math.floor(hashAt(b, 3, 5) * map.w);
      const cy = Math.floor(hashAt(b, 7, 9) * map.h);
      const r = 2.5 + hashAt(b, 1, 2) * 3;
      transmute(
        map,
        this.R.ramps,
        (m, x, y) => (m !== 0 && (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < r * r ? ids.sac : 0),
        seed + b,
        0.1,
        90,
      );
    }
  }

  /** (Re)build the rig from the regions as they are now, at rest pose round the root. */
  private buildRig(): void {
    const f = this.f;
    const s = this.facing;
    const live = this.regions.filter((r) => !r.lost);
    const order: CradleRegion[] = [this.R.regions[0]!];
    const maps: MatterMap[] = [f.body.map];
    const sorted = live.slice().sort((a, b) => a.index - b.index);
    for (const r of sorted) {
      order.push(this.R.regions[r.index]!);
      maps.push(r.body.map);
    }
    this.rb = buildCradleRig(order, maps, f.body.materials, f.px * s, f.py, this.knotCorner, this.R.jawTip);
    sorted.forEach((r, k) => (r.rigBody = this.rb.bodyOf[k + 1]!));
    this.cordLive = sorted.filter((r) => r.kind === 'cord' || r.kind === 'jaw');
    this.baseHz = Float64Array.from(this.rb.rig.drives, (d) => d.hz);
    this.rigTick = -1;
  }

  override reset(heal: number): void {
    super.reset(heal);
    const f = this.f;
    this.facing = f.facing;
    // a new round: the regrown (wrong) tissue is shed and the cord grows back as it was
    for (const r of this.regions) {
      if (r.lost) continue;
      if (r.wrong > 0) {
        f.removeRegion(r.body.id);
        f.world.removeBody(r.body.id);
        this.dropPart(r);
        r.lost = true;
      }
    }
    const missing = new Set<number>();
    for (let i = 1; i < this.R.regions.length; i++)
      if (!this.regions.some((r) => r.index === i && !r.lost)) missing.add(i);
    this.regions = this.regions.filter((r) => !r.lost);
    for (const i of missing) this.createRegion(i, 0, true);
    this.strain = 0;
    this.severedAt = -1;
    this.regrowNext = 0;
    this.latch = 0;
    for (const o of this.organs) f.world.retireChunk?.(o.id);
    this.organs = [];
    this.born = false;
    this.gest.reset();
    this.chambers.reset();
    this.diff.reset();
    this.buildRig();
    this.place();
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the rig, every tick
   * ---------------------------------------------------------------------------------------------- */

  override placeRegions(): void {
    const f = this.f;
    if (f.tickNo !== this.rigTick) {
      this.rigTick = f.tickNo;
      const rig = this.rb.rig;
      if (f.facing !== this.facing) this.flipRig(f.facing);
      const s = this.facing;
      const k0 = this.rb.pivot[0]!;
      const kx = f.px * s + k0.fx;
      const ky = f.py + k0.fy;
      rig.frame(this.rb.knot, this.fr);
      const jx = kx - this.fr.x;
      const jy = ky - this.fr.y;
      if (jx * jx + jy * jy > ROOT_JUMP * ROOT_JUMP) rig.translate(jx, jy);
      rig.setKinematic(this.rb.knot, kx, ky, 0);
      this.updateMass();
      this.steer();
      this.checkCord();
      rig.step();
    }
    this.place();
  }

  /** Cells were destroyed: lighter links swing faster, a holed disc turns about a new centre. */
  private updateMass(): void {
    if (this.f.tickNo % 6 !== 0) return;
    const rig = this.rb.rig;
    for (const r of this.regions) {
      if (r.lost || r.rigBody < 0) continue;
      const src = this.R.regions[r.index]!;
      const ax = Math.round(src.pivotX - src.ox);
      const ay = Math.round(src.pivotY - src.oy);
      const m = massFromCells(r.body.map, this.dens, ax, ay, this.mprops);
      if (m.mass <= 0) continue;
      const k = r.kind === 'disc' ? CRADLE_RIG.discMass : CRADLE_RIG.cordMass;
      rig.setMass(r.rigBody, { mass: m.mass * k, cx: m.cx, cy: m.cy, inertia: m.inertia * k });
    }
  }

  /** The intent: the sail answers the Cradle's motion, the cord sways slowly, and the move in progress bends both. */
  private steer(): void {
    const f = this.f;
    const rig = this.rb.rig;
    const d = rig.drives;
    const T = CRADLE_RIG;
    const t = f.tickNo;
    const s = this.facing;
    // restore the base frequencies (moves raise them for a while below)
    for (let i = 0; i < d.length; i++) d[i]!.hz = this.baseHz[i]!;
    // the sail: travelling forward lifts its leading edge (negative angle); the push of an acceleration kicks it
    const vf = f.vx * s;
    const acc = (vf - this.lastVf) * 60;
    this.lastVf = vf;
    let sail = clamp(-0.42 * (vf / 230), -0.38, 0.38) + clamp(f.vy / 230, -1, 1) * 0.08;
    sail += 0.035 * Math.sin((t * Math.PI * 2) / (60 * 4.6));
    // runaway: the sail loses its rhythm
    if (this.diff.stage === 2) sail += 0.14 * Math.sin(t * 0.13) * Math.sin(t * 0.051 + 1.3);
    if (this.rb.disc >= 0) rig.w[this.rb.disc] = rig.w[this.rb.disc]! - clamp(acc, -900, 900) * 0.00002;
    // the cord at rest: a slow wave travelling down it (seconds, not frames), held by the relative drives
    const n = this.cordLive.length;
    const bend = this.bend;
    const head = this.head;
    const headHz = this.headHz;
    for (let k = 0; k < n; k++) {
      bend[k] =
        (0.07 + 0.05 * this.diff.stage) *
        Math.sin((t * Math.PI * 2) / (60 * (4.2 - 0.8 * this.diff.stage)) - k * 0.75);
      headHz[k] = 0;
      head[k] = 0;
    }
    let relMul = 1;
    const zeta = 1.05;
    const m = f.mv;
    const id = m.def?.id as MoveId | undefined;
    // the aim: where the attack axis points in the facing frame, plus the variant's lean
    const aimA = Math.atan2(f.aimUy, f.aimUx * s) + (m.aim === 'up' ? -0.5 : m.aim === 'down' ? 0.5 : 0);
    // THROW: every link's own muscle turns it to lie along the aim; the root pulls hardest, each link further down a beat
    // later (a heavy wave down the chain, not a whip-crack)
    const aim = (hz: number, extra: number): void => {
      // the cord turns as one mass about its root (its S kept, so no joint is asked to fold past itself) until the
      // jaw-organ lies along the aim, and unfolds part of the way as it goes
      const swing = wrapAngle(aimA + extra - this.jawRestDir);
      for (let k = 0; k < n; k++) {
        const own = wrapAngle(aimA + extra - this.restDirOf(this.cordLive[k]!) - swing);
        head[k] = swing + UNFOLD * own;
        headHz[k] = hz * Math.pow(0.95, k);
      }
    };
    // COIL: the cord gathers back under the body, loading the swing
    const coil = (hz: number, amt: number): void => {
      for (let k = 0; k < n; k++) {
        head[k] = amt * (k === 0 ? 0.75 : 0.45 + 0.05 * k);
        headHz[k] = hz * Math.pow(0.9, k);
      }
    };
    if (id && m.def) {
      const span = m.phase === 'startup' ? m.startup : m.phase === 'active' ? m.active : m.recovery;
      const u = clamp(m.phaseTick / Math.max(1, span), 0, 1);
      switch (id) {
        case 'cradle.lash':
          // gather (the load), then the throw starts before the window opens: a heavy cord needs a run-up
          if (m.phase === 'startup') {
            if (u < 0.4) coil(1.6, u / 0.4);
            else aim(4.2, 0);
          } else if (m.phase === 'active') aim(4.2, 0);
          else relMul = 0.8; // the muscles hand it back slowly: it hangs again under its own weight
          if (m.phase === 'active') sail -= 0.12;
          break;
        case 'cradle.contraction':
          if (m.phase === 'startup') {
            // the disc rears back (an intake), the cord gathers, then swings up under the fold before it lands
            sail = -0.42 * u;
            if (u < 0.55) coil(1.2, 1.3 * (u / 0.55));
            else aim(4.4, 0.5);
          } else if (m.phase === 'active') {
            sail = 0.5;
            aim(4.4, 0.5);
            d[this.rb.discDrive]!.hz = this.baseHz[this.rb.discDrive]! * 5;
          } else {
            sail = 0.5 * (1 - u);
            relMul = 0.7;
          }
          break;
        case 'cradle.billow':
          sail = -0.45;
          break;
        case 'cradle.implant':
          sail = m.phase === 'recovery' ? -0.25 * (1 - u) : -0.25;
          if (m.phase !== 'recovery') aim(1.6, 0.35);
          break;
        case 'cradle.falsebirth':
          sail = -0.3;
          break;
        default:
          break;
      }
    }
    if (f.state === 'guard') {
      // ENFOLD: the disc folds down over its front, the cord tucks up under it
      sail = 0.5;
      coil(1.8, 0.9);
      d[this.rb.discDrive]!.hz = this.baseHz[this.rb.discDrive]! * 2.5;
    }
    if (f.state === 'ko') {
      relMul = 0.25;
      sail = 0.3;
    }
    if (this.rb.discDrive >= 0) d[this.rb.discDrive]!.target = clamp(sail, -T.discLimit, T.discLimit);
    // a straining root sags on its last fibres
    const sagAt = this.strain > 0 ? this.strainAt : -1;
    for (let k = 0; k < n; k++) {
      const r = this.cordLive[k]!;
      const ci = this.rb.cord.indexOf(r.rigBody);
      if (ci < 0) continue;
      const di = this.rb.cordDrive[ci]!;
      const hi = this.rb.headDrive[ci];
      // the throw takes the muscles over at once and hands them back slowly (no snap when a move ends)
      const want = headHz[k]! > 0.05;
      if (want) {
        this.throwW[k] = Math.min(1, this.throwW[k]! + 0.34);
        this.throwT[k] = head[k]!;
        this.throwHz[k] = headHz[k]!;
      } else this.throwW[k] = Math.max(0, this.throwW[k]! - 1 / 36);
      const w = this.throwW[k]!;
      const thrown = w > 0.02;
      const hangT = bend[k]! * (k + 1) * 0.5;
      const hangHz = T.hangHz * Math.pow(0.9, k) * (f.state === 'ko' ? 0.3 : 1);
      const absT = hangT + w * wrapAngle(this.throwT[k]! - hangT);
      const absT0 =
        k > 0
          ? bend[k - 1]! * k * 0.5 +
            this.throwW[k - 1]! * wrapAngle(this.throwT[k - 1]! - bend[k - 1]! * k * 0.5)
          : 0;
      // the relative drives agree with the throw (the bend between this link and its parent)
      const rel = thrown ? wrapAngle(absT - absT0) : bend[k]!;
      d[di]!.target = clamp(rel, -2.4, 2.4);
      // thrown, the cord moves as one thick limb: its joints hold their bends hard (it never whips)
      const restHz = this.baseHz[di]! * relMul * (k === sagAt ? 0.3 : 1) * (r.wrong > 0 ? 1.3 : 1);
      d[di]!.hz = restHz + w * Math.max(0, this.throwHz[k]! * 0.8 - restHz);
      d[di]!.zeta = thrown ? 1 : r.wrong > 0 ? 0.6 : T.cordZeta;
      if (hi !== undefined) {
        // at rest the same muscles HOLD the cord hanging (heavy, slow, well damped: nothing pulls it down in space but its
        // own tone); a throw takes them over
        const hd = d[hi]!;
        hd.off = k === sagAt;
        hd.target = absT;
        hd.hz = hangHz + w * Math.max(0, this.throwHz[k]! * (r.wrong > 0 ? 0.8 : 1) - hangHz);
        hd.zeta = thrown ? zeta : 0.95;
      }
    }
  }
  /** The painted direction of a cord body's link (a regrown link keeps its original's). */
  private restDirOf(r: Region): number {
    const first = this.firstCord;
    return this.rb.restDir[r.index - first] ?? Math.PI / 2;
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  the cord: deliberate severing, wrong regrowth
   * ---------------------------------------------------------------------------------------------- */

  private checkCord(): void {
    const f = this.f;
    const world = f.world;
    const now = f.tickNo;
    // every joint of the cord parts the same deliberate way: its patch has to lose most of its matter and stay that way
    // while it strains; a link gutted to (almost) nothing lets go at once
    let worst = -1;
    let worstH = 1;
    for (let k = 0; k < this.cordLive.length; k++) {
      const r = this.cordLive[k]!;
      const h = world.jointHealth ? world.jointHealth(r.body.id, r.anchor) : 1;
      if (world.stats(r.body.id).massFrac < LINK_DEAD) {
        worst = k;
        worstH = -1;
        break;
      }
      if (h < worstH) {
        worstH = h;
        worst = k;
      }
    }
    if (worst >= 0 && worstH < 0) this.sever(worst);
    else if (
      worst >= 0 &&
      worstH < SEVER_HEALTH &&
      f.tickNo - this.cordLive[worst]!.heavyAt <= SEVER_BLOW_TICKS &&
      f.state !== 'ko'
    ) {
      if (this.strain === 0) this.cue('cord-strain');
      this.strainAt = worst;
      this.strain++;
      if (this.strain >= SEVER_STRAIN_TICKS) this.sever(worst);
    } else this.strain = Math.max(0, this.strain - 2); // regrowth, link by link, wrong
    if (this.severedAt >= 0) {
      const nOrig = this.R.regions.filter((r) => r.kind === 'cord' || r.kind === 'jaw').length;
      const first = this.R.regions.findIndex((r) => r.kind === 'cord');
      const due = this.severedAt + REGROW_DELAY + this.regrowNext * REGROW_EVERY;
      if (now >= due && this.regrowNext < nOrig && f.state !== 'ko') {
        const idx = first + this.cordLive.length;
        if (idx < first + nOrig) this.regrow(idx);
        this.regrowNext++;
        if (this.cordLive.length >= nOrig) this.severedAt = -1;
      }
    }
  }

  /** Cut the cord at live link k: it and everything below fall away as debris, with the rig's momentum. */
  private sever(k: number): void {
    const f = this.f;
    const rig = this.rb.rig;
    const s = this.facing;
    if (!f.world.bodyToChunk || k >= this.cordLive.length) return;
    const gone = this.cordLive.slice(k);
    for (const r of gone) {
      const b = r.rigBody;
      f.removeRegion(r.body.id);
      f.world.bodyToChunk(r.body.id, rig.vx[b]! * s, rig.vy[b]!, rig.w[b]! * s);
      rig.detach(b);
      this.dropPart(r);
      r.lost = true;
    }
    this.cordLive = this.cordLive.slice(0, k);
    this.regions = this.regions.filter((r) => !r.lost);
    this.strain = 0;
    this.cuts++;
    this.severedAt = f.tickNo;
    this.regrowNext = 0;
    this.cue('cord-sever');
    f.events.push({ t: 'shake', dirX: 0, dirY: 1, amp: 4 });
  }

  /** Grow region i back, wrong, on the end of the live cord. */
  private regrow(i: number): void {
    const rig = this.rb.rig;
    const reg = this.createRegion(i, Math.min(3, this.cuts), false);
    const src = this.R.regions[i]!;
    const pv = this.pivotOf(src);
    const parent = this.cordLive.length > 0 ? this.cordLive[this.cordLive.length - 1]! : null;
    const pb = parent ? parent.rigBody : this.rb.knot;
    const pp = parent ? this.pivotOf(this.R.regions[parent.index]!) : this.rb.pivot[0]!;
    // born at its joint on the parent, at the parent's angle
    rig.worldPoint(pb, pv.fx - pp.fx, pv.fy - pp.fy, this.pt);
    rig.frame(pb, this.fr);
    const ax = Math.round(src.pivotX - src.ox);
    const ay = Math.round(src.pivotY - src.oy);
    const m = massFromCells(reg.body.map, this.dens, ax, ay, this.mprops);
    const k = CRADLE_RIG.cordMass * 1.25; // calcified: heavier still
    const b = rig.addBody(
      this.pt.x,
      this.pt.y,
      this.fr.a,
      { mass: m.mass * k, cx: m.cx, cy: m.cy, inertia: m.inertia * k },
      {
        linDrag: CRADLE_RIG.linDrag,
        angDrag: CRADLE_RIG.angDragCord * 1.5,
      },
    );
    reg.rigBody = b;
    this.rb.cord.push(b);
    this.rb.cordJoint.push(rig.addJoint({ a: b, b: pb, ax: 0, ay: 0, bx: pv.fx - pp.fx, by: pv.fy - pp.fy }));
    const kk = this.cordLive.length;
    const hz = CRADLE_RIG.cordHz[Math.min(kk, CRADLE_RIG.cordHz.length - 1)]!;
    const di = rig.addDrive({ a: pb, b, target: 0, hz, zeta: 0.6, aboutPivot: true });
    this.rb.cordDrive.push(di);
    this.rb.headDrive.push(
      rig.addDrive({ a: -1, b, target: 0, hz: 1, zeta: 0.55, aboutPivot: true, off: true }),
    );
    // calcified tissue bends less
    rig.addLimit({ a: pb, b, min: -0.35, max: 0.35, aboutPivot: true, hz: CRADLE_RIG.limitHz, zeta: 0.9 });
    const hzs = Float64Array.from(rig.drives, (d) => d.hz);
    hzs.set(this.baseHz.subarray(0, Math.min(this.baseHz.length, hzs.length)));
    hzs[di] = hz;
    this.baseHz = hzs;
    this.cordLive.push(reg);
    this.cue('cord-regrow');
  }

  private pivotOf(src: CradleRegion): { fx: number; fy: number } {
    const ax = Math.round(src.pivotX - src.ox);
    const ay = Math.round(src.pivotY - src.oy);
    return { fx: src.ox + ax - this.knotCorner.x, fy: src.oy + ay - this.knotCorner.y };
  }

  private dropPart(r: Region): void {
    const parts = this.atlas.parts!;
    const k = parts.indexOf(r.part);
    if (k >= 0) parts.splice(k, 1);
  }

  private cue(id: string): void {
    const f = this.f;
    f.events.push({ t: 'cue', slot: f.slot, titan: f.def.id, id } as never);
  }

  /* ---------------------------------------------------------------------------------------------- *
   *  placement, facing, hits
   * ---------------------------------------------------------------------------------------------- */

  /** Turned round: in the facing frame the structure is canonical, so the turn is a translation (see WitnessBehaviour). */
  private flipRig(facing: 1 | -1): void {
    const rig = this.rb.rig;
    const k0 = this.rb.pivot[0]!;
    rig.frame(this.rb.knot, this.fr);
    this.facing = facing;
    // the knot lands on its new facing-frame place; its own velocity flips sign (the root keeps its world velocity)
    const dx = this.f.px * facing + k0.fx - this.fr.x;
    const dvx = -2 * rig.vx[this.rb.knot]!;
    for (let i = 0; i < rig.n; i++) {
      rig.x[i] = rig.x[i]! + dx;
      rig.vx[i] = rig.vx[i]! + dvx;
    }
    this.lastVf = this.f.vx * facing;
  }

  private place(): void {
    const f = this.f;
    const s = this.facing;
    const rig = this.rb.rig;
    // the rig ran on the smooth root; draw it hanging from where the primary IS (bob, shudder, rounding)
    const t0 = f.body.transform;
    const ox = t0.x - f.px;
    const oy = t0.y - f.py;
    for (const r of this.regions) {
      if (r.lost || r.rigBody < 0) continue;
      rig.frame(r.rigBody, this.fr);
      const t = r.body.transform;
      t.x = Math.round(this.fr.x * s + ox);
      t.y = Math.round(this.fr.y + oy);
      t.facing = s;
      t.lean = 0;
      t.rot = angleToStep(this.fr.a * s);
      r.part.wx = t.x;
      r.part.wy = t.y;
      r.part.step = t.rot;
    }
  }

  /** World position of the jaw-organ's working end (or the club the cord grew instead), if the cord has one. */
  jawPoint(out: { x: number; y: number }): boolean {
    const last = this.cordLive[this.cordLive.length - 1];
    if (!last) return false;
    const f = this.f;
    const rig = this.rb.rig;
    const b = last.rigBody;
    if (last.kind === 'jaw') {
      // two thirds of the way to the blunt end: the plated part
      rig.worldPoint(b, this.rb.tipX * 0.7, this.rb.tipY * 0.7, out);
    } else {
      const m = last.body.map;
      const src = this.R.regions[last.index]!;
      const ax = Math.round(src.pivotX - src.ox);
      const ay = Math.round(src.pivotY - src.oy);
      // the far end of the last link: the map's cell farthest from its pivot
      let best = -1;
      let bx = 0;
      let by = 0;
      for (let y = 0; y < m.h; y += 2)
        for (let x = 0; x < m.w; x += 2) {
          if (m.material[y * m.w + x] === 0) continue;
          const d = (x - ax) ** 2 + (y - ay) ** 2;
          if (d > best) {
            best = d;
            bx = x - ax;
            by = y - ay;
          }
        }
      rig.worldPoint(b, bx * 0.8, by * 0.8, out);
    }
    const t0 = f.body.transform;
    out.x = out.x * this.facing + (t0.x - f.px);
    out.y = out.y + (t0.y - f.py);
    return true;
  }

  /**
   * A blow is split over the bodies it touches by the cells it touches (the fighter's default), except that the cord's thick
   * muscle takes only CORD_TOUGH of its share: it is cut by being struck where it joins, not worn away by every graze.
   */
  override routeDamage(ev: DamageEvent, out: DamageSum): boolean {
    const f = this.f;
    const world = f.world;
    const o = this.ov;
    let total = 0;
    const touched = this.touched;
    touched.length = 0;
    const add = (id: number, k: number): void => {
      world.overlap(id, ev.shape, o);
      if (o.cells > 0) {
        touched.push(id, o.cells, k);
        total += o.cells;
      }
    };
    add(f.body.id, 1);
    for (const r of this.regions) {
      if (r.lost) continue;
      const before = touched.length;
      add(r.body.id, r.kind === 'disc' ? 1 : CORD_TOUGH);
      if (touched.length > before && r.kind !== 'disc' && ev.energy >= SEVER_BLOW) r.heavyAt = f.tickNo;
    }
    if (total === 0) return false;
    const energy = ev.energy;
    for (let k = 0; k < touched.length; k += 3) {
      ev.energy = (energy * touched[k + 1]! * touched[k + 2]!) / total;
      addDamageResult(out, world.applyDamage(touched[k]!, ev));
    }
    ev.energy = energy;
    return true;
  }

  override attachHitShape(hb: string, shape: FatShape): boolean {
    if (!hb.startsWith('jaw') || shape.kind !== 'point') return false;
    if (!this.jawPoint(this.pt)) return false;
    shape.x = this.pt.x;
    shape.y = this.pt.y;
    return true;
  }

  override update(ctx: FighterTickCtx): void {
    super.update(ctx);
    const f = this.f;
    f.resource = this.cordLive.length;
    f.view.parts = this.cordLive.length;
    this.gestate();
    this.falseBirth();
    // its own wounds: every 15 ticks, look for new holes in the knot and the disc
    if (f.tickNo % 15 === 7) {
      const ids = this.R.ids;
      this.chambers.watch(f.body.map, this.R.regions[0]!.map, this.R.ramps, ids, f.seed + f.tickNo);
      for (const r of this.regions)
        if (!r.lost && r.kind === 'disc')
          this.chambers.watch(
            r.body.map,
            this.R.regions[r.index]!.map,
            this.R.ramps,
            ids,
            f.seed + 3 * f.tickNo,
          );
    }
    // differentiation failure: as it is hurt its tissues forget what they are
    const disc = this.regions.find((r) => !r.lost && r.kind === 'disc');
    if (
      f.state !== 'ko' &&
      this.diff.tick(f.tickNo, f.view.integrityPct / 100, f.world, f.body, disc?.body ?? null, this.R, f.seed)
    )
      this.cue('wrong-growth');
    this.drawFx();
  }

  /** The foe's bodies (its primary and any rig regions), front first. */
  private foeBodies(): MatterBody[] {
    const foe = this.f.foe as unknown as { body?: MatterBody; regions?: readonly MatterBody[] };
    if (!foe.body) return [];
    return [...(foe.regions ?? []), foe.body];
  }

  /** Gate 3: every blow it landed this tick plants a gestation site in the foe; the sites develop. */
  private gestate(): void {
    const f = this.f;
    const k = this.signatureLeft > 0 ? 1.6 : 1;
    let bodies: MatterBody[] | null = null;
    for (const e of f.events) {
      if (e.t !== 'hit' || e.attacker !== f.slot || e.blocked > 0.8) continue;
      // a hold's many small bites plant one site at a time (they would otherwise stack on one spot)
      if (e.energy < 120 && f.tickNo - this.lastSite < 20) continue;
      this.lastSite = f.tickNo;
      bodies ??= this.foeBodies();
      this.gest.plant(
        bodies,
        e.x,
        e.y,
        e.dirX,
        e.dirY,
        e.energy,
        e.heavy,
        f.seed + f.tickNo * 7 + this.gest.sites.length,
        k,
      );
      // the Implant's filaments took hold
      const m = f.mv;
      if (m.def?.id === 'cradle.implant' && this.latch === 0) {
        this.latch = 150;
        const fv = f.foe.view;
        this.latchX = e.x - fv.x;
        this.latchY = e.y - fv.y;
      }
    }
    // latched filaments keep feeding: a new site every 25 ticks where they hold
    if (this.latch > 0) {
      this.latch--;
      if (this.latch % 25 === 12 && f.state !== 'ko') {
        const fv = f.foe.view;
        bodies ??= this.foeBodies();
        this.gest.plant(
          bodies,
          fv.x + this.latchX,
          fv.y + this.latchY,
          0,
          1,
          260,
          false,
          f.seed + f.tickNo,
          1.6,
        );
      }
      if (f.foe.view.ko || f.state === 'hitstun') this.latch = 0;
    }
    this.gest.tick();
  }

  /** IMPLANT: it implants (the kit's signature hook): for three seconds everything it touches develops harder and faster. */
  protected override onSignature(_m: ActiveMove): void {
    this.signatureLeft = 180;
  }

  /** The membrane of False Birth: it spreads over the startup, closes and contracts round the foe, then tears open. */
  private drawBirth(fx: Overlay): void {
    const f = this.f;
    const m = f.mv;
    const fv = f.foe.view;
    const hubX = f.view.x;
    const hubY = f.view.y - 34;
    const dx = fv.x - hubX;
    const dy = fv.y - hubY;
    const dist = Math.hypot(dx, dy);
    const foeR = clamp(Math.max(fv.boundsX1 - fv.boundsX0, fv.boundsY1 - fv.boundsY0) * 0.55, 24, 72);
    const seed = f.seed & 1023;
    if (m.phase === 'startup') {
      // SPREAD: the sheet runs out from the disc until it fills the gap and wraps past the foe
      const u = clamp(m.phaseTick / Math.max(1, m.startup), 0, 1);
      const e = u * u * (3 - 2 * u);
      const rx = 40 + (dist * 0.62 + foeR) * e;
      drawVeil(
        fx,
        hubX + dx * 0.55 * e,
        hubY + dy * 0.55 * e,
        rx,
        rx * 0.72,
        0.25 + 0.5 * e,
        hubX,
        hubY,
        0,
        f.tickNo,
        seed,
      );
      fx.layer.z = 0.6;
    } else if (m.phase === 'active' && m.phaseTick < BIRTH_AT) {
      // CONTRACT: it closes round the foe and squeezes in slow pulses; the foe is gone behind it
      const u = clamp(m.phaseTick / 18, 0, 1);
      const big = 40 + dist * 0.62 + foeR;
      const r = big + (foeR * 1.25 - big) * (u * u * (3 - 2 * u));
      const squeeze = 1 - 0.06 * Math.max(0, Math.sin(m.phaseTick * 0.16));
      const cx = hubX + dx * (0.55 + 0.45 * u);
      const cy = hubY + dy * (0.55 + 0.45 * u);
      drawVeil(fx, cx, cy, r * squeeze, r * 0.92 * squeeze, 0.75 + 0.75 * u, hubX, hubY, u, f.tickNo, seed);
      // it hides the foe: in front of everything it has
      fx.layer.z = u > 0.5 ? 25 : 0.6;
    } else if (m.phase === 'active' && m.phaseTick < BIRTH_AT + 18) {
      drawTear(fx, fv.x, fv.y, foeR * 1.25, (m.phaseTick - BIRTH_AT) / 18, seed);
      fx.layer.z = 0.6;
    }
  }

  /** The disc's spoke tips in the world (the filaments leave from them). */
  private rimPoint(k: number, out: { x: number; y: number }): boolean {
    if (this.rb.disc < 0) return false;
    const disc = this.R.regions.find((r) => r.kind === 'disc')!;
    const sp = this.R.spokes[k % this.R.spokes.length]!;
    const ax = Math.round(disc.pivotX - disc.ox) + disc.ox;
    const ay = Math.round(disc.pivotY - disc.oy) + disc.oy;
    this.rb.rig.worldPoint(this.rb.disc, sp.bx - ax, sp.by - ay, out);
    const t0 = this.f.body.transform;
    out.x = out.x * this.facing + (t0.x - this.f.px);
    out.y = out.y + (t0.y - this.f.py);
    return true;
  }

  /**
   * FALSE BIRTH, the sim side: the birth on the move's 72nd active tick (the membrane throws open, the irth hitbox lands)
   * expels a pseudo-organ grown from the foe's own matter, launched after it; organs are retired from the field after 7 s.
   */
  private falseBirth(): void {
    const f = this.f;
    const m = f.mv;
    const world = f.world;
    for (let k = this.organs.length - 1; k >= 0; k--)
      if (f.tickNo >= this.organs[k]!.until) {
        world.retireChunk?.(this.organs[k]!.id);
        this.organs.splice(k, 1);
      }
    if (m.def?.id !== 'cradle.falsebirth') {
      this.born = false;
      return;
    }
    if (this.born || m.phase !== 'active' || m.phaseTick < BIRTH_AT) return;
    this.born = true;
    const foe = this.f.foe as unknown as { body?: MatterBody };
    const fv = f.foe.view;
    this.cue('false-birth');
    f.events.push({ t: 'shake', dirX: this.facing, dirY: 0, amp: 7 });
    if (!foe.body) return;
    const organ = growPseudoOrgan(foe.body.map, 46, f.seed + f.tickNo);
    if (!organ) return;
    const s = this.facing;
    const id = world.spawnChunk({
      pixels: organ.pixels,
      w: organ.w,
      h: organ.h,
      x: fv.x - s * 24,
      y: fv.y + 6,
      vx: 0,
      vy: 0,
      spin: 0.5 * s,
      mass: organ.cells * ORGAN_MASS,
    });
    if (typeof id !== 'number' || id < 0) return;
    // expelled after the foe the birth threw away: a projectile, then an obstacle drifting on the field
    world.launchChunk?.(id, s * 220, -40, f.body.id, f.slot);
    this.organs.push({ id, until: f.tickNo + ORGAN_TICKS });
    if (this.organs.length > 3) {
      world.retireChunk?.(this.organs[0]!.id);
      this.organs.shift();
    }
  }

  /** The filaments (Implant, False Birth): dark vessels from the disc's spoke tips to where they hold the foe. */
  private drawFx(): void {
    const f = this.f;
    const fx = this.fx;
    const fv = f.foe.view;
    const m = f.mv;
    const birth = m.def?.id === 'cradle.falsebirth' && f.state !== 'ko';
    const reaching =
      (m.def?.id === 'cradle.implant' && m.phase !== 'recovery') || (birth && m.phase !== 'recovery');
    const tearing = birth && m.phase === 'active' && m.phaseTick >= BIRTH_AT && m.phaseTick < BIRTH_AT + 18;
    if (this.latch <= 0 && !reaching && !tearing) {
      fx.hide();
      fx.layer.z = 0.6;
      return;
    }
    fx.begin((f.view.x + fv.x) / 2, (f.view.y + fv.y) / 2);
    if (birth) this.drawBirth(fx);
    const tx0 = this.latch > 0 ? fv.x + this.latchX : fv.x;
    const ty0 = this.latch > 0 ? fv.y + this.latchY : fv.y;
    // reaching: the filaments grow out over the startup and active; latched: they pulse
    const grow = reaching
      ? clamp((m.phase === 'startup' ? m.phaseTick / Math.max(1, m.startup) : 1) * 1.1, 0, 1)
      : 1;
    const pulse = this.latch > 0 ? 0.5 + 0.5 * Math.sin(f.tickNo * 0.3) : 0;
    if (tearing) {
      fx.end();
      return;
    }
    const dark = 0xff1a0a24;
    const mid = 0xff2e1050;
    const lit = 0xff4a2a8a;
    const spokes = this.R.spokes.length;
    for (let k = 0; k < spokes; k++) {
      if (k % 2 === 1 && this.latch <= 0) continue;
      if (!this.rimPoint(k, this.pt)) break;
      const ax = this.pt.x;
      const ay = this.pt.y;
      const tx = tx0 + (((k * 37) % 11) - 5) * 1.6;
      const ty = ty0 + (((k * 53) % 11) - 5) * 1.6;
      const bx = ax + (tx - ax) * grow;
      const by = ay + (ty - ay) * grow;
      // sagging: a quadratic through a point pushed off the straight line
      const mx = (ax + bx) / 2 - (by - ay) * 0.12;
      const my = (ay + by) / 2 + (bx - ax) * 0.12 + 8;
      const N = 8;
      let px = ax;
      let py = ay;
      for (let s = 1; s <= N; s++) {
        const u = s / N;
        const qx = (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * mx + u * u * bx;
        const qy = (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * my + u * u * by;
        const r = 1.1 - 0.5 * u + pulse * 0.3;
        fx.capsule(px, py, r, qx, qy, r * 0.9, lit, mid, dark, 0);
        px = qx;
        py = qy;
      }
    }
    fx.end();
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
      const pl = this.places[r.index]!;
      for (let y = 0; y < m.h; y++) {
        const src = y * m.w;
        const dst = (pl.sy + y) * L.w + pl.sx;
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
    if (this.fx.layer.visible) out.push(this.fx.layer);
  }

  /** The jaw-organ and the disc's rim, for the scale-of-motion instrumentation. */
  override trackPoints(out: number[]): number {
    let n = 0;
    if (this.jawPoint(this.pt)) {
      out.push(this.pt.x, this.pt.y);
      n++;
    }
    return n;
  }

  protected override hashState(h: number): number {
    let x = Math.imul(h ^ this.rb.rig.hash(), 0x01000193);
    x = Math.imul(x ^ (this.strain + 131 * this.cuts), 0x01000193);
    x = Math.imul(x ^ (this.severedAt + 7919 * this.regrowNext), 0x01000193);
    x = Math.imul(x ^ (this.latch + 4099 * this.organs.length + (this.born ? 1 << 20 : 0)), 0x01000193);
    x = this.diff.hash(this.chambers.hash(this.gest.hash(x >>> 0)));
    return x >>> 0;
  }

  /* ---- for tests and tools ---- */
  get cordLinks(): number {
    return this.cordLive.length;
  }
  /** Gestation: sites planted in the foe so far and cells developed; chambers opened in its own wounds. */
  get gestation(): {
    sites: number;
    cells: number;
    chambers: number;
    wrong: number;
    organs: number;
    stage: number;
  } {
    return {
      sites: this.gest.sites.length,
      cells: this.gest.cells,
      chambers: this.chambers.count,
      wrong: this.diff.turns,
      organs: this.diff.organs,
      stage: this.diff.stage,
    };
  }
  /** Plant a gestation site at a world point on the foe as a blow would (tests and tools). */
  debugPlant(x: number, y: number, energy: number, heavy: boolean): boolean {
    return this.gest.plant(this.foeBodies(), x, y, 1, 0, energy, heavy, this.f.seed + 5, 1) !== null;
  }
  get cordCuts(): number {
    return this.cuts;
  }
  /** Cut the cord at its root now (tests and tools; the game cuts it only through the root's matter). */
  debugSever(): void {
    this.sever(0);
  }
  get rigBuild(): CradleRigBuild {
    return this.rb;
  }
  get regionBodies(): readonly MatterBody[] {
    return this.regions.filter((r) => !r.lost).map((r) => r.body);
  }
}

/** A private copy of a painted region map (painting is cached and shared; matter mutates its maps). */
function cloneMap(src: MatterMap): MatterMap {
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

/** A region's joint patch: the live cells within its anchor radius of the anchor cell (its pivot). */
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
