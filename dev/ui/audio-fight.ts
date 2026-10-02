import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type AudioScene,
  type MatchApi,
  type MatchConfig,
  type SimEvent,
} from '@/contracts';
import { createAI } from '@/ai';
import { createAudioEngine } from '@/audio/engine';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';
import { FxState, buildAudioScene } from '@/app/fx';
import { measureRender, type RoundReport } from './audio-round';

/**
 * D6 calibration against REAL fight density: a real Match (AI vs AI, the Witness vs the Planet, real fighters, real matter
 * world) is stepped inside an OfflineAudioContext render, and its SimEvent stream drives the real engine exactly the way the
 * app does — `handleAt` with every tick's events at that tick's time, `updateAt` with `buildAudioScene` and FxState's intensity.
 * KO slow motion stretches the ticks in audio time, as in play. When a match ends inside the window, the next one starts
 * (seed + 1). Measured with telemetry's definitions (`measureRender`); a heavy blow = a hit with energy ≥ 400, as telemetry.
 */
export interface FightReport extends RoundReport {
  seed: number;
  level: number;
  footwork: 'classic' | 'orbit';
  matches: number;
  hits: number;
  heavyHits: number;
}

const SR = 48000;
const TICK = 1 / 60;
const HEAVY_ENERGY = 400;

function newMatch(seed: number, level: number, footwork: 'classic' | 'orbit'): MatchApi {
  const cfg: MatchConfig = {
    seed,
    stage: 'nursery',
    mode: 'aivai',
    footwork,
    slots: [
      { titan: 'lastone', controller: 'ai', aiLevel: level as 4 },
      { titan: 'planet', controller: 'ai', aiLevel: level as 4 },
    ],
  };
  const m = createMatch(cfg, {
    createWorld: createMatterWorld,
    createFighter,
    getTitanDef,
    arena: DEFAULT_ARENA,
    lighting: DEFAULT_LIGHTING,
  });
  m.setSources(
    createAiSource(m, 0, createAI(cfg.slots[0].aiLevel!, getTitanDef('lastone'), seed * 7 + 1, { footwork })),
    createAiSource(m, 1, createAI(cfg.slots[1].aiLevel!, getTitanDef('planet'), seed * 7 + 2, { footwork })),
  );
  return m;
}

export async function runFightVerification(
  seconds = 60,
  seed = 21,
  level = 4,
  footwork: 'classic' | 'orbit' = 'orbit',
): Promise<FightReport> {
  const ctx = new OfflineAudioContext(4, Math.ceil(SR * seconds), SR);
  ctx.destination.channelCountMode = 'explicit';
  ctx.destination.channelInterpretation = 'discrete';
  const eng = createAudioEngine({ context: ctx, seed });
  await eng.unlock();
  const taps = eng.taps()!;
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(4);
  taps.music.connect(split);
  split.connect(merge, 0, 2);
  split.connect(merge, 1, 3);
  merge.connect(ctx.destination);

  let m = newMatch(seed, level, footwork);
  let matches = 1;
  const fx = new FxState();
  let tickAt = 0; // audio time of the next tick
  let hits = 0;
  const heavy: number[] = [];
  const gr: { t: number; db: number }[] = [];
  const step = (now: number): void => {
    gr.push({ t: now, db: eng.limiterReductionDb() });
    // run every tick due before the next step, each at its own audio time
    while (tickAt <= now + TICK) {
      if (m.phase === 'matchend') {
        m = newMatch(seed + matches, level, footwork);
        matches++;
        fx.reset();
      }
      m.step();
      const ev: readonly SimEvent[] = m.events;
      fx.tick(ev, m);
      for (const e of ev)
        if (e.t === 'hit') {
          hits++;
          if (e.energy >= HEAVY_ENERGY) heavy.push(tickAt);
        }
      if (ev.length) eng.handleAt(ev, tickAt + 0.006);
      tickAt += TICK / Math.max(0.05, m.timeScale || 1);
    }
    const phase: AudioScene['phase'] = m.phase === 'matchend' ? 'results' : 'fight';
    const mid = (m.fighters[0].view.x + m.fighters[1].view.x) / 2;
    eng.updateAt(buildAudioScene(m, phase, fx.intensity(), mid), TICK, now + 0.15);
  };
  step(0);
  for (let t = TICK; t < seconds - TICK; t += TICK) {
    const at = t;
    void ctx.suspend(at).then(() => {
      step(at);
      void ctx.resume();
    });
  }
  const buf = await ctx.startRendering();
  await new Promise((res) => setTimeout(res, 50));
  const r = measureRender(buf, seconds, heavy, gr, eng.limiterReductionDb());
  return { ...r, seed, level, footwork, matches, hits, heavyHits: heavy.length };
}
