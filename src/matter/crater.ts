import { CellFlag } from '@/contracts';
import type { WorldPoint } from './body';
import { breakBondD, breakBondR, killCell } from './cells';
import { MODE_MECH, endSpray, extractChunk, sprayCell } from './debris';
import { hardness, localToWorldF, outwardNormal, resistOf, type DamageCtx } from './dmg';
import { noise2 } from './util';

export interface CraterOpts {
  /** Effective energy to spend (after resist averaging). */
  budget: number;
  /** Fraction of the budget reserved for the loosened lip/rim. */
  lipFrac: number;
  /** depth/width of the bowl; <= 0 derives it from the material (iron deep, regolith wide). */
  aspect: number;
  /** Probability that a block of crater matter leaves as one rigid chunk instead of dust. */
  chunkProb: number;
  /** Ejecta speed multiplier. */
  speedMul: number;
  /** Fraction (0..1) of the removed mass that is compacted into the surrounding cells' density (CRUSH). */
  compact: number;
  /** Crater radius override in cells (0 = derive from the budget). */
  craterR: number;
  /** Damage type index for resistance lookups. */
  type: number;
}

export interface CraterOut {
  ok: boolean;
  /** Impact centre (local float cell coords) and outward normal (local). */
  fx: number;
  fy: number;
  nx: number;
  ny: number;
  /** Crater radius in cells (lateral) and depth. */
  rl: number;
  rd: number;
  removed: number;
  chunks: number;
  removedMass: number;
  /** Threshold in normalised elliptical distance. */
  thr: number;
}

const BINS = 48;
const bins = new Float64Array(BINS + 1);
const nrm: WorldPoint = { x: 0, y: 0 };
const pt: WorldPoint = { x: 0, y: 0 };
const pt2: WorldPoint = { x: 0, y: 0 };
const probe = { kind: 'point' as const, x: 0, y: 0, r: 1 };
const F_CRACK = CellFlag.CRACKED;

/** Hash-based bucket heads for grouping crater cells into 3×3 fragments. */
const BLOCK = 3;
let blockHead = new Int32Array(1);
let blockNext = new Int32Array(1);
const usedBlocks: number[] = [];

/**
 * Shared bowl-crater engine (KINETIC craters, CRUSH impact craters). Finds the first-contact point of the shape, derives a
 * bowl from the energy budget (an ellipse oriented along the surface normal; iron deep and clean, regolith wide and soft),
 * removes the matter it can pay for from the centre out, sprays it as directional ejecta (rigid chunks + dust, faster at the
 * centre, momentum biased along the blow), and spends the rest loosening the rim. Mass is conserved: removed matter becomes
 * chunks/particles, except `compact` of it which is packed into the rim cells' density.
 */
