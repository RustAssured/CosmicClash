import type { Body, WorldPoint } from './body';
import { killCell } from './cells';
import type { WorldCore } from './core';
import { PF_HARVEST, PF_STRETCH, PK } from './particles';

const pt: WorldPoint = { x: 0, y: 0 };

/**
 * Tear cell `i` out of `body` and turn it into a single STREAM particle that carries the cell's mass to a sink point:
 * launched toward the sink with a tangential component (angular momentum), then homing with a swirl so the stream SPIRALS
 * in (particles.ts). On arrival the mass is credited to `creditBody` (or dissipates if there is none). The particle is drawn
 * as a velocity-aligned streak (spaghettification). Returns the mass removed from the body.
 */
export function tearToStream(
  core: WorldCore,
  body: Body,
  i: number,
  sinkX: number,
  sinkY: number,
  creditBody: number,
  homing: number,
  rampId: number,
  harvest: boolean,
): number {
  const w = body.w;
  const x = i % w;
  const y = (i - x) / w;
  body.cellWorld(x, y, pt);
  const px = pt.x;
  const py = pt.y;
  const mass = killCell(body, i);
  let dx = sinkX - px;
  let dy = sinkY - py;
  const d = Math.sqrt(dx * dx + dy * dy) + 1e-6;
  dx /= d;
  dy /= d;
  const rng = core.rng;
  const sp = 45 + rng.next() * 70;
  const tang = 30 + rng.next() * 70;
  const s = core.particles.spawn(
    core,
    PK.mote,
    px,
    py,
    dx * sp + -dy * tang + body.vx * 0.5,
    dy * sp + dx * tang + body.vy * 0.5,
    340,
    1,
    110,
    rampId,
    0.5,
    0,
    mass,
  );
  const P = core.particles;
  P.credit[s] = creditBody;
  P.origin[s] = body.id;
  P.sinkX[s] = sinkX;
  P.sinkY[s] = sinkY;
  P.homing[s] = homing * (0.85 + 0.3 * rng.next());
  P.flags[s] = PF_STRETCH | (harvest ? PF_HARVEST : 0);
  return mass;
}
