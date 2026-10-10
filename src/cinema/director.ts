import {
  LOGICAL_H,
  LOGICAL_W,
  Rng,
  makeLayer,
  type CameraState,
  type RenderFrame,
  type RenderLayer,
  type Renderer,
  type ViewRect,
  DamageFlag,
  type SimEvent,
} from '@/contracts';
import { FxState } from '@/app/fx';
import { cameraTargetOf, createCamera } from '@/engine';
import type { Match } from '@/sim';
import { PixelCanvas } from '@/ui/pixel/canvas';
import { actorFactory } from './actors';
import { sampleCamera } from './camera';
import { buildShotMatch } from './match';
import { drawOverlay } from './overlay';
import { worldLayers } from './world';
import { applyGrade } from './grade';
import { setArenaSource } from './actors/edgepull';
import { witnessLayers } from './witness';
import { keyValue, sceneTime, shotAt, type Shot, type ShotMatch, type Timeline } from './timeline';
import {
  CINEMA_FPS,
  NATIVE_H,
  NATIVE_W,
  nativeBuffer,
  type Actor,
  type CineCameraState,
  type CineContext,
  type NativeBuffer,
} from './types';

/**
 * The Director (TRAILER_V3 §2.1): turns timeline frame n into pixels, deterministically. Simulation steps at a fixed 1/60 s;
 * a shot's time remap (slow motion, freezes, ramps) decides how many sim ticks a frame covers, and the fraction left over
 * is drawn by the renderer's own interpolation (render alpha), so slow motion never holds frames. Random numbers are seeded
 * per shot. Frames must be asked for in order; asking for an earlier frame rebuilds its shot from the start.
 */
export interface DirectorFrame {
  frame: number;
  shot: string;
  /** The renderer's final native frame (640×360 packed RGBA, top row first). */
  scene: Uint32Array;
  /** Letterbox and cards, native, transparent elsewhere. */
  overlay: Uint32Array;
  /** CineCamera zoom and the native point it closes in on (applied at output scale, camera.ts composeFrame). */
  zoom: number;
  focus: [number, number];
  /** MATTER CAM on (lit cells when zoomed). */
  matter: boolean;
  /** Dutch angle, quarter turns. */
  dutch: number;
}

interface ShotState {
  shot: Shot;
  match: Match | null;
  fx: FxState;
  cam: ReturnType<typeof createCamera>;
  /** Scene ticks stepped since the shot's scene time 0. */
  ticks: number;
  lastFrame: number;
  actors: { actor: Actor; buf: NativeBuffer; layer: RenderLayer; params: Record<string, unknown> }[];
  rng: Rng;
  /** World position the camera is locked on (camera key `lock`), taken at the shot's first frame. */
  lockAt?: [number, number];
}

const TICK_HZ = 60;

/**
 * One sim tick of a shot's fight, with the shot's injected blows (`match.blows`: cinema-only strikes from things that are not
 * in the game yet, e.g. the Mouth's bite on World B). A blow is a real damage event on the slot's matter (it breaks, sheds
 * debris and wounds exactly as a game blow does) plus the presentation a blow of that weight sends: a shockwave, a flash, a
 * camera shake (which the letterbox bars follow) and hit-stop.
 */
function tickMatch(
  m: Match,
  fx: FxState,
  cam: ReturnType<typeof createCamera>,
  sm: ShotMatch,
  absTick: number,
): void {
  m.step();
  let ev: readonly SimEvent[] = m.events;
  const blows = (sm.blows ?? []).filter((b) => b.tick === absTick);
  if (blows.length) {
    const extra: SimEvent[] = [];
    for (const b of blows) {
      const f = m.fighters[b.slot];
      const v = f.view;
      const x = v.x + b.dx;
      const y = v.y + b.dy;
      const len = Math.hypot(b.dirX, b.dirY) || 1;
      m.world.applyDamage(f.body.id, {
        type: b.type ?? 'CRUSH',
        shape: { kind: 'point', x, y, r: b.r },
        energy: b.energy,
        dirX: b.dirX / len,
        dirY: b.dirY / len,
        duration: 1,
        sourceMass: 12,
        sourceBodyId: -1,
        originX: x,
        originY: y,
        flags: DamageFlag.PIERCE,
        params: { penetration: 999, shock: b.shock ?? 260 },
        weight: 'catastrophic',
      });
      extra.push(
        { t: 'shockwave', x, y, strength: 1, radius: b.r * 3, hue: -1 },
        { t: 'flash', amount: 0.9, x, y },
        { t: 'shake', dirX: b.dirX / len, dirY: b.dirY / len, amp: b.shake ?? 14 },
        { t: 'hitstop', ticks: 6 },
      );
    }
    ev = [...ev, ...extra];
  }
  fx.tick(ev, m);
  cam.tick(
    { a: cameraTargetOf(m.fighters[0].view), b: cameraTargetOf(m.fighters[1].view), arena: m.arena },
    ev,
  );
}

