import type { Body, WorldPoint } from './body';
import { CONN_STEADY } from './body';
import { breakAllBonds, killCell } from './cells';
import type { Wave, WorldCore } from './core';
import { MODE_BURN, RAMP_EMBER, sprayCell, spawnMassParticle } from './debris';
import { localToWorldF } from './dmg';
import { PK } from './particles';

const pt: WorldPoint = { x: 0, y: 0 };

/**
 * Launch a THERMAL blast ring from body-local (cx, cy): as it expands it blows burning, charred, heat-weakened and brittle
 * matter off the body (the "shock rings blast loosened material" of the Supernova). Not a special case: it only affects
 * cells the fire has already loosened.
 */
export function spawnBlast(
  core: WorldCore,
  body: Body,
  cx: number,
  cy: number,
  radius: number,
  shock: number,
  energy: number,
  sourceMass: number,
): void {
  for (const w of core.waves) {
    if (w.active) continue;
    w.active = true;
    w.bodyId = body.id;
    w.cx = cx;
    w.cy = cy;
    w.r = Math.max(2, radius * 0.6);
    w.speed = 1.7;
    w.maxR = Math.max(16, Math.min(64, radius * 2 + shock * 0.1));
    w.power = Math.max(0.3, Math.min(2, shock / 250));
    w.type = 1;
    localToWorldF(body, cx, cy, pt);
    w.wx = pt.x;
    w.wy = pt.y;
    w.sourceMass = sourceMass;
    // Chunks freed while the ring passes inherit a radial scatter.
    const b = body.blow;
    b.tick = core.tick;
    b.energy = Math.max(b.energy, energy);
    b.radial = 1;
    b.x = pt.x;
    b.y = pt.y;
    b.sourceMass = sourceMass;
    b.dirX = 0;
    b.dirY = 0;
    return;
  }
}

/** Advance a blast ring one tick. */
export function stepBlast(core: WorldCore, body: Body, wv: Wave): void {
  const map = body.map;
  const w = body.w;
  const rng = body.rng;
  const r = wv.r;
  const f = (1 - r / wv.maxR) * wv.power;
  const x0 = Math.max(0, Math.floor(wv.cx - r - 2));
  const x1 = Math.min(w - 1, Math.ceil(wv.cx + r + 2));
  const y0 = Math.max(0, Math.floor(wv.cy - r - 2));
  const y1 = Math.min(body.h - 1, Math.ceil(wv.cy + r + 2));
  const lo = (r - 1.7) * (r - 1.7);
  const hi = (r + 1.7) * (r + 1.7);
  const mats = body.materials;
  let blown = 0;
  // Keep the blow fresh so chunks released by the ring get its radial impulse.
  body.blow.tick = core.tick;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - wv.cx;
      const dy = y + 0.5 - wv.cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < lo || d2 > hi) continue;
      const i = y * w + x;
      const m = map.material[i]!;
      if (m === 0) continue;
      const fl = map.flags[i]!;
      const md = mats[m]!;
      // Only matter the fire has already loosened (or brittle matter) is vulnerable.
      const loose =
        (fl & 1) !== 0
          ? 1
          : (fl & 4) !== 0
            ? 0.8
            : map.integrity[i]! < 140
              ? 0.6
              : map.temperature[i]! > 250
                ? 0.5
                : md.brittleness > 0.8
                  ? 0.15
                  : 0;
      if (loose === 0) continue;
      if (rng.next() > f * loose * 1.3) continue;
      breakAllBonds(body, i);
      body.touchPoint(x, y);
      if (map.integrity[i]! < 100 || (fl & 1) !== 0 || rng.next() < 0.3) {
        // Blown clean off: embers and dust, thrown radially.
        body.cellWorld(x, y, pt);
        let ox = pt.x - wv.wx;
        let oy = pt.y - wv.wy;
        const ol = Math.sqrt(ox * ox + oy * oy) + 1e-6;
        ox /= ol;
        oy /= ol;
        const sp = 70 + rng.next() * 110 * f;
        const mass = killCell(body, i);
        sprayCell(core, body, m, pt.x, pt.y, ox * sp, oy * sp, mass, MODE_BURN);
        blown++;
      }
    }
  }
  // A ring of sparks marks the shock front.
  const nSpark = 5;
  for (let k = 0; k < nSpark; k++) {
    const a = rng.next() * Math.PI * 2;
    localToWorldF(body, wv.cx + Math.cos(a) * r, wv.cy + Math.sin(a) * r, pt);
    const sm = 1;
    spawnMassParticle(
      core,
      PK.spark,
      body.rampIds[sm * 5 + RAMP_EMBER]!,
      pt.x,
      pt.y,
      Math.cos(a) * body.transform.facing * 90,
      Math.sin(a) * 90,
      0,
    );
  }
  if (blown > 0) {
    body.connDirty = Math.max(body.connDirty, CONN_STEADY);
    core.emitMatter('crack', wv.wx, wv.wy, 0, body.ownerSlot);
  }
}