export function carveCrater(ctx: DamageCtx, o: CraterOpts, out: CraterOut): boolean {
  const { core, body } = ctx;
  const map = body.map;
  const w = body.w;
  const mats = body.materials;
  const mat = map.material;
  const rng = body.rng;
  out.ok = false;
  out.removed = 0;
  out.chunks = 0;
  out.removedMass = 0;

  /* ---- 1. first contact: nearest covered cell to the shape origin, averaged over the contact patch ---- */
  const q = core.q;
  const n0 = ctx.n;
  const idx0 = core.covIdx;
  const ox = q.originX();
  const oy = q.originY();
  let dmin = Infinity;
  for (let k = 0; k < n0; k++) {
    const i = idx0[k]!;
    const x = i % w;
    body.cellWorld(x, (i - x) / w, pt);
    const d = (pt.x - ox) * (pt.x - ox) + (pt.y - oy) * (pt.y - oy);
    if (d < dmin) dmin = d;
  }
  if (dmin === Infinity) return false;
  const lim = (Math.sqrt(dmin) + 3.5) * (Math.sqrt(dmin) + 3.5);
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let k = 0; k < n0; k++) {
    const i = idx0[k]!;
    const x = i % w;
    const y = (i - x) / w;
    body.cellWorld(x, y, pt);
    const d = (pt.x - ox) * (pt.x - ox) + (pt.y - oy) * (pt.y - oy);
    if (d > lim) continue;
    sx += x + 0.5;
    sy += y + 0.5;
    sw += 1;
  }
  const fx = sx / sw;
  const fy = sy / sw;
  outwardNormal(body, Math.floor(fx), Math.floor(fy), 4, nrm);
  let nx = nrm.x;
  let ny = nrm.y;
  // If the blow arrives head-on to a flat surface the local normal is reliable; if not (blob interior), fall back to -dir.
  if (nx === 0 && ny === -1 && ctx.ldx * ctx.ldx + ctx.ldy * ctx.ldy > 0) {
    nx = -ctx.ldx;
    ny = -ctx.ldy;
  }

  /* ---- 2. material at the impact -> aspect ---- */
  let tough = 0;
  let brit = 0;
  let cnt = 0;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const x = Math.floor(fx) + dx;
      const y = Math.floor(fy) + dy;
      if (x < 0 || y < 0 || x >= w || y >= body.h) continue;
      const m = mat[y * w + x]!;
      if (m === 0) continue;
      tough += mats[m]!.toughness;
      brit += mats[m]!.brittleness;
      cnt++;
    }
  if (cnt === 0) return false;
  tough /= cnt;
  brit /= cnt;
  let aspect = o.aspect;
  if (aspect <= 0) aspect = 0.5 + 0.95 * tough * (1 - 0.45 * brit);
  aspect = Math.max(0.35, Math.min(1.5, aspect));

  /* ---- 3. extents ---- */
  const budget = o.budget;
  const craterBudget = budget * (1 - o.lipFrac);
  // Half-disc-ish bowl of area ~ budget cells: pi/2 * Rl * (aspect Rl) = budget  =>  Rl.
  let Rl = o.craterR > 0 ? o.craterR : Math.sqrt((2 * craterBudget) / (Math.PI * aspect));
  Rl = Math.max(2.2, Math.min(50, Rl * 1.35)); // search extent (the threshold picks the true radius)
  const Rd = Rl * aspect;

  /* ---- 4. candidates around the impact ---- */
  localToWorldF(body, fx, fy, pt2);
  probe.x = pt2.x;
  probe.y = pt2.y;
  probe.r = Math.max(Rl, Rd) * 1.85 + 1;
  q.set(probe);
  const n = body.collect(q, core.covIdx, core.covW);
  const idx = core.covIdx;
  const dEff = core.covW; // reuse the weight array to hold normalised elliptical distance
  bins.fill(0);
  const tx = -ny;
  const ty = nx;
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    const x = i % w;
    const y = (i - x) / w;
    const rx = x + 0.5 - fx;
    const ry = y + 0.5 - fy;
    const depth = -(rx * nx + ry * ny);
    const lat = rx * tx + ry * ty;
    const dd = depth >= 0 ? depth : -depth * 1.3;
    const d = Math.sqrt((lat / Rl) * (lat / Rl) + (dd / Rd) * (dd / Rd));
    dEff[k] = d;
    if (d <= 1) {
      const cost = (hardness(body, i) * (map.integrity[i]! / 255)) / Math.max(0.15, resistOf(body, i, o.type));
      bins[Math.min(BINS - 1, Math.floor(d * BINS))]! += cost;
    }
  }
  // Threshold: smallest radius whose cumulative cost pays the crater budget.
  let cum = 0;
  let thr = 1;
  for (let b = 0; b < BINS; b++) {
    const c = bins[b]!;
    if (cum + c >= craterBudget) {
      thr = (b + (c > 0 ? (craterBudget - cum) / c : 0)) / BINS;
      break;
    }
    cum += c;
  }
  if (cum + bins[BINS - 1]! < craterBudget && thr === 1) thr = 1;
  thr = Math.max(thr, 0.06);

  /* ---- 5. remove: chunks from the bulk, dust from the centre and from soft matter ---- */
  const nOutWx = nx * body.transform.facing;
  const nOutWy = ny;
  const dirTx = ctx.dirX - (ctx.dirX * nOutWx + ctx.dirY * nOutWy) * nOutWx;
  const dirTy = ctx.dirY - (ctx.dirX * nOutWx + ctx.dirY * nOutWy) * nOutWy;
  const powerBoost = Math.pow(Math.max(0.2, budget / 300), 0.25) * o.speedMul;
  const scatter = ctx.params.scatter ?? 1;
  const keep = 1 - o.compact; // fraction of removed mass that is routed to debris
  let spent = 0;
  let removedMass = 0;
  let chunkCells = 0;
  // Bucket lists for fragment blocks.
  const bw = Math.ceil(w / BLOCK) + 1;
  const need = bw * (Math.ceil(body.h / BLOCK) + 1);
  if (blockHead.length < need) blockHead = new Int32Array(need).fill(-1);
  if (blockNext.length < n) blockNext = new Int32Array(n);
  usedBlocks.length = 0;
  const seed = body.seed;
  // Pass A: decide which cells go, grouping the chunk-eligible ones into blocks; dust the rest immediately.
  for (let k = 0; k < n; k++) {
    const d = dEff[k]!;
    const i = idx[k]!;
    const x = i % w;
    const y = (i - x) / w;
    if (d > thr * (0.9 + 0.2 * noise2(x, y, seed))) continue;
    const m = mat[i]!;
    const md = mats[m]!;
    const cost = (hardness(body, i) * (map.integrity[i]! / 255)) / Math.max(0.15, resistOf(body, i, o.type));
    spent += cost;
    const chunky = md.debris === 'chunk' || md.debris === 'shard';
    if (chunky && d > 0.3 && rng.next() < o.chunkProb) {
      const id = Math.floor(y / BLOCK) * bw + Math.floor(x / BLOCK);
      if (blockHead[id] === -1) usedBlocks.push(id);
      blockNext[k] = blockHead[id]!;
      blockHead[id] = k;
      continue;
    }
    // Dust/particles right now (ejecta velocity by distance from the centre).
    body.cellWorld(x, y, pt);
    let rvx = pt.x - pt2.x;
    let rvy = pt.y - pt2.y;
    const rl = Math.sqrt(rvx * rvx + rvy * rvy);
    if (rl < 0.5) {
      rvx = nOutWx;
      rvy = nOutWy;
    } else {
      rvx /= rl;
      rvy /= rl;
    }
    let vx = rvx * 0.7 + nOutWx * 0.7 + dirTx * 0.3;
    let vy = rvy * 0.7 + nOutWy * 0.7 + dirTy * 0.3;
    const vl = Math.sqrt(vx * vx + vy * vy) + 1e-6;
    const sp = (45 + 200 * Math.pow(1 - Math.min(1, d), 1.3)) * (0.5 + rng.next()) * powerBoost * scatter;
    vx = (vx / vl) * sp;
    vy = (vy / vl) * sp;
    const mass = killCell(body, i);
    ctx.note(i, 1);
    ctx.removed++;
    ctx.massRemoved += mass * keep;
    removedMass += mass;
    sprayCell(core, body, m, pt.x, pt.y, vx, vy, mass * keep, MODE_MECH);
  }
  // Pass B: fragment blocks -> chunks (or dust when too small).
  const list = core.stack2;
  for (let u = 0; u < usedBlocks.length; u++) {
    const id = usedBlocks[u]!;
    list.clear();
    let k = blockHead[id]!;
    blockHead[id] = -1;
    let sxw = 0;
    let syw = 0;
    while (k !== -1) {
      const i = idx[k]!;
      list.push(i);
      const x = i % w;
      body.cellWorld(x, (i - x) / w, pt);
      sxw += pt.x;
      syw += pt.y;
      k = blockNext[k]!;
    }
    const cnt2 = list.size;
    const cwx = sxw / cnt2;
    const cwy = syw / cnt2;
    let rvx = cwx - pt2.x;
    let rvy = cwy - pt2.y;
    const rl = Math.sqrt(rvx * rvx + rvy * rvy);
    if (rl < 0.5) {
      rvx = nOutWx;
      rvy = nOutWy;
    } else {
      rvx /= rl;
      rvy /= rl;
    }
    let vx = rvx * 0.7 + nOutWx * 0.7 + dirTx * 0.3;
    let vy = rvy * 0.7 + nOutWy * 0.7 + dirTy * 0.3;
    const vl = Math.sqrt(vx * vx + vy * vy) + 1e-6;
    // Heavier fragments move slower.
    const sp = (40 + 150 * Math.pow(1 - Math.min(1, rl / (Rl * thr + 1)), 1.2)) * (0.55 + rng.next() * 0.9) * powerBoost * scatter / Math.sqrt(1 + cnt2 * 0.25);
    vx = (vx / vl) * sp;
    vy = (vy / vl) * sp;
    // Account the removal for the result before extractChunk kills the cells.
    for (let j = 0; j < cnt2; j++) {
      const i = list.data[j]!;
      ctx.note(i, 1);
      const mm = body.cellMass(i);
      removedMass += mm;
      ctx.massRemoved += mm * keep;
    }
    ctx.removed += cnt2;
    if (cnt2 >= 3) {
      const ch = extractChunk(core, body, list.data, cnt2, vx, vy, (rng.next() - 0.5) * 14, keep);
      if (ch) {
        chunkCells += cnt2;
        out.chunks++;
      }
    } else {
      for (let j = 0; j < cnt2; j++) {
        const i = list.data[j]!;
        const m = mat[i]!;
        const x = i % w;
        body.cellWorld(x, (i - x) / w, pt);
        const mass = killCell(body, i);
        sprayCell(core, body, m, pt.x, pt.y, vx, vy, mass * keep, MODE_MECH);
      }
    }
  }
  spent += 0;

  /* ---- 6. lip: the leftover energy loosens the rim (bruises, cracks, shock-loosened bonds) ---- */
  const lipE = Math.max(0, budget - Math.min(budget * (1 - o.lipFrac), spent));
  let lipW = 0;
  const lipHi = thr * 1.75;
  for (let k = 0; k < n; k++) {
    const d = dEff[k]!;
    if (d <= thr || d > lipHi) continue;
    const i = idx[k]!;
    if (mat[i] === 0) continue;
    const t = (d - thr) / (lipHi - thr);
    lipW += (1 - t) * (1 - t);
  }
  if (lipW > 0 && lipE > 0) {
    for (let k = 0; k < n; k++) {
      const d = dEff[k]!;
      if (d <= thr || d > lipHi) continue;
      const i = idx[k]!;
      if (mat[i] === 0) continue;
      const t = (d - thr) / (lipHi - thr);
      const share = ((1 - t) * (1 - t)) / lipW;
      const e = lipE * share * Math.max(0.2, resistOf(body, i, o.type));
      const loss = (e * 255) / hardness(body, i);
      const it = map.integrity[i]! - loss;
      ctx.note(i, 0.35);
      if (it <= 0) {
        const x = i % w;
        body.cellWorld(x, (i - x) / w, pt);
        const m = mat[i]!;
        const mass = killCell(body, i);
        ctx.removed++;
        ctx.massRemoved += mass * keep;
        removedMass += mass;
        sprayCell(core, body, m, pt.x, pt.y, nOutWx * 30, nOutWy * 30, mass * keep, MODE_MECH);
      } else {
        map.integrity[i] = it;
        // Shock-loosened: break a random bond so the rim can spall.
        if (rng.next() < 0.28 * (1 - t)) {
          const r = rng.next();
          const x = i % w;
          if (r < 0.25 && x < w - 1) breakBondR(body, i);
          else if (r < 0.5 && x > 0) breakBondR(body, i - 1);
          else if (r < 0.75 && i + w < body.n) breakBondD(body, i);
          else if (i >= w) breakBondD(body, i - w);
        } else if (rng.next() < 0.2) {
          map.flags[i] = map.flags[i]! | F_CRACK;
        }
      }
    }
  }
  endSpray(core);

  /* ---- 7. compaction: some of the removed mass is packed into the rim (CRUSH) ---- */
  if (o.compact > 0 && removedMass > 0) {
    absorbMass(ctx, removedMass * o.compact, thr, thr * 1.8, dEff, n);
  }

  const r = Math.max(4, Math.ceil(Rl * 1.85));
  body.touch(Math.floor(fx - r), Math.floor(fy - r), Math.ceil(fx + r), Math.ceil(fy + r));
  body.connDirty = 2;
  out.ok = true;
  out.fx = fx;
  out.fy = fy;
  out.nx = nx;
  out.ny = ny;
  out.rl = Rl * thr;
  out.rd = Rd * thr;
  out.removed = ctx.removed;
  out.removedMass = removedMass;
  out.thr = thr;
  void chunkCells;
  return true;
}

