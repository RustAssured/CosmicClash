import { createRenderer } from '@/render';
import { loadUriAsset } from '@/titans/uri/asset';
import uriBinUrl from '@/titans/uri/uri_rig.bin?url';
import './actors/all';
import { Director } from './director';
import { checkTimeline, durationOf, frameCount, type Timeline } from './timeline';

/**
 * Cinema mode entry (`?cinema=<timeline>`; `trailer` = src/cinema/timeline.json, anything else = src/cinema/gates/<name>.json).
 * It boots the real renderer alone (no menus, no input, no audio) and exposes `window.__CINEMA__` for the offline renderer
 * (tools/cinema/render.ts with `render=1`): frame n → the native scene, the overlay and the camera zoom, read back exactly.
 * Without `render=1` it plays the timeline in the page (native frames, no zoom or overlay) as a quick look.
 */
export interface CinemaApi {
  ready: boolean;
  name: string;
  frames: number;
  duration: number;
  /** Render frame n (in order for speed); returns the native buffers base64-encoded (packed RGBA) and the camera. */
  frame(n: number): Promise<{
    shot: string;
    scene: string;
    overlay: string;
    zoom: number;
    focus: [number, number];
    matter: boolean;
    dutch: number;
  }>;
}

declare global {
  interface Window {
    __CINEMA__?: CinemaApi;
  }
}

const TIMELINES = import.meta.glob<{ default: unknown }>(['./timeline.json', './gates/*.json'], {
  eager: true,
});

function loadTimeline(name: string): Timeline {
  const key = name === 'trailer' ? './timeline.json' : `./gates/${name}.json`;
  const mod = TIMELINES[key];
  if (!mod) throw new Error(`no cinema timeline "${name}" (${Object.keys(TIMELINES).join(', ')})`);
  return checkTimeline(mod.default);
}

function b64(u: Uint32Array): string {
  const b = new Uint8Array(u.buffer, u.byteOffset, u.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function startCinema(canvas: HTMLCanvasElement, name: string, render: boolean): Promise<void> {
  const tl = loadTimeline(name);
  await loadUriAsset(uriBinUrl);
  const renderer = createRenderer();
  await renderer.init(canvas, { quality: 2, preserveDrawingBuffer: true });
  renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  const director = new Director(tl, renderer);
  const api: CinemaApi = {
    ready: false,
    name,
    frames: frameCount(tl),
    duration: durationOf(tl),
    async frame(n) {
      const f = await director.frame(n);
      return {
        shot: f.shot,
        scene: b64(f.scene),
        overlay: b64(f.overlay),
        zoom: f.zoom,
        focus: f.focus,
        matter: f.matter,
        dutch: f.dutch,
      };
    },
  };
  window.__CINEMA__ = api;
  await renderer.prepareStage(tl.shots[0]!.stage);
  api.ready = true;
  if (render) return;
  // quick look: play the timeline in real time, one timeline frame per display frame
  let n = 0;
  const tick = async (): Promise<void> => {
    await director.frame(n);
    n = (n + 1) % api.frames;
    requestAnimationFrame(() => void tick());
  };
  void tick();
}
