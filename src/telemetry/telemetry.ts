import type { FighterView, FrameFx, MatchApi, RenderLayer, SimEvent, ViewRect } from '@/contracts';
import type { AudioMeter } from './audioMeter';
import { LUFS_FLOOR } from './loudness';

/**
 * Evidence telemetry (Phase 0 tooling, presentation side only — it never feeds back into the simulation).
 *
 * Measures, against SLICE §4:
 *  - input → first visible response: wall time from the device event (keyboard `timeStamp`, `Gamepad.timestamp`) to the
 *    end of the `renderer.draw` that first shows the fighter's response (a move/surge/guard/charge start, or the body
 *    accelerating along a fresh stick deflection). Display scan-out is not included (unmeasurable in a page).
 *  - settle: from a response until the fighter is back at rest (idle/move state, speed < 8 px/s for 6 ticks).
 *  - wound sequence of every heavy hit: FX occlusion of a box around the contact (screen FX layers + additive glow layers +
 *    the full-screen flash), its peak and clear times, and the first slab detach of the target (shear latency, size).
 *  - pacing: hits / distinct contacts / length of every round.
 *  - flashes: full-frame mean relative luminance per frame (optional 32×18 read-back), max change within 100 ms, flashes/s.
 *  - audio: EBU R128 on the speaker output and on the score bus; impact rise above the bed; bed duck depth.
 */

export interface TelemetryReport {
  frames: number;
  wallSec: number;
  fps: {
    mean: number;
    p1Low: number;
    longFrames: number;
    worstMs: number;
    /** Seconds since the first frame of every frame > 25 ms, with its length: [t, ms]. */
    long: [number, number][];
  };
  simMs: { mean: number; p99: number; max: number };
  /** Input → end of the draw of the frame containing the tick that ACCEPTED the command (state/event level). */
  inputLatencyMs: number[];
  /**
   * Input → end of the draw of the first frame in which the fighter's drawn root transform actually moved (≥ 1 px in x
   * or an integer lean change vs the frame before the command; y is ignored because of the idle bob). The honest
   * "first visible response" until fighters report their own pixel-level response (Phase 1). Eye/charge-light changes
   * that move no root pixel are NOT counted, so this can over-state latency for moves whose first cue is a light.
   */
  pixelLatencyMs: number[];
  /**
   * Fighter-reported feel (SimEvent 'feel', Phase 1+): ticks from accepting a command to its first drawn pixel
   * (`respond`, with the pixel channel) and to rest (`settle`), per command. The sim-side truth behind pixelLatencyMs.
   */
  feel: { slot: number; kind: 'respond' | 'settle'; cmd: string; ticks: number; channel?: string }[];
  settleMs: number[];
  wounds: WoundRecord[];
  rounds: RoundRecord[];
  flash: { maxDelta100ms: number; maxRelDelta100ms: number; maxFlashesPerSec: number; series?: number[] };
  audio: AudioSummary | null;
}

export interface WoundRecord {
  tick: number;
  attacker: 0 | 1;
  target: 0 | 1;
  energy: number;
  type: string;
  /** ms from the impact frame to the FX occlusion peak, and until it stays below 10 %; -1 = never measured. */
  fxPeakMs: number;
  fxPeak: number;
  fxClearMs: number;
  /** ms from impact to the target's first detached slab (≥ 5 mass), its mass, and total detached in 1.5 s; -1 = none. */
  shearMs: number;
  firstSlabMass: number;
  detachedMass: number;
  /** Mass the body lost within 2 ticks of the hit (D1 instant-cut evidence). */
  instantMass: number;
  wallMs: number;
}

export interface RoundRecord {
  round: number;
  seconds: number;
  hits: number;
  contacts: number;
  heavyHits: number;
  winner: number;
  end: string;
}

export interface AudioSummary {
  integrated: number;
  truePeak: number;
  range: number;
  bedIntegrated: number;
  /** Per heavy hit: master momentary peak in the 0.7 s after the hit minus the bed (score bus) median in the 3 s before. */
  impactOverBedDb: number[];
  /** Same, short-term loudness (3 s window), as the brief words it. */
  impactOverBedShortDb: number[];
  /** Per heavy hit: score-bus momentary dip (dB) in the 0.7 s after the hit and how long it stays ≥ 3 dB down (ms). */
  duckDb: number[];
  duckMs: number[];
}

