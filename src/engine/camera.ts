import {
  DEFAULT_ARENA,
  DEG,
  LOGICAL_H,
  LOGICAL_W,
  clamp,
  clamp01,
  lerp,
  type ArenaInfo,
  type CameraApi,
  type CameraState,
  type CameraTargets,
  type SimEvent,
  type ViewRect,
} from '@/contracts';

/**
 * The camera is a huge, heavy crane — not a webcam. Pure and deterministic: no clock, advanced only by `tick()`.
 *
 *  - Framing: weighted midpoint of the two fighters (weight leans toward whoever is moving), a lookahead along their
 *    mean velocity, then a hard "both must stay in frame" constraint. Never zooms out (D5); the micro-zoom is a ≤ 6 %
 *    pulse the renderer applies in its final nearest-neighbour upscale.
 *  - Motion: critically-damped springs with long half-lives so the camera ARRIVES LATE and the universe moves with them.
 *    Vertical follow is gentler than horizontal.
 *  - Impulses: shake is a low-frequency (5–9 Hz) damped oscillation biased along the blow; zoom and roll are short
 *    eased pulses. Everything the renderer sees is integer-snapped at `sample()` time so pixels never shimmer.
 */

export interface CameraTuning {
  /** Seconds for the follow springs to cover half the remaining distance. */
  halfLifeX: number;
  halfLifeY: number;
  /** Seconds of velocity the camera looks ahead by, and the cap in px. */
  lookaheadSec: number;
  lookaheadMax: number;
  /** Margin in px kept between a fighter's bounds and the view edge when they fit. */
  marginX: number;
  marginY: number;
  /** Shake: e-folding time in seconds and frequency range in Hz. */
  shakeTau: number;
  shakeHzMin: number;
  shakeHzMax: number;
  /** Zoom pulse e-folding time (s) and the hard cap on total zoom. */
  zoomTau: number;
  maxZoom: number;
  /** Roll half-life (s) and cap in radians. */
  rollHalfLife: number;
  maxRoll: number;
  /** Edge safety: soft inner margin (a stronger spring engages inside it), the hard margin that is never violated when both fighters fit, and the seconds of velocity used to predict where a fighter is heading. */
  safeMarginX: number;
  safeMarginY: number;
  hardMarginX: number;
  hardMarginY: number;
  safeLeadSec: number;
}

export const DEFAULT_CAMERA_TUNING: Readonly<CameraTuning> = {
  halfLifeX: 0.42,
  halfLifeY: 0.72,
  lookaheadSec: 0.3,
  lookaheadMax: 64,
  marginX: 36,
  marginY: 28,
  shakeTau: 0.14, // e^(−0.4/0.14) ≈ 6 %: the felt tail is ~0.4 s
  shakeHzMin: 5,
  shakeHzMax: 9,
  zoomTau: 0.085,
  maxZoom: 1.06,
  rollHalfLife: 0.28,
  maxRoll: 1.5 * DEG,
  safeMarginX: 70,
  safeMarginY: 44,
  hardMarginX: 10,
  hardMarginY: 8,
  safeLeadSec: 0.12,
};

const DT = 1 / 60;
/** Critically damped: (1 + ωh)·e^(−ωh) = ½ at t = h  ⇒  ω·h ≈ 1.6783. */
const OMEGA_H = 1.6783469900166605;
const MAX_SHAKES = 8;

interface Shake {
  active: boolean;
  dirX: number;
  dirY: number;
  amp: number;
  age: number; // seconds
  hz: number;
  phase: number;
}

interface Spring {
  x: number;
  v: number;
}

/** Exact critically-damped step; mutates the spring. Stable for any dt. */
function springStep(s: Spring, target: number, omega: number, dt: number): void {
  const d = s.x - target;
  const e = Math.exp(-omega * dt);
  const j = s.v + omega * d;
  s.x = target + (d + j * dt) * e;
  s.v = (s.v - omega * j * dt) * e;
}

interface Pose {
  x: number;
  y: number;
  shakeX: number;
  shakeY: number;
  zoom: number;
  roll: number;
}

const copyPose = (dst: Pose, src: Pose): void => {
  dst.x = src.x;
  dst.y = src.y;
  dst.shakeX = src.shakeX;
  dst.shakeY = src.shakeY;
  dst.zoom = src.zoom;
  dst.roll = src.roll;
};