/** Pack `mass` into the density of live cells whose elliptical distance is in (d0, d1]. Raises density, never above 255. */
export function absorbMass(ctx: DamageCtx, mass: number, d0: number, d1: number, dEff: Float32Array, n: number): number {
  const { core, body } = ctx;
  const map = body.map;
  const idx = core.covIdx;
  let cap = 0;
  for (let k = 0; k < n; k++) {
    const d = dEff[k]!;
    if (d <= d0 || d > d1) continue;
    const i = idx[k]!;
    if (map.material[i] === 0) continue;
    cap += ((255 - map.density[i]!) / 128) * body.matDensity[map.material[i]!]!;
  }
  if (cap <= 0) return 0;
  const take = Math.min(mass, cap * 0.9);
  const frac = take / cap;
  let absorbed = 0;
  for (let k = 0; k < n; k++) {
    const d = dEff[k]!;
    if (d <= d0 || d > d1) continue;
    const i = idx[k]!;
    const m = map.material[i]!;
    if (m === 0) continue;
    const md = body.matDensity[m]!;
    if (md <= 0) continue;
    const room = ((255 - map.density[i]!) / 128) * md;
    const add = room * frac;
    const dd = Math.floor((add * 128) / md + 1e-9);
    if (dd > 0) {
      map.density[i] = map.density[i]! + dd;
      absorbed += (dd / 128) * md;
    }
  }
  // Mass that could not be packed (rounding, saturation) goes to dust so the ledger stays exact.
  const leftover = mass - absorbed;
  if (leftover > 0) {
    core.ledger.dissipated += leftover;
  }
  return absorbed;
}