interface PendingInput {
  t: number;
  kind: 'button' | 'stick';
  dx: number;
  dy: number;
}

interface Wound {
  rec: WoundRecord;
  x: number;
  y: number;
  r: number;
  hitWall: number;
  cleanFrames: number;
  done: boolean;
  massBefore: number;
  massAtHit: number;
}

const HEAVY_ENERGY = 400;
const RESPONSE_EVENTS = new Set(['move', 'surge', 'guard', 'charge']);
const pct = (a: number[], p: number): number => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!;
};
const median = (a: number[]): number => pct(a, 0.5);
const srgbToLin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

export class Telemetry {
  /** Slots driven by a human (input latency / settle are only meaningful for them). */
  humanSlots: [boolean, boolean] = [false, false];
  /**
   * Fallback flash metering: a 32×18 canvas snapshot per frame (≈ −12 fps on WJ's iGPU, D24). Off by default: the
   * renderer's luminance governor reads its own mean back asynchronously and the app feeds it in through `pushLuma`.
   */
  flashMeter = false;
  /** Accept the renderer's GPU luminance samples (`pushLuma`); `lum=0` turns flash metering off entirely. */
  collectLuma = true;
  master: AudioMeter | null = null;
  bed: AudioMeter | null = null;

  private pending: PendingInput[] = [];
  private respondedTicks: { slot: 0 | 1; tick: number }[] = [];
  private readonly latency: number[] = [];
  private readonly pixelLatency: number[] = [];
  private readonly feel: TelemetryReport['feel'] = [];
  /** Per slot: the drawn root transform of the previous frame, and a command waiting for its first visible pixel. */
  private readonly drawn: [{ x: number; y: number; lean: number }, { x: number; y: number; lean: number }] = [
    { x: 0, y: 0, lean: 0 },
    { x: 0, y: 0, lean: 0 },
  ];
  private readonly awaitingPixel: [
    { t: number; x: number; y: number; lean: number } | null,
    { t: number; x: number; y: number; lean: number } | null,
  ] = [null, null];
  private readonly settle: number[] = [];
  private readonly settleFrom: [number, number] = [-1, -1];
  private readonly restTicks: [number, number] = [0, 0];
  private readonly prevV: [{ vx: number; vy: number }, { vx: number; vy: number }] = [
    { vx: 0, vy: 0 },
    { vx: 0, vy: 0 },
  ];
  private stickArmed: PendingInput | null = null;
  private readonly wounds: Wound[] = [];
  private readonly woundLog: WoundRecord[] = [];
  private readonly rounds: RoundRecord[] = [];
  private round = { n: 0, start: -1, hits: 0, heavy: 0, contacts: new Set<number>() };
  private readonly moveStart: [number, number] = [0, 0];
  private readonly massHist: [number[], number[]] = [[], []];
  private freshWounds: Wound[] = [];
  private frames = 0;
  private wall0 = -1;
  private wallLast = 0;
  private readonly frameDt: number[] = [];
  readonly simSamples: number[] = [];
  private readonly lum: number[] = [];
  private lumCtx: OffscreenCanvasRenderingContext2D | null = null;
  private lumBusy = 0;
  private keepLumSeries = false;
  private readonly gpPrev = new Map<number, { b: boolean[]; ax: number; ay: number }>();
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const dir = KEY_DIRS[e.code];
    if (dir) this.noteStick(e.timeStamp, dir[0], dir[1]);
    else this.pending.push({ t: e.timeStamp, kind: 'button', dx: 0, dy: 0 });
  };

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKey, { capture: true });
  }
  detach(target: Window): void {
    target.removeEventListener('keydown', this.onKey, { capture: true });
  }

  private noteStick(t: number, dx: number, dy: number): void {
    const p: PendingInput = { t, kind: 'stick', dx, dy };
    this.pending.push(p);
    this.stickArmed = p;
  }

  /** Start of a rendered frame: gamepad edges carry the browser's own receive timestamp. */
  beginFrame(now: number, pads: readonly (Gamepad | null)[] | null): void {
    if (this.wall0 < 0) this.wall0 = now;
    if (this.frames > 0) this.frameDt.push(now - this.wallLast);
    this.wallLast = now;
    this.frames++;
    if (pads) {
      for (const gp of pads) {
        if (!gp) continue;
        const prev = this.gpPrev.get(gp.index);
        const b = gp.buttons.map((x) => x.pressed);
        const ax = gp.axes[0] ?? 0;
        const ay = gp.axes[1] ?? 0;
        if (prev) {
          for (let i = 0; i < b.length; i++)
            if (b[i] && !prev.b[i]) this.pending.push({ t: gp.timestamp, kind: 'button', dx: 0, dy: 0 });
          const wasOut = Math.hypot(prev.ax, prev.ay) > 0.5;
          const isOut = Math.hypot(ax, ay) > 0.5;
          if (isOut && !wasOut) this.noteStick(gp.timestamp, ax, ay);
        }
        this.gpPrev.set(gp.index, { b, ax, ay });
      }
    }
    // inputs nobody answered within 0.6 s were not commands (menu keys, held directions into a wall…)
    while (this.pending.length && now - this.pending[0]!.t > 600) this.pending.shift();
  }

  /** After every sim tick. `events` are this tick's events. */
  afterTick(m: MatchApi, events: readonly SimEvent[], simMs: number): void {
    this.simSamples.push(simMs);
    for (const e of events) {
      if (e.t === 'round') this.onRound(m, e.phase, e.winner);
      else if (e.t === 'move') this.moveStart[e.slot] = m.tick;
      else if (e.t === 'hit' && m.phase === 'fight') this.onHit(m, e);
      else if (e.t === 'matter' && e.kind === 'detach' && e.slot !== -1) this.onDetach(m, e.slot, e.mass);
      else if (e.t === 'feel' && e.kind !== 'accept' && this.feel.length < 5000)
        this.feel.push({ slot: e.slot, kind: e.kind, cmd: e.cmd, ticks: e.ticks, channel: e.channel });
    }
    for (const s of [0, 1] as const) {
      const v = m.fighters[s].view;
      const hist = this.massHist[s];
      hist.push(v.bodyStats.mass);
      if (hist.length > 4) hist.shift();
      if (this.humanSlots[s]) this.trackResponse(m, s, v, events);
      this.prevV[s].vx = v.vx;
      this.prevV[s].vy = v.vy;
    }
    for (const w of this.wounds) {
      if (w.done) continue;
      const age = m.tick - w.rec.tick;
      if (age === 2) {
        const v = m.fighters[w.rec.target].view;
        w.rec.instantMass = Math.max(0, w.massAtHit - v.bodyStats.mass);
      }
    }
  }

  private trackResponse(m: MatchApi, s: 0 | 1, v: FighterView, events: readonly SimEvent[]): void {
    let responded = false;
    for (const e of events)
      if (RESPONSE_EVENTS.has(e.t) && 'slot' in e && e.slot === s) {
        if (e.t === 'charge' && e.phase !== 'start') continue;
        responded = true;
      }
    const stick = this.stickArmed;
    if (!responded && stick) {
      const ax = v.vx - this.prevV[s].vx;
      const ay = v.vy - this.prevV[s].vy;
      const len = Math.hypot(stick.dx, stick.dy) || 1;
      if ((ax * stick.dx + ay * stick.dy) / len > 0.5) responded = true;
    }
    if (responded && this.pending.length) {
      this.respondedTicks.push({ slot: s, tick: m.tick });
      this.settleFrom[s] = m.tick;
      this.restTicks[s] = 0;
    }
    // settle: back in a neutral state and (nearly) still for 6 consecutive ticks
    if (this.settleFrom[s] >= 0) {
      const rest = (v.state === 'idle' || v.state === 'move') && Math.hypot(v.vx, v.vy) < 8;
      this.restTicks[s] = rest ? this.restTicks[s] + 1 : 0;
      const span = m.tick - this.settleFrom[s];
      if (this.restTicks[s] >= 6) {
        this.settle.push(((span - 6) * 1000) / 60);
        this.settleFrom[s] = -1;
      } else if (span > 180) this.settleFrom[s] = -1;
    }
  }

  private onRound(m: MatchApi, phase: string, winner: number): void {
    if (phase === 'fight') {
      this.round = { n: m.round, start: m.tick, hits: 0, heavy: 0, contacts: new Set() };
    } else if ((phase === 'ko' || phase === 'timeover') && this.round.start >= 0) {
      this.rounds.push({
        round: this.round.n,
        seconds: (m.tick - this.round.start) / 60,
        hits: this.round.hits,
        contacts: this.round.contacts.size,
        heavyHits: this.round.heavy,
        winner,
        end: phase,
      });
      this.round.start = -1;
    }
  }

  private onHit(m: MatchApi, e: Extract<SimEvent, { t: 'hit' }>): void {
    this.round.hits++;
    this.round.contacts.add(e.attacker * 1e7 + this.moveStart[e.attacker]);
    if (e.energy < HEAVY_ENERGY && !e.heavy) return;
    this.round.heavy++;
    const tv = m.fighters[e.target].view;
    const hist = this.massHist[e.target];
    const rec: WoundRecord = {
      tick: m.tick,
      attacker: e.attacker,
      target: e.target,
      energy: Math.round(e.energy),
      type: e.type,
      fxPeakMs: -1,
      fxPeak: 0,
      fxClearMs: -1,
      shearMs: -1,
      firstSlabMass: 0,
      detachedMass: 0,
      instantMass: 0,
      wallMs: 0,
    };
    const w: Wound = {
      rec,
      x: e.x,
      y: e.y,
      r: 26,
      hitWall: -1,
      cleanFrames: 0,
      done: false,
      massBefore: hist.length > 1 ? hist[0]! : tv.bodyStats.mass,
      massAtHit: hist.length ? hist[hist.length - 1]! : tv.bodyStats.mass,
    };
    this.wounds.push(w);
    this.freshWounds.push(w);
    this.woundLog.push(rec);
  }

  private onDetach(m: MatchApi, slot: 0 | 1, mass: number): void {
    for (let i = this.wounds.length - 1; i >= 0; i--) {
      const w = this.wounds[i]!;
      if (w.rec.target !== slot) continue;
      const age = m.tick - w.rec.tick;
      if (age < 0 || age > 90) continue;
      w.rec.detachedMass += mass;
      if (w.rec.shearMs < 0 && mass >= 5) {
        w.rec.shearMs = Math.round((age * 1000) / 60);
        w.rec.firstSlabMass = Math.round(mass);
      }
      return;
    }
  }

  /** After `renderer.draw`: stamps responses on this frame and measures FX occlusion and full-frame luminance. */
  afterDraw(
    now: number,
    layers: readonly RenderLayer[],
    fx: FrameFx,
    view: ViewRect,
    alpha: number,
    canvas: HTMLCanvasElement | null,
  ): void {
    // the drawn (interpolated, integer) root transform of each titan this frame
    const cur: ({ x: number; y: number; lean: number } | null)[] = [null, null];
    for (const L of layers) {
      if (L.id === 'titan-0' || L.id === 'titan-1') {
        const s = L.id === 'titan-0' ? 0 : 1;
        cur[s] = {
          x: Math.round(L.prevX + (L.x - L.prevX) * alpha),
          y: Math.round(L.prevY + (L.y - L.prevY) * alpha),
          lean: Math.round(L.lean),
        };
      }
    }
    for (const s of [0, 1] as const) {
      const a = this.awaitingPixel[s];
      const c = cur[s];
      // y is excluded: the idle bob moves bodies vertically on its own and would fake a response
      if (a && c && (c.x !== a.x || c.lean !== a.lean)) {
        this.pixelLatency.push(now - a.t);
        this.awaitingPixel[s] = null;
      } else if (a && now - a.t > 600) this.awaitingPixel[s] = null;
    }
    for (let i = 0; i < this.respondedTicks.length && this.pending.length; i++) {
      const p = this.pending.shift()!;
      const s = this.respondedTicks[i]!.slot;
      this.latency.push(now - p.t);
      if (p === this.stickArmed) this.stickArmed = null;
      // compare future frames against what was on screen BEFORE this command's frame
      const prev = this.drawn[s];
      const c = cur[s];
      if (c && (c.x !== prev.x || c.lean !== prev.lean)) this.pixelLatency.push(now - p.t);
      else this.awaitingPixel[s] = { t: p.t, x: prev.x, y: prev.y, lean: prev.lean };
    }
    this.respondedTicks.length = 0;
    for (const s of [0, 1] as const) {
      const c = cur[s];
      if (c) this.drawn[s] = c;
    }
    for (const w of this.freshWounds) {
      w.hitWall = now;
      w.rec.wallMs = now;
    }
    this.freshWounds.length = 0;
    for (const w of this.wounds) {
      if (w.done || w.hitWall < 0) continue;
      const age = now - w.hitWall;
      const occ = Math.max(Math.min(1, fx.flash * 2), coverage(layers, view, w.x, w.y, w.r));
      if (occ > w.rec.fxPeak && age <= 1000) {
        w.rec.fxPeak = occ;
        w.rec.fxPeakMs = Math.round(age);
      }
      if (occ < 0.1) {
        if (++w.cleanFrames >= 3 && w.rec.fxClearMs < 0) w.rec.fxClearMs = Math.round(age - 2 * 16.7);
      } else {
        w.cleanFrames = 0;
        w.rec.fxClearMs = -1;
      }
      if (age > 2500) w.done = true;
    }
    if (this.wounds.length > 64) this.wounds.splice(0, this.wounds.length - 64);
    if (this.flashMeter && canvas) this.frameLuminance(canvas);
  }

  /**
   * Mean relative luminance of the displayed frame, measured from a 32×18 GPU-side downscale (createImageBitmap) so
   * the frame never waits on a synchronous read-back. Results land in order, one per frame; a frame whose snapshot is
   * still in flight after 3 others is skipped (and counted) rather than stalling.
   */
  private frameLuminance(canvas: HTMLCanvasElement): void {
    if (this.lumBusy > 3) return;
    const idx = this.lum.length;
    this.lum.push(-1);
    this.lumBusy++;
    void createImageBitmap(canvas, { resizeWidth: 32, resizeHeight: 18, resizeQuality: 'medium' })
      .then((bmp) => {
        this.lumCtx ??= new OffscreenCanvas(32, 18).getContext('2d', { willReadFrequently: true });
        const c = this.lumCtx;
        if (!c) return;
        c.drawImage(bmp, 0, 0);
        bmp.close();
        const d = c.getImageData(0, 0, 32, 18).data;
        let y = 0;
        for (let i = 0; i < d.length; i += 4)
          y += 0.2126 * srgbToLin(d[i]!) + 0.7152 * srgbToLin(d[i + 1]!) + 0.0722 * srgbToLin(d[i + 2]!);
        this.lum[idx] = y / (d.length / 4);
      })
      .finally(() => this.lumBusy--);
  }

  /** One frame's mean relative luminance (UI excluded) from the renderer's async GPU read-back, in frame order. */
  pushLuma(mean: number): void {
    if (this.collectLuma && Number.isFinite(mean)) this.lum.push(mean);
  }

  /** Keep the per-frame luminance series in the report (for plots in gate docs). */
  keepLuminanceSeries(on: boolean): void {
    this.keepLumSeries = on;
  }

  private flashStats(): TelemetryReport['flash'] {
    const L = this.lum.filter((x) => x >= 0);
    let maxD = 0;
    let maxRel = 0;
    for (let i = 1; i < L.length; i++) {
      for (let k = 1; k <= 6 && i - k >= 0; k++) {
        const d = Math.abs(L[i]! - L[i - k]!);
        if (d > maxD) maxD = d;
        const base = Math.max(0.01, Math.min(L[i]!, L[i - k]!));
        if (d / base > maxRel) maxRel = d / base;
      }
    }
    // WCAG-style flash: an opposing pair of changes ≥ 0.1 relative luminance where the darker state is below 0.8
    const turns: number[] = [];
    let dir = 0;
    let anchor = L[0] ?? 0;
    for (let i = 1; i < L.length; i++) {
      const d = L[i]! - anchor;
      if (Math.abs(d) >= 0.1 && Math.min(L[i]!, anchor) < 0.8) {
        const nd = Math.sign(d);
        if (nd !== dir) {
          turns.push(i);
          dir = nd;
        }
        anchor = L[i]!;
      } else if ((dir > 0 && L[i]! > anchor) || (dir < 0 && L[i]! < anchor)) anchor = L[i]!;
    }
    let maxPerSec = 0;
    for (let i = 0; i < turns.length; i++) {
      let n = 0;
      for (let j = i; j < turns.length && turns[j]! - turns[i]! < 60; j++) n++;
      maxPerSec = Math.max(maxPerSec, Math.floor(n / 2));
    }
    return {
      maxDelta100ms: +maxD.toFixed(4),
      maxRelDelta100ms: +maxRel.toFixed(3),
      maxFlashesPerSec: maxPerSec,
      series: this.keepLumSeries ? L.map((x) => +x.toFixed(4)) : undefined,
    };
  }

  private audioStats(): AudioSummary | null {
    const M = this.master;
    if (!M || !M.acc.series.length) return null;
    const B = this.bed;
    const over: number[] = [];
    const overS: number[] = [];
    const duck: number[] = [];
    const duckMs: number[] = [];
    for (const w of this.woundLog) {
      if (w.wallMs <= 0) continue;
      const after = M.between(w.wallMs, w.wallMs + 700);
      if (!after.length) continue;
      const peak = Math.max(...after.map((s) => s.momentary));
      const peakS = Math.max(...after.map((s) => s.shortTerm));
      if (B) {
        const before = B.between(w.wallMs - 3000, w.wallMs - 150).map((s) => s.momentary);
        const bedAfter = B.between(w.wallMs, w.wallMs + 700);
        if (before.length) {
          const bed = median(before.filter((x) => x > LUFS_FLOOR));
          over.push(+(peak - bed).toFixed(1));
          overS.push(+(peakS - bed).toFixed(1));
          if (bedAfter.length) {
            const dip = bed - Math.min(...bedAfter.map((s) => s.momentary));
            duck.push(+dip.toFixed(1));
            duckMs.push(bedAfter.filter((s) => bed - s.momentary >= 3).length * 100);
          }
        }
      }
    }
    return {
      integrated: +M.acc.integrated.toFixed(1),
      truePeak: +M.acc.truePeak.toFixed(1),
      range: +M.acc.range.toFixed(1),
      bedIntegrated: B ? +B.acc.integrated.toFixed(1) : LUFS_FLOOR,
      impactOverBedDb: over,
      impactOverBedShortDb: overS,
      duckDb: duck,
      duckMs,
    };
  }

  private longFrames(): [number, number][] {
    const out: [number, number][] = [];
    let t = 0;
    for (const d of this.frameDt) {
      t += d;
      if (d > 25) out.push([+(t / 1000).toFixed(2), +d.toFixed(1)]);
    }
    return out;
  }

  report(): TelemetryReport {
    const dt = this.frameDt;
    const sorted = dt.slice().sort((a, b) => b - a);
    const worst1 = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 100)));
    const meanDt = dt.length ? dt.reduce((a, b) => a + b, 0) / dt.length : 0;
    const sim = this.simSamples;
    return {
      frames: this.frames,
      wallSec: +((this.wallLast - this.wall0) / 1000).toFixed(2),
      fps: {
        mean: meanDt ? +(1000 / meanDt).toFixed(1) : 0,
        p1Low: worst1.length ? +(1000 / (worst1.reduce((a, b) => a + b, 0) / worst1.length)).toFixed(1) : 0,
        longFrames: dt.filter((x) => x > 25).length,
        worstMs: +(sorted[0] ?? 0).toFixed(1),
        long: this.longFrames(),
      },
      simMs: {
        mean: sim.length ? +(sim.reduce((a, b) => a + b, 0) / sim.length).toFixed(3) : 0,
        p99: +pct(sim, 0.99).toFixed(3),
        max: +Math.max(0, ...sim).toFixed(3),
      },
      inputLatencyMs: this.latency.map((x) => +x.toFixed(1)),
      pixelLatencyMs: this.pixelLatency.map((x) => +x.toFixed(1)),
      feel: this.feel.slice(),
      settleMs: this.settle.map((x) => Math.round(x)),
      wounds: this.woundLog.slice(),
      rounds: this.rounds.slice(),
      flash: this.flashStats(),
      audio: this.audioStats(),
    };
  }

  /** Two short lines for the overlay. */
  summaryLines(): [string, string] {
    const lat = this.latency;
    const last = (a: number[]): string => (a.length ? Math.round(a[a.length - 1]!).toString() : '-');
    const w = this.woundLog[this.woundLog.length - 1];
    const r = this.round;
    const M = this.master?.acc;
    const done = this.lum.filter((x) => x >= 0).slice(-2);
    const f = done.length > 1 ? Math.abs(done[1]! - done[0]!) : 0;
    const dt = this.frameDt.slice(-60);
    const fps = dt.length ? 1000 / (dt.reduce((a, b) => a + b, 0) / dt.length) : 0;
    const sim = this.simSamples.slice(-120);
    const lufsTxt = (v: number | undefined): string =>
      v === undefined || v <= LUFS_FLOOR ? '-' : v.toFixed(1);
    return [
      `IN>ACC ${last(lat)}MS IN>PX ${last(this.pixelLatency)}MS  SETTLE ${last(this.settle)}MS  ` +
        `FX PK ${w ? w.fxPeakMs : '-'} CLR ${w ? w.fxClearMs : '-'}MS  SHEAR ${w ? w.shearMs : '-'}MS ` +
        `SLAB ${w ? w.firstSlabMass : '-'} CUT2T ${w ? Math.round(w.instantMass) : '-'}  ` +
        `R${r.n} HITS ${r.hits} C ${r.contacts.size}`,
      `LUFS M ${lufsTxt(M?.momentary)} S ${lufsTxt(M?.shortTerm)} I ${lufsTxt(M?.integrated)} ` +
        `TP ${lufsTxt(M?.truePeak)} LRA ${M ? M.range.toFixed(1) : '-'}  DLUM ${f.toFixed(3)}  ` +
        `FPS ${fps.toFixed(0)}  SIM ${sim.length ? pct(sim, 0.99).toFixed(2) : '-'}MS P99`,
    ];
  }
}

