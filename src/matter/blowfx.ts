import { RAMP_DUST, RAMP_SHARD } from './debris';
import { localToWorldF, type DamageCtx } from './dmg';
import { findImpact, type Impact } from './impact';
import { PF_NEAR, PF_STRETCH, PK } from './particles';
import type { WorldPoint } from './body';

const imp: Impact = { fx: 0, fy: 0, nx: 1, ny: 0, hasNormal: false };
const pt: WorldPoint = { x: 0, y: 0 };

/** Hot ramps (packed RGBA): white-hot -> pale yellow -> orange -> dull red. */
const HOT = [0xffffffff, 0xffa0ecff, 0xff3296ff, 0xff1e3296];
const FLASH = [0xffffffff, 0xffffffff, 0xffc8f0ff, 0xff50a0ff, 0xff2860c8];

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
  const f = body.transform.facing;
  let nx = imp.nx * f;
  let ny = imp.ny;
  const bx = pt.x;
  const by = pt.y;
  const k = Math.max(0.3, Math.min(2.6, ctx.energy / 320));
  const P = core.particles;
  const rng = body.rng;
  const hot = P.internRamp(HOT);
  const flash = P.internRamp(FLASH);
  const m = body.map.material[Math.floor(imp.fy) * body.w + Math.floor(imp.fx)] || 1;
  const dust = body.rampIds[m * 5 + RAMP_DUST]!;
  const shard = body.rampIds[m * 5 + RAMP_SHARD]!;
  const nl = Math.sqrt(nx * nx + ny * ny) || 1;
  nx /= nl;
  ny /= nl;
  // Blend the outward normal with the blow reversed: sparks leave toward the attacker side and along the surface.
  const a0 = Math.atan2(ny * 0.7 - ctx.dirY * 0.3, nx * 0.7 - ctx.dirX * 0.3);

  // Flash disc (bloom).
  const fs = Math.min(15, Math.round(5 + 6 * k));
  P.spawn(
    core,
    PK.plasma,
    bx - nx * 2,
    by - ny * 2,
    nx * 12,
    ny * 12,
    6 + Math.round(3 * k),
    fs,
    255,
    flash,
    0,
    5,
    0,
  );

  // Starburst streaks, already extended on frame 0 so the freeze frame reads as a star.
  const streaks = Math.min(22, Math.round(7 + 7 * k));
  for (let i = 0; i < streaks; i++) {
    const a = a0 + (rng.next() - 0.5) * 2.5;
    const sp = (170 + rng.next() * 330) * (0.8 + 0.25 * k);
    const c = Math.cos(a);
    const s = Math.sin(a);
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
  // Shock ring of dust: a fan of soft puffs thrown outward and along the surface.
  const puffs = Math.min(16, Math.round(6 + 5 * k));
  for (let i = 0; i < puffs; i++) {
    const a = a0 + (i / puffs - 0.5) * 3.6 + (rng.next() - 0.5) * 0.3;
    const sp = 45 + rng.next() * 65 * (0.7 + 0.3 * k);
    P.spawn(
      core,
      PK.dust,
      bx,
      by,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      16 + rng.int(14),
      2 + (rng.next() < 0.3 ? 1 : 0),
      0,
      dust,
      0,
      2.6,
      0,
    );
  }
  // Heavy hits: dust that hugs and travels along the surface (both tangent directions), and a plume thrown at the camera.
  if (ctx.energy >= 400) {
    const tx = -ny;
    const ty = nx;
    const travel = Math.min(9, Math.round(4 + 3 * k));
    for (let i = 0; i < travel; i++) {
      const dir = i & 1 ? 1 : -1;
      const sp = 60 + rng.next() * 90;
      P.spawn(
        core,
        PK.dust,
        bx + nx * 1.5 + tx * dir * rng.next() * 3,
        by + ny * 1.5 + ty * dir * rng.next() * 3,
        tx * dir * sp + nx * 14,
        ty * dir * sp + ny * 14,
        26 + rng.int(18),
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
      const sp = 12 + rng.next() * 34;
      const p = P.spawn(
        core,
        PK.dust,
        bx + (rng.next() - 0.5) * 8,
        by + (rng.next() - 0.5) * 8,
        Math.cos(a) * sp,
        Math.sin(a) * sp - 6,
        42 + rng.int(28),
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
      Math.cos(a) * sp,
      Math.sin(a) * sp,
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
