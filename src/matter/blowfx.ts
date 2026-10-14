import { RAMP_DUST, RAMP_EMBER, RAMP_SHARD } from './debris';
import { localToWorldF, type DamageCtx } from './dmg';
import { findImpact, type Impact } from './impact';
import { PF_FLASH, PF_NEAR, PF_STRETCH, PK } from './particles';
import type { WorldPoint } from './body';
import { DMath } from '@/contracts/dmath';

const imp: Impact = { fx: 0, fy: 0, nx: 1, ny: 0, hasNormal: false };
const pt: WorldPoint = { x: 0, y: 0 };
const pt2: WorldPoint = { x: 0, y: 0 };

/**
 * The read-at-a-glance moment of a blow: a white-hot flash disc, a starburst of streaking sparks fanned around the outward
 * normal and biased along the blow, and a ring of dust thrown sideways. Emitted once per landed blow (first slice), before
 * the damage model runs, so it exists on the very first frame (and through the hit-stop freeze) and the crater/cuts follow.
 * Everything is a pure-VFX particle (no mass), sized by the blow's energy so a jab is a snap and a Crush a detonation.
 */
export function impactBurst(ctx: DamageCtx): void {
  const { core, body } = ctx;
  if (ctx.energy < 8) return;
  if (!findImpact(ctx, imp)) return;
  localToWorldF(body, imp.fx, imp.fy, pt);
  body.dirToWorld(imp.nx, imp.ny, pt2);
  let nx = pt2.x;
  let ny = pt2.y;
  const bx = pt.x;
  const by = pt.y;
  const k = Math.max(0.3, Math.min(2.6, ctx.energy / 320));
  const P = core.particles;
  const rng = body.rng;
  const m = body.map.material[Math.floor(imp.fy) * body.w + Math.floor(imp.fx)] || 1;
  // The flash and sparks are the struck material's own wound light (its glowRamp, white-hot first): ember orange on rock,
  // white-gold and cyan on the Witness.
  const hot = body.rampIds[m * 5 + RAMP_EMBER]!;
  const dust = body.rampIds[m * 5 + RAMP_DUST]!;
  const shard = body.rampIds[m * 5 + RAMP_SHARD]!;
  const nl = Math.sqrt(nx * nx + ny * ny) || 1;
  nx /= nl;
  ny /= nl;
  // Blend the outward normal with the blow reversed: sparks leave toward the attacker side and along the surface.
  const a0 = DMath.atan2(ny * 0.7 - ctx.dirY * 0.3, nx * 0.7 - ctx.dirX * 0.3);

  // Flash disc (bloom): peaks on the impact frame and is gone within ~100 ms of world time after the hit-stop, so the wound
  // reads by ~300-400 ms wall.
  const fs = Math.min(15, Math.round(5 + 6 * k));
  const disc = P.spawn(
    core,
    PK.plasma,
    bx - nx * 2,
    by - ny * 2,
    nx * 12,
    ny * 12,
    4 + Math.round(1.5 * k),
    fs,
    255,
    hot,
    0,
    5,
    0,
  );
  // full size on the impact frame, shrinking after the hit-stop (render-only: proposal 168, FX peak on the impact frame)
  P.flags[disc] = PF_FLASH;

  // Starburst streaks, already extended on frame 0 so the freeze frame reads as a star.
  const streaks = Math.min(22, Math.round(7 + 7 * k));
  for (let i = 0; i < streaks; i++) {
    const a = a0 + (rng.next() - 0.5) * 2.5;
    const sp = (170 + rng.next() * 330) * (0.8 + 0.25 * k);
    const c = DMath.cos(a);
    const s = DMath.sin(a);
    const off = 4 + rng.next() * 6;
    const p = P.spawn(
      core,
      PK.spark,
      bx + c * off,
      by + s * off,
      c * sp,
      s * sp,
      9 + rng.int(12),
      1,
      255,
      hot,
      0.2,
      2.2,
      0,
    );
    P.flags[p] = PF_STRETCH;
  }
  // Shock ring of dust: a fan of soft puffs thrown outward and along the surface, fast enough to clear the wound.
  const puffs = Math.min(16, Math.round(6 + 5 * k));
  for (let i = 0; i < puffs; i++) {
    const a = a0 + (i / puffs - 0.5) * 3.6 + (rng.next() - 0.5) * 0.3;
    const sp = 80 + rng.next() * 70 * (0.7 + 0.3 * k);
    const c = DMath.cos(a);
    const s = DMath.sin(a);
    P.spawn(
      core,
      PK.dust,
      bx + c * 4,
      by + s * 4,
      c * sp,
      s * sp,
      12 + rng.int(10),
      2 + (rng.next() < 0.3 ? 1 : 0),
      0,
      dust,
      0,
      2.2,
      0,
    );
  }
  // Heavy hits: dust that hugs and travels along the surface (both tangent directions), and a plume thrown at the camera from
  // ABOVE the wound (it rises off the contact, it does not sit on it: the new shape must read).
  if (ctx.energy >= 400) {
    const tx = -ny;
    const ty = nx;
    const travel = Math.min(9, Math.round(4 + 3 * k));
    for (let i = 0; i < travel; i++) {
      const dir = i & 1 ? 1 : -1;
      const sp = 90 + rng.next() * 90;
      P.spawn(
        core,
        PK.dust,
        bx + nx * 1.5 + tx * dir * (4 + rng.next() * 3),
        by + ny * 1.5 + ty * dir * (4 + rng.next() * 3),
        tx * dir * sp + nx * 14,
        ty * dir * sp + ny * 14,
        18 + rng.int(12),
        2 + (rng.next() < 0.5 ? 1 : 0),
        0,
        dust,
        0,
        0.7,
        0,
      );
    }
    const plume = Math.min(8, Math.round(3 + 2.5 * k));
    for (let i = 0; i < plume; i++) {
      const a = a0 + (rng.next() - 0.5) * 1.6;
      const c = DMath.cos(a);
      const s = DMath.sin(a);
      const lift = 42 + rng.next() * 14;
      const sp = 40 + rng.next() * 40;
      const p = P.spawn(
        core,
        PK.dust,
        bx + c * lift,
        by + s * lift,
        c * sp,
        s * sp - 6,
        32 + rng.int(20),
        4 + rng.int(3),
        0,
        dust,
        0,
        1.1,
        0,
      );
      P.flags[p] = PF_NEAR;
    }
  }
  // A few bright shards of the material itself.
  for (let i = 0; i < 3 + Math.round(2 * k); i++) {
    const a = a0 + (rng.next() - 0.5) * 2;
    const sp = 90 + rng.next() * 160;
    P.spawn(
      core,
      PK.shard,
      bx,
      by,
      DMath.cos(a) * sp,
      DMath.sin(a) * sp,
      14 + rng.int(14),
      2,
      90,
      shard,
      0.3,
      1,
      0,
    );
  }
}