const KEY_DIRS: Record<string, [number, number]> = {
  KeyA: [-1, 0],
  KeyD: [1, 0],
  KeyW: [0, -1],
  KeyS: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * Fraction of a world-space box (centre x,y, half-size r) covered by effect pixels in the rendered layers: screen-space
 * layers above the titans (z ≥ 10: front particles, flashes, plumes, near debris) and additive world-space glow sprites.
 */
export function coverage(
  layers: readonly RenderLayer[],
  view: ViewRect,
  x: number,
  y: number,
  r: number,
): number {
  const sx0 = Math.round(x - r - view.x0);
  const sy0 = Math.round(y - r - view.y0);
  const n = 2 * r;
  let hit = 0;
  let total = 0;
  for (let j = 0; j < n; j++) {
    const sy = sy0 + j;
    for (let i = 0; i < n; i++) {
      const sx = sx0 + i;
      total++;
      const wx = sx + view.x0;
      const wy = sy + view.y0;
      for (let k = 0; k < layers.length; k++) {
        const L = layers[k]!;
        if (!L.visible || L.alpha <= 0) continue;
        let px = 0;
        if (L.space === 'screen') {
          if (L.z < 10 || L.z >= 100 || L.id.startsWith('debug')) continue;
          if (sx < 0 || sy < 0 || sx >= L.w || sy >= L.h) continue;
          px = L.pixels[sy * L.w + sx]!;
        } else {
          if (L.blend !== 'add') continue;
          const lx = Math.round(L.facing === 1 ? wx - L.x + L.anchorX : L.x - wx + L.anchorX);
          const ly = Math.round(wy - L.y + L.anchorY);
          if (lx < 0 || ly < 0 || lx >= L.w || ly >= L.h) continue;
          px = L.pixels[ly * L.w + lx]!;
        }
        if (px >>> 24 > 24) {
          hit++;
          break;
        }
      }
    }
  }
  return total ? hit / total : 0;
}