export class Director {
  private cur: ShotState | null = null;
  private readonly overlayCv = new PixelCanvas(NATIVE_W, NATIVE_H);
  private readonly layers: RenderLayer[] = [];
  private arenaBuf: { w: number; h: number; pixels: Uint32Array } | null = null;
  private readonly cineCam: CineCameraState = { x: 0, y: 0, zoom: 1, dutch: 0, shakeX: 0, shakeY: 0 };
  private readonly fixedCam: CameraState = {
    x: 0,
    y: 0,
    zoom: 1,
    roll: 0,
    shakeX: 0,
    shakeY: 0,
    dolly: 0,
    kickX: 0,
    kickY: 0,
  };
  private readonly fixedView: ViewRect = { x0: 0, y0: 0, w: LOGICAL_W, h: LOGICAL_H };

  constructor(
    readonly timeline: Timeline,
    private readonly renderer: Renderer & {
      restartStage(id: Shot['stage']): Promise<void>;
      setScenery(on: boolean): void;
    },
    /** Debug: drop layers whose id matches (`?hide=<regex>`), to find which layer draws what. */
    private readonly hide: RegExp | null = null,
  ) {}

  /** The ids of the layers drawn in the last frame (debug). */
  layerIds(): string[] {
    return this.layers.map((l) => `${l.id}:${l.blend}:${l.z}`);
  }

  /** Render timeline frame `n`. */
  async frame(n: number): Promise<DirectorFrame> {
    const t = n / CINEMA_FPS;
    const shot = shotAt(this.timeline, t);
    if (!this.cur || this.cur.shot !== shot || n <= this.cur.lastFrame) await this.enter(shot);
    const st = this.cur!;
    st.lastFrame = n;
    const shotT = t - shot.start;
    const sceneT = sceneTime(shot, shotT);
    // step the fight to the scene time; the fraction left is the render alpha
    const target = sceneT * TICK_HZ;
    while (st.ticks + 1 <= target + 1e-9) this.step(st);
    const alpha = Math.min(1, Math.max(0, target - st.ticks));

    // camera: the game camera framing the fight, or the shot's fixed / scripted camera
    const cs = sampleCamera(shot.camera, shotT);
    // `lock`: a fixed camera on where a fighter stood when the shot began (+ the key's x/y as an offset)
    const lock = shot.camera?.[0]?.lock;
    if (lock !== undefined && st.match) {
      if (!st.lockAt) {
        const v = st.match.fighters[lock].view;
        st.lockAt = [v.x, v.y];
      }
      cs.x = st.lockAt[0] + (cs.x ?? 0);
      cs.y = st.lockAt[1] + (cs.y ?? 0);
    }
    let camera: CameraState;
    let view: ViewRect;
    const game = st.cam.sample(alpha);
    if (cs.x === null || cs.y === null) {
      camera = game.state;
      view = game.view;
      if (cs.shake === false) {
        camera = { ...camera, shakeX: 0, shakeY: 0 };
        view = {
          ...view,
          x0: Math.round(camera.x - LOGICAL_W / 2),
          y0: Math.round(camera.y - LOGICAL_H / 2),
        };
      }
    } else {
      const shake = cs.shake === true;
      Object.assign(this.fixedCam, {
        x: cs.x,
        y: cs.y,
        zoom: 1,
        roll: 0,
        shakeX: shake ? game.state.shakeX : 0,
        shakeY: shake ? game.state.shakeY : 0,
        dolly: 0,
        kickX: 0,
        kickY: 0,
      });
      camera = this.fixedCam;
      this.fixedView.x0 = Math.round(cs.x + camera.shakeX - LOGICAL_W / 2);
      this.fixedView.y0 = Math.round(cs.y + camera.shakeY - LOGICAL_H / 2);
      view = this.fixedView;
    }
    Object.assign(this.cineCam, {
      x: camera.x,
      y: camera.y,
      zoom: cs.zoom,
      dutch: 0,
      shakeX: Math.round(camera.shakeX),
      shakeY: Math.round(camera.shakeY),
    });

    // layers: the real fight, then the cinema actors (each its own native buffer, at its depth)
    this.layers.length = 0;
    if (st.match) {
      st.match.fighters.forEach((f, slot) => {
        const pal = shot.match?.worlds?.[slot === 0 ? '0' : '1'];
        const ls = f.renderLayers(view, alpha);
        const w = shot.match?.witness;
        if (pal) worldLayers(ls, pal, sceneT, this.layers, shot.match?.front === slot ? 2 : 0);
        else if (w && w.slot === slot)
          witnessLayers(
            ls,
            { pupil: keyValue(w.pupil, shotT, 1), rings: keyValue(w.rings, shotT, 1) },
            this.layers,
          );
        else for (const l of ls) this.layers.push(l);
      });
      for (const l of st.match.world.renderLayers(view, alpha)) this.layers.push(l);
    }
    // `arena`: the fight drawn alone first, handed to the edge pull as its shrinking arena (the real game frame inside the coils)
    if (shot.arena && st.match) {
      this.renderer.setScenery(true);
      this.renderer.draw({
        tick: n,
        timeSec: shot.start + sceneT,
        alpha,
        camera,
        view,
        stage: shot.stage,
        layers: this.layers,
        ui: null,
        fx: st.fx.sample(alpha),
      });
      const a = this.renderer.captureLogical();
      if (!this.arenaBuf) this.arenaBuf = { w: NATIVE_W, h: NATIVE_H, pixels: new Uint32Array(a.length) };
      this.arenaBuf.pixels.set(a);
      applyGrade(this.arenaBuf.pixels, shot.grade ?? 'none');
      const buf = this.arenaBuf;
      setArenaSource(() => buf);
    }
    const ctx: CineContext = {
      frame: n,
      t,
      shot: shot.id,
      shotT,
      sceneT,
      camera: this.cineCam,
      view,
      rng: () => st.rng.next(),
      params: {},
    };
    for (const a of st.actors) {
      a.buf.pixels.fill(0);
      a.buf.emissive.fill(0);
      a.actor.draw(a.buf, { ...ctx, params: a.params });
      a.layer.version++;
      this.layers.push(a.layer);
    }
    const frame: RenderFrame = {
      tick: n,
      timeSec: shot.start + sceneT,
      alpha,
      camera,
      view,
      stage: shot.stage,
      layers: this.layers,
      ui: null,
      fx: st.fx.sample(alpha),
    };
    const shotHide = shot.hide ? new RegExp(shot.hide) : null;
    if (this.hide || shotHide) {
      const keep = this.layers.filter(
        (l) =>
          !(this.hide && this.hide.test(l.id)) &&
          !(shotHide && !l.id.startsWith(shot.id + ':') && shotHide.test(l.id)),
      );
      this.layers.length = 0;
      this.layers.push(...keep);
    }
    this.renderer.setScenery(shot.scenery ?? !(shot.actors ?? []).some((a) => a.depth <= -90));
    this.renderer.draw(frame);
    const scene = this.renderer.captureLogical();
    applyGrade(scene, shot.grade ?? 'none');
    const overlay = drawOverlay(shot, shotT, this.cineCam.shakeY, this.overlayCv).pixels;
    // a tracked fighter: the zoom closes in on it (its root, interpolated like its layers) plus the key's focus as an offset
    let focus = cs.focus;
    if (cs.track !== null && st.match) {
      const v = st.match.fighters[cs.track].view;
      focus = [v.x - view.x0 + cs.focus[0], v.y - view.y0 + cs.focus[1]];
    }
    // `about`: zoom about the point (it keeps its place in the frame; at ×1 the frame is the whole picture, centred)
    if (shot.camera?.[0]?.about) {
      const k = 1 - 1 / Math.max(1, cs.zoom);
      focus = [NATIVE_W / 2 + (focus[0] - NATIVE_W / 2) * k, NATIVE_H / 2 + (focus[1] - NATIVE_H / 2) * k];
    }
    return {
      frame: n,
      shot: shot.id,
      scene,
      overlay,
      zoom: cs.zoom,
      focus,
      matter: cs.matter,
      dutch: cs.dutch,
    };
  }

