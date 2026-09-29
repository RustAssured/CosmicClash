import {
  ROUND_INTRO_TICKS,
  parseScript,
  type AdeukHarnessApi,
  type HarnessParams,
  type HarnessPerf,
  type HarnessSummary,
  type MatchConfig,
  type SlotConfig,
} from '@/contracts';
import { createScriptSource } from '@/sim';
import { showScreen } from '@/ui';
import type { App } from './app';

const pct = (a: number[], p: number): number => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

export function harnessMatchConfig(p: HarnessParams): MatchConfig {
  const slot = (titan: SlotConfig['titan'], c: 'human' | 'ai' | 'dummy'): SlotConfig => ({
    titan,
    controller: c,
    aiLevel: p.ai,
  });
  const aivai = p.mode === 'aivai';
  return {
    seed: p.seed,
    stage: p.stage,
    mode: aivai ? 'aivai' : p.mode === 'training' ? 'training' : p.p2 === 'ai' ? 'vsai' : 'versus',
    slots: [slot(p.a, aivai ? 'ai' : p.p1), slot(p.b, aivai ? 'ai' : p.p2)],
    startState: p.state,
    infinite: p.mode === 'training',
    startGap: p.gap,
  };
}

/** Boot into the harness scenario (if URL params ask for one) and expose `window.__ADEUK__`. */
export async function installHarness(app: App, params: HarnessParams): Promise<void> {
  const api: AdeukHarnessApi = {
    get ready() {
      return ready;
    },
    params,
    step(n: number): void {
      app.loop.stepTicks(n, true);
    },
    renderNow(): void {
      app.render(0, 1 / 60);
    },
    summary(): HarnessSummary {
      const m = app.session?.match;
      if (!m)
        return { tick: 0, phase: 'none', round: 0, wins: [0, 0], fighters: [blank(), blank()], hash: 0 };
      const f = (i: 0 | 1): HarnessSummary['fighters'][0] => {
        const v = m.fighters[i].view;
        return {
          titan: v.titan,
          state: v.state,
          moveId: v.moveId,
          x: v.x,
          y: v.y,
          integrityPct: v.integrityPct,
          massFrac: v.bodyStats.massFrac,
          resource: v.resource,
          meter: v.meter,
          ko: v.ko,
          cells: v.bodyStats.cells,
        };
      };
      return {
        tick: m.tick,
        phase: m.phase,
        round: m.round,
        wins: [m.wins[0], m.wins[1]],
        fighters: [f(0), f(1)],
        hash: m.hash(),
      };
    },
    hash(): number {
      return app.session?.match.hash() ?? 0;
    },
    setScript(slot, script): void {
      const m = app.session?.match;
      if (!m) return;
      app.replaceSource(slot, createScriptSource(parseScript(script), m.tick));
    },
    benchSim(ticks: number): HarnessPerf {
      const cfg = app.session?.config;
      app.simSamples = [];
      app.measureSim = true;
      const wasPaused = app.loop.paused;
      app.loop.pause();
      for (let i = 0; i < ticks; i++) {
        const s = app.session;
        if (!s) break;
        if (s.match.phase === 'matchend' && cfg)
          app.buildSession({ ...cfg, seed: cfg.seed + i + 1 }, { skipIntro: true });
        app.tick();
      }
      app.measureSim = false;
      if (!wasPaused) app.loop.resume();
      const a = app.simSamples;
      return {
        simMsMean: mean(a),
        simMsP95: pct(a, 0.95),
        simMsMax: Math.max(0, ...a),
        frameMsMean: 0,
        drawMsMean: 0,
        fps: 0,
        ticks: a.length,
        frames: 0,
      };
    },
    benchFrames(frames: number): HarnessPerf {
      const cfg = app.session?.config;
      const wasPaused = app.loop.paused;
      app.loop.pause();
      const ft: number[] = [];
      const dt: number[] = [];
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        const s = app.session;
        if (s && s.match.phase === 'matchend' && cfg)
          app.buildSession({ ...cfg, seed: cfg.seed + i + 1 }, { skipIntro: true });
        app.tick();
        const a = performance.now();
        app.render(0.5, 1 / 60);
        ft.push(performance.now() - a);
        dt.push(app.renderer.stats.frameMs);
      }
      const wall = performance.now() - t0;
      if (!wasPaused) app.loop.resume();
      return {
        simMsMean: 0,
        simMsP95: 0,
        simMsMax: 0,
        frameMsMean: mean(ft),
        drawMsMean: mean(dt),
        fps: (frames / wall) * 1000,
        ticks: frames,
        frames,
      };
    },
    captureLogical(): Uint32Array {
      return app.renderer.captureLogical();
    },
    drainEventLog(): unknown[] {
      return app.drainEventLog();
    },
    uiScreen(): string {
      return app.ui.screen;
    },
    matchPhase(): string {
      return app.session ? app.session.match.phase : 'none';
    },
  };
  let ready = false;
  window.__ADEUK__ = api;

  if (params.active) {
    if (params.mode === 'fight' || params.mode === 'aivai' || params.mode === 'training') {
      await app.startMatch(harnessMatchConfig(params), {
        skipIntro: true,
        scripts: [params.script0, params.script1],
      });
      if (params.meter >= 0) for (const f of app.session!.match.fighters) f.debugSetMeter?.(params.meter);
      if (params.t > 0) app.loop.stepTicks(params.t, false);
      if (params.freeze) app.loop.pause();
      app.hideUi = !params.hud;
    } else {
      const screen =
        { title: 'title', menu: 'mode', select: 'select', controller: 'controller' }[params.mode as string] ??
        'title';
      showScreen(app.ui, screen as Parameters<typeof showScreen>[1]);
    }
  }
  // let the scenery finish preparing and draw at least once before declaring ready
  await app.renderer.prepareStage(app.session?.config.stage ?? 'nursery');
  await nextFrame();
  await nextFrame();
  ready = true;
  void ROUND_INTRO_TICKS;
}

function blank(): HarnessSummary['fighters'][0] {
  return {
    titan: 'lastone',
    state: '',
    moveId: null,
    x: 0,
    y: 0,
    integrityPct: 0,
    massFrac: 0,
    resource: 0,
    meter: 0,
    ko: false,
    cells: 0,
  };
}