export function createCamera(tuning: Partial<CameraTuning> = {}): CameraApi {
  const T: CameraTuning = { ...DEFAULT_CAMERA_TUNING, ...tuning };
  const omegaX = OMEGA_H / T.halfLifeX;
  const omegaY = OMEGA_H / T.halfLifeY;
  const W = LOGICAL_W;
  const H = LOGICAL_H;

  const sx: Spring = { x: DEFAULT_ARENA.maxX / 2, v: 0 };
  const sy: Spring = { x: DEFAULT_ARENA.restY, v: 0 };
  const shakes: Shake[] = Array.from({ length: MAX_SHAKES }, () => ({
    active: false,
    dirX: 1,
    dirY: 0,
    amp: 0,
    age: 0,
    hz: 6,
    phase: 0,
  }));
  let shakeCursor = 0;
  let shakeCount = 0; // deterministic phase source (no RNG needed)

  let zoomPulse = 0;
  let zoomBias = 0;
  let roll = 0;
  let arena: ArenaInfo = DEFAULT_ARENA;

  // Target velocity estimation (from successive tick positions) and smoothed "activity" weights.
  let havePrev = false;
  let pax = 0;
  let pay = 0;
  let pbx = 0;
  let pby = 0;
  let wa = 1;
  let wb = 1;
  let lookX = 0;
  let lookY = 0;
  let teleportCooldown = 0;
  // Built-in director for ultimates and KOs (events carry everything it needs, so the app does not have to wire a focus).
  let dirActive = false;
  let dirX = 0;
  let dirY = 0;
  let dirAge = 0; // ticks since the ultimate started
  let dirRelease = 0; // 1 → 0 fade after 'end'
  let koHold = 0; // ticks of KO zoom-hold remaining

  const prev: Pose = { x: sx.x, y: sy.x, shakeX: 0, shakeY: 0, zoom: 1, roll: 0 };
  const cur: Pose = { x: sx.x, y: sy.x, shakeX: 0, shakeY: 0, zoom: 1, roll: 0 };
  const outState: CameraState = { x: 0, y: 0, zoom: 1, roll: 0, shakeX: 0, shakeY: 0 };
  const outView: ViewRect = { x0: 0, y0: 0, w: W, h: H };
  const out = { state: outState, view: outView };

  function addShake(dirX: number, dirY: number, amp: number): void {
    if (!(amp > 0)) return;
    const l = Math.hypot(dirX, dirY);
    const dx = l > 1e-6 ? dirX / l : 1;
    const dy = l > 1e-6 ? dirY / l : 0;
    const s = shakes[shakeCursor]!;
    shakeCursor = (shakeCursor + 1) % MAX_SHAKES;
    s.active = true;
    s.dirX = dx;
    s.dirY = dy;
    s.amp = Math.min(24, amp);
    s.age = 0;
    // Frequency and phase alternate deterministically so stacked hits do not beat in lock-step.
    const k = (shakeCount++ * 0.618034) % 1;
    s.hz = T.shakeHzMin + (T.shakeHzMax - T.shakeHzMin) * k;
    s.phase = 0;
  }

  function addZoom(amount: number): void {
    zoomPulse = clamp(zoomPulse + amount, 0, T.maxZoom - 1);
  }

  function addRoll(rad: number): void {
    roll = clamp(roll + rad, -T.maxRoll, T.maxRoll);
  }

  function consumeEvents(events: readonly SimEvent[]): void {
    let hadShake = false;
    let hadZoom = false;
    let hadRoll = false;
    for (const e of events) {
      if (e.t === 'ultimate') {
        if (e.phase === 'start') {
          dirActive = true;
          dirX = e.x;
          dirY = e.y;
          dirAge = 0;
          dirRelease = 1;
          addShake(0, -1, 5); // the charge-up thud
        } else if (dirActive) {
          dirActive = false; // release: fade over ~1 s (dirRelease counts down)
          addZoom(0.02);
        }
      } else if (e.t === 'ko') {
        koHold = 100; // ~1.7 s of held push-in while the sim runs in slow motion
      }
      if (e.t === 'shake') {
        hadShake = true;
        addShake(e.dirX, e.dirY, e.amp);
      } else if (e.t === 'zoom') {
        hadZoom = true;
        addZoom(e.amount);
      } else if (e.t === 'roll') {
        hadRoll = true;
        addRoll(e.radians);
      }
    }
    // Defensive: heavy blows still feel heavy if the fighter forgot to ask for it.
    for (const e of events) {
      if (e.t === 'hit') {
        const heft = clamp01(e.energy / 2200);
        if (!hadShake) addShake(e.dirX, e.dirY, (e.heavy ? 5 : 1.5) + heft * (e.heavy ? 9 : 4));
        if (!hadZoom && e.heavy) addZoom(0.012 + 0.03 * heft);
        if (!hadRoll && e.heavy) addRoll((e.dirX >= 0 ? 1 : -1) * 0.004 * (0.5 + heft));
      } else if (e.t === 'ko') {
        addShake(1, -0.3, 16);
        addZoom(0.05);
        if (!hadRoll) addRoll(0.012);
      }
    }
  }

  /** Sum of all live shake oscillators → (x, y) in px. Also ages them. */
  function stepShake(out2: { x: number; y: number }): void {
    let ox = 0;
    let oy = 0;
    for (const s of shakes) {
      if (!s.active) continue;
      s.age += DT;
      const env = Math.exp(-s.age / T.shakeTau);
      if (env < 0.01) {
        s.active = false;
        continue;
      }
      const w = 2 * Math.PI * s.hz * s.age + s.phase;
      const main = s.amp * env * Math.cos(w);
      // A little perpendicular motion so the shake wobbles instead of ruler-sliding.
      const perp = s.amp * env * 0.3 * Math.sin(w * 0.87);
      ox += s.dirX * main - s.dirY * perp;
      oy += s.dirY * main + s.dirX * perp;
    }
    out2.x = ox;
    out2.y = oy;
  }

  const shakeTmp = { x: 0, y: 0 };

  function clampCentre(cx: number, cy: number, a: ArenaInfo, o: { x: number; y: number }): void {
    const minCx = a.minX + W / 2;
    const maxCx = a.maxX - W / 2;
    const minCy = a.minY + H / 2;
    const maxCy = a.maxY - H / 2;
    o.x = maxCx < minCx ? (a.minX + a.maxX) / 2 : clamp(cx, minCx, maxCx);
    o.y = maxCy < minCy ? (a.minY + a.maxY) / 2 : clamp(cy, minCy, maxCy);
  }
  const centreTmp = { x: 0, y: 0 };

  /**
   * Edge safety: the heavy springs are for calm play. A fighter launched at 20 px/tick must never leave the frame, so after the
   * springs step, the camera centre is pushed into the range that keeps every fighter (now AND where its velocity is taking it)
   * inside a soft inner margin — with a catch-up spring that grows as the fighter nears the edge — and, absolutely, inside a hard margin.
   * Ranges that cannot be met (fighters too far apart to fit) are skipped, never fought over; the union is then centred by the framing.
   */
  function edgeSafety(
    a: CameraTargets['a'],
    b: CameraTargets['b'],
    vax: number,
    vay: number,
    vbx: number,
    vby: number,
  ): void {
    const L = T.safeLeadSec;
    const ax2 = a.x + vax * L;
    const bx2 = b.x + vbx * L;
    const ay2 = a.y + vay * L;
    const by2 = b.y + vby * L;
    const left = Math.min(a.x - a.hw, b.x - b.hw, ax2 - a.hw, bx2 - b.hw);
    const right = Math.max(a.x + a.hw, b.x + b.hw, ax2 + a.hw, bx2 + b.hw);
    const top = Math.min(a.y - a.hh, b.y - b.hh, ay2 - a.hh, by2 - b.hh);
    const bottom = Math.max(a.y + a.hh, b.y + b.hh, ay2 + a.hh, by2 + b.hh);
    // the renderer's micro-zoom crops the view: keep the fighters inside what is actually visible
    const zf = 1 + zoomBias + zoomPulse * 0.6;
    pull(sx, left, right, W / zf, T.safeMarginX, T.hardMarginX);
    pull(sy, top, bottom, H / zf, T.safeMarginY, T.hardMarginY);
  }

  function pull(sp: Spring, lo: number, hi: number, size: number, soft: number, hard: number): void {
    for (const m of [soft, hard]) {
      const minC = hi + m - size / 2; // camera centre must be at least this (right edge of the union inside the view)
      const maxC = lo - m + size / 2; // and at most this
      if (minC > maxC) continue;
      let over = 0;
      if (sp.x < minC) over = minC - sp.x;
      else if (sp.x > maxC) over = maxC - sp.x;
      if (over === 0) continue;
      const hardPass = m === hard;
      // catch-up grows with depth into the margin (4 % of the shortfall per tick at the margin line, up to 50 %), and is total at the hard margin
      const gain = hardPass ? 1 : clamp(0.04 + (0.5 * Math.abs(over)) / soft, 0.04, 0.5);
      sp.x += over * gain;
      if (sp.v * over < 0) sp.v = 0;
      else sp.v += over * gain * 8;
    }
  }

  const api: CameraApi = {
    reset(x, y) {
      clampCentre(x, y, arena, centreTmp);
      sx.x = centreTmp.x;
      sx.v = 0;
      sy.x = centreTmp.y;
      sy.v = 0;
      for (const s of shakes) s.active = false;
      zoomPulse = 0;
      zoomBias = 0;
      roll = 0;
      havePrev = false;
      teleportCooldown = 0;
      dirActive = false;
      dirRelease = 0;
      koHold = 0;
      lookX = 0;
      lookY = 0;
      wa = 1;
      wb = 1;
      cur.x = sx.x;
      cur.y = sy.x;
      cur.shakeX = 0;
      cur.shakeY = 0;
      cur.zoom = 1;
      cur.roll = 0;
      copyPose(prev, cur);
    },

    tick(targets: CameraTargets, events: readonly SimEvent[]) {
      copyPose(prev, cur);
      arena = targets.arena;
      const { a, b } = targets;

      // ---- target velocities → activity weights and lookahead (all smoothed; no jitter when a fighter stops) ----
      if (!havePrev) teleportCooldown = 45; // first sight of the fighters: nothing to predict from
      let vax = 0;
      let vay = 0;
      let vbx = 0;
      let vby = 0;
      if (havePrev) {
        vax = (a.x - pax) / DT;
        vay = (a.y - pay) / DT;
        vbx = (b.x - pbx) / DT;
        vby = (b.y - pby) / DT;
      }
      havePrev = true;
      pax = a.x;
      pay = a.y;
      pbx = b.x;
      pby = b.y;
      const k = 1 - Math.pow(0.5, DT / 0.25);
      wa += (1 + 1.6 * clamp01(Math.hypot(vax, vay) / 240) - wa) * k;
      wb += (1 + 1.6 * clamp01(Math.hypot(vbx, vby) / 240) - wb) * k;
      const kl = 1 - Math.pow(0.5, DT / 0.35);
      lookX += ((vax + vbx) * 0.5 - lookX) * kl;
      lookY += ((vay + vby) * 0.5 - lookY) * kl;

      const wsum = wa + wb;
      let tx = (a.x * wa + b.x * wb) / wsum + clamp(lookX * T.lookaheadSec, -T.lookaheadMax, T.lookaheadMax);
      // Vertical follow uses a smaller lookahead: jumps should not yank the frame.
      let ty =
        (a.y * wa + b.y * wb) / wsum +
        clamp(lookY * T.lookaheadSec * 0.4, -T.lookaheadMax * 0.4, T.lookaheadMax * 0.4);

      // ---- both fighters must stay on screen while the framing leans toward the active one ----
      const left = Math.min(a.x - a.hw, b.x - b.hw);
      const right = Math.max(a.x + a.hw, b.x + b.hw);
      if (right - left <= W - 2 * T.marginX) {
        tx = clamp(tx, right + T.marginX - W / 2, left - T.marginX + W / 2);
      } else {
        tx = (left + right) / 2; // cannot fit with margins: centre the union so both are clipped equally
      }
      const top = Math.min(a.y - a.hh, b.y - b.hh);
      const bottom = Math.max(a.y + a.hh, b.y + b.hh);
      if (bottom - top <= H - 2 * T.marginY) {
        ty = clamp(ty, bottom + T.marginY - H / 2, top - T.marginY + H / 2);
      } else {
        ty = (top + bottom) / 2;
      }

      // ---- director focus (ultimate choreography) ----
      let zoomTarget = 0;
      const f = targets.focus;
      if (f && f.weight > 0) {
        const w = clamp01(f.weight);
        tx = lerp(tx, f.x, w);
        ty = lerp(ty, f.y, w);
        zoomTarget = clamp(f.zoom, 0, T.maxZoom - 1) * w;
      }
      // ---- built-in ultimate director: lean toward the caster, then a slow push-in that never exceeds the zoom cap ----
      // The fighters' framing still wins at the edges (edge safety below), so the opponent is never lost.
      if (dirActive || dirRelease > 0) {
        if (dirActive) {
          dirAge++;
          if (dirAge > 300) dirActive = false; // 5 s hard limit: a missed 'end' event must not trap the camera
        } else dirRelease = Math.max(0, dirRelease - DT / 1.0);
        const ramp = dirActive ? clamp01(dirAge / 40) : dirRelease; // 0.67 s ease-in, 1 s ease-out
        const push = clamp01(dirAge / 240); // the slow push across ~4 s
        const w = 0.55 * ramp;
        tx = lerp(tx, dirX, w);
        ty = lerp(ty, dirY, w * 0.6);
        zoomTarget = Math.max(zoomTarget, (0.02 + 0.015 * push) * ramp);
      }
      if (koHold > 0) {
        koHold--;
        zoomTarget = Math.max(zoomTarget, 0.03 * clamp01(koHold / 30));
      }
      const kz = 1 - Math.pow(0.5, DT / 0.3);
      zoomBias += (zoomTarget - zoomBias) * kz;

      clampCentre(tx, ty, arena, centreTmp);
      springStep(sx, centreTmp.x, omegaX, DT);
      springStep(sy, centreTmp.y, omegaY, DT);
      // A jump of more than 96 px in one tick is a teleport (round reset, scripted move), not a launch: the renderer treats it the same way.
      if (Math.max(Math.abs(vax), Math.abs(vay), Math.abs(vbx), Math.abs(vby)) * DT > 96)
        teleportCooldown = 45;
      if (teleportCooldown > 0) teleportCooldown--;
      else edgeSafety(a, b, vax, vay, vbx, vby);

      // ---- impulses ----
      consumeEvents(events);
      stepShake(shakeTmp);
      zoomPulse *= Math.exp(-DT / T.zoomTau);
      if (zoomPulse < 1e-4) zoomPulse = 0;
      roll *= Math.pow(0.5, DT / T.rollHalfLife);
      if (Math.abs(roll) < 1e-5) roll = 0;

      cur.x = sx.x;
      cur.y = sy.x;
      cur.shakeX = shakeTmp.x;
      cur.shakeY = shakeTmp.y;
      cur.zoom = clamp(1 + zoomPulse + zoomBias, 1, T.maxZoom);
      cur.roll = clamp(roll, -T.maxRoll, T.maxRoll);
    },

    sample(alpha: number) {
      const t = clamp01(alpha);
      const x = lerp(prev.x, cur.x, t);
      const y = lerp(prev.y, cur.y, t);
      // Integer-snap the shake, then the view; the state reports what is actually used.
      const shx = Math.round(lerp(prev.shakeX, cur.shakeX, t));
      const shy = Math.round(lerp(prev.shakeY, cur.shakeY, t));
      outState.x = x;
      outState.y = y;
      outState.shakeX = shx;
      outState.shakeY = shy;
      outState.zoom = lerp(prev.zoom, cur.zoom, t);
      outState.roll = lerp(prev.roll, cur.roll, t);
      const x0 = Math.round(x + shx - W / 2);
      const y0 = Math.round(y + shy - H / 2);
      const maxX0 = Math.round(arena.maxX - W);
      const maxY0 = Math.round(arena.maxY - H);
      const minX0 = Math.round(arena.minX);
      const minY0 = Math.round(arena.minY);
      outView.x0 = maxX0 < minX0 ? Math.round((arena.minX + arena.maxX - W) / 2) : clamp(x0, minX0, maxX0);
      outView.y0 = maxY0 < minY0 ? Math.round((arena.minY + arena.maxY - H) / 2) : clamp(y0, minY0, maxY0);
      outView.w = W;
      outView.h = H;
      return out;
    },
  };
  api.reset(DEFAULT_ARENA.maxX / 2, DEFAULT_ARENA.restY);
  return api;
}