  private step(st: ShotState): void {
    st.ticks++;
    const m = st.match;
    if (!m) return;
    tickMatch(m, st.fx, st.cam, st.shot.match!, st.shot.match!.startTick + st.ticks);
  }

  /** Set a shot up from its start: its stage, its fight fast-forwarded to `startTick`, its actors. */
  private async enter(shot: Shot): Promise<void> {
    for (const a of this.cur?.actors ?? []) a.actor.dispose?.();
    await this.renderer.restartStage(shot.stage);
    const fx = new FxState();
    const cam = createCamera();
    let match: Match | null = null;
    if (shot.match) {
      match = buildShotMatch(shot.match, shot.stage);
      const v0 = match.fighters[0].view;
      const v1 = match.fighters[1].view;
      cam.reset((v0.x + v1.x) / 2, (v0.y + v1.y) / 2);
      for (let i = 0; i < shot.match.startTick && match.phase !== 'matchend'; i++)
        tickMatch(match, fx, cam, shot.match, i + 1);
    }
    const rng = new Rng(shot.seed ?? 1);
    const actors = (shot.actors ?? []).map((e, i) => {
      const id = e.id ?? `${shot.id}:${e.type}:${i}`;
      const params = e.params ?? {};
      const actor = actorFactory(e.type)(id, e.depth, params);
      const buf = nativeBuffer();
      const layer = makeLayer(id, 'screen', e.depth, NATIVE_W, NATIVE_H);
      layer.pixels = buf.pixels;
      layer.emissive = buf.emissive;
      return { actor, buf, layer, params };
    });
    this.cur = { shot, match, fx, cam, ticks: 0, lastFrame: -1, actors, rng };
    const ctx0: CineContext = {
      frame: Math.round(shot.start * CINEMA_FPS),
      t: shot.start,
      shot: shot.id,
      shotT: 0,
      sceneT: 0,
      camera: this.cineCam,
      view: this.fixedView,
      rng: () => rng.next(),
      params: {},
    };
    for (const a of actors) await a.actor.init?.({ ...ctx0, params: a.params });
  }
}
