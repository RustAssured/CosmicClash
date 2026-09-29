import {
  STAGE_IDS,
  TITAN_IDS,
  type AudioEvent,
  type AudioScene,
  type DamageType,
  type StageId,
  type TitanId,
  type UiSoundId,
} from '@/contracts';
import { createAudioEngine } from '@/audio/engine';
import { runVerification, type VerifyReport } from './audio-verify';
import { runStageVerification, type StageReport } from './audio-stages';
import { runBodyCharacter, runTitanVerification, type TitanReport } from './audio-titans';

/**
 * Audition page for the procedural audio engine: every sound the game can make, on a button, with the score's controls and
 * a live level meter. `?verify=1` runs the OfflineAudioContext verification straight away and publishes the numbers on
 * `window.__report` (Playwright reads that; see e2e/ui-audio.spec.ts).
 */
declare global {
  interface Window {
    __verify?: (opts?: { quick?: boolean }) => Promise<VerifyReport>;
    __report?: VerifyReport;
    __titans?: TitanReport;
    __stages?: StageReport;
    __body?: Awaited<ReturnType<typeof runBodyCharacter>>;
    __audio?: ReturnType<typeof createAudioEngine>;
    /** Largest level seen by the meter since the page loaded, before and after the limiter. */
    __meter?: { maxPre: number; maxPost: number };
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const engine = createAudioEngine({ seed: (Math.random() * 1e9) | 0 });
window.__audio = engine;
window.__verify = runVerification;
engine.autoUnlock(document);

const titanA = $<HTMLSelectElement>('titanA');
const titanB = $<HTMLSelectElement>('titanB');
const stageSel = $<HTMLSelectElement>('stage');
const phaseSel = $<HTMLSelectElement>('phase');
for (const id of TITAN_IDS) {
  titanA.add(new Option(id, id));
  titanB.add(new Option(id, id));
}
titanA.value = 'lastone';
titanB.value = 'asteroid';
for (const id of STAGE_IDS) stageSel.add(new Option(id, id));
for (const p of ['menu', 'fight', 'pause', 'results', 'attract']) phaseSel.add(new Option(p, p));
phaseSel.value = 'fight';

const intensity = $<HTMLInputElement>('intensity');
const integrity = $<HTMLInputElement>('integrity');
const massA = $<HTMLInputElement>('massA');
const resourceA = $<HTMLInputElement>('resourceA');
const speedA = $<HTMLInputElement>('speedA');
const state = { scoreOn: false };

const scene = (): AudioScene => {
  const a = titanA.value as TitanId;
  const b = titanB.value as TitanId;
  const phase = phaseSel.value as AudioScene['phase'];
  const fight = phase === 'fight' || phase === 'pause' || phase === 'attract';
  return {
    phase,
    stage: stageSel.value as StageId,
    intensity: Number(intensity.value),
    listenerX: 800,
    lowestIntegrity: Number(integrity.value),
    timeScale: 1,
    fighters: fight
      ? [
          {
            titan: a,
            x: 700,
            speed: Number(speedA.value),
            massFrac: Number(massA.value), // may exceed 1 for the accreting titans
            charge: 0,
            resource: Number(resourceA.value), // 0..1 in the contract
            meter: 0.3,
            state: 'idle',
          },
          { titan: b, x: 900, speed: 40, massFrac: 1, charge: 0, resource: 0.6, meter: 0.3, state: 'idle' },
        ]
      : null,
  };
};

const hit = (
  a: TitanId,
  type: DamageType,
  over: Partial<Extract<AudioEvent, { t: 'hit' }>> = {},
): AudioEvent => ({
  t: 'hit',
  attacker: 0,
  target: 1,
  titan: a,
  x: 800,
  y: 300,
  dirX: 1,
  dirY: 0,
  type,
  energy: 1400,
  cellsRemoved: 40,
  massRemoved: 12,
  blocked: 0,
  heavy: false,
  onDamaged: 0,
  ...over,
});

interface Entry {
  label: string;
  events: (a: TitanId, b: TitanId) => AudioEvent[];
}
/** Every keyword the engine understands in a `cue` id (a titan's own ids are matched on these; anything else is a generic blip). */
const CUE_WORDS = [
  'sever',
  'dark',
  'lost',
  'shed',
  'break',
  'boil',
  'strip',
  'collapse',
  'harvest',
  'swarm',
  'merge',
  'blow',
  'crack',
  'burn',
  'latch',
  'consume',
  'hawking',
] as const;
/** The exact ids the four newer titans emit, on their own buttons. */
const EMITTED_CUES: Partial<Record<TitanId, string[]>> = {
  nexus: ['node-dark', 'harvest', 'chain-latch'],
  blackhole: ['disk-shed', 'consume', 'hawking'],
  supernova: ['layer-blow', 'fuel-burn', 'collapse'],
  planet: ['crust-crack', 'moon-lost', 'atmo-strip', 'ocean-boil'],
};
const TYPES: DamageType[] = ['FRACTURE', 'ASSIMILATION', 'TIDAL', 'THERMAL', 'CRUSH', 'KINETIC'];
const MOVES: Record<string, string[]> = {
  lastone: ['lastone.lash', 'lastone.lunge', 'lastone.shatter', 'lastone.gaze'],
  asteroid: ['asteroid.shoulder', 'asteroid.meteor', 'asteroid.swarm'],
};
const moveIds = (t: TitanId): string[] => MOVES[t] ?? [`${t}.strike`, `${t}.crush`];

const gaze = (phase: 'start' | 'hold' | 'release', frac: number): AudioEvent[] => [
  { t: 'charge', slot: 0, titan: 'lastone', moveId: 'lastone.gaze', frac, phase },
];

const groups: { name: string; entries: (a: TitanId, b: TitanId) => Entry[] }[] = [
  {
    name: 'Hits by damage type (A hits B)',
    entries: (a) => [
      ...TYPES.map((t) => ({ label: t.toLowerCase(), events: () => [hit(a, t)] })),
      { label: 'heavy CRUSH', events: () => [hit(a, 'CRUSH', { energy: 9000, heavy: true, onDamaged: 1 })] },
      { label: 'blocked', events: () => [hit(a, 'KINETIC', { blocked: 0.9 })] },
      {
        label: 'tiny chip',
        events: () => [hit(a, 'FRACTURE', { energy: 90, cellsRemoved: 2, massRemoved: 0.4 })],
      },
    ],
  },
  {
    name: 'Moves (A): wind-up and release',
    entries: (a) => [
      ...moveIds(a).flatMap((id) => [
        ...(id.endsWith('gaze')
          ? [] // the Gaze's windup is the sustained charge voice, below
          : [
              {
                label: `${id.split('.')[1]} windup`,
                events: () => [
                  {
                    t: 'move',
                    slot: 0,
                    titan: a,
                    moveId: id,
                    moveSlot: 'strike',
                    aim: 'forward',
                    x: 700,
                    y: 300,
                  } as AudioEvent,
                ],
              },
            ]),
        {
          label: `${id.split('.')[1]} release`,
          events: () => [
            {
              t: 'release',
              slot: 0,
              titan: a,
              moveId: id,
              moveSlot: 'strike',
              x: 700,
              y: 300,
              power: 0.85,
            } as AudioEvent,
          ],
        },
      ]),
      ...(a === 'lastone'
        ? [
            { label: 'gaze charge (start, 60 %)', events: () => gaze('start', 0).concat(gaze('hold', 0.6)) },
            { label: 'gaze charge (hold 100 %)', events: () => gaze('hold', 1) },
            { label: 'gaze charge (release)', events: () => gaze('release', 1) },
          ]
        : []),
    ],
  },
  {
    name: 'Movement and defence',
    entries: (a, b) => [
      {
        label: 'surge A',
        events: () => [{ t: 'surge', slot: 0, titan: a, x: 700, y: 300, dirX: 1, dirY: 0 }],
      },
      {
        label: 'surge B',
        events: () => [{ t: 'surge', slot: 1, titan: b, x: 900, y: 300, dirX: -1, dirY: 0 }],
      },
      {
        label: 'guard holds',
        events: () => [{ t: 'guard', slot: 0, x: 700, y: 300, type: 'FRACTURE', broke: false }],
      },
      {
        label: 'guard breaks',
        events: () => [{ t: 'guard', slot: 1, x: 900, y: 300, type: 'KINETIC', broke: true }],
      },
      {
        label: 'shockwave',
        events: () => [{ t: 'shockwave', x: 800, y: 300, strength: 0.9, radius: 240, hue: 0.1 }],
      },
    ],
  },
  {
    name: 'Matter',
    entries: () =>
      (['detach', 'ignite', 'crack', 'consume', 'impact'] as const).map((kind) => ({
        label: kind,
        events: () => [{ t: 'matter', kind, x: 800, y: 300, mass: 400, slot: 1 } as AudioEvent],
      })),
  },
  {
    name: 'Big moments',
    entries: (a, b) => [
      {
        label: 'ultimate A',
        events: () => [{ t: 'ultimate', slot: 0, titan: a, phase: 'start', x: 700, y: 300 }],
      },
      {
        label: 'ultimate B',
        events: () => [{ t: 'ultimate', slot: 1, titan: b, phase: 'start', x: 900, y: 300 }],
      },
      { label: 'KO A', events: () => [{ t: 'ko', slot: 0, x: 700, y: 300 }] },
      { label: 'KO B', events: () => [{ t: 'ko', slot: 1, x: 900, y: 300 }] },
      { label: 'round intro', events: () => [{ t: 'round', phase: 'intro', round: 1, winner: -1 }] },
      { label: 'round FIGHT', events: () => [{ t: 'round', phase: 'fight', round: 1, winner: -1 }] },
      { label: 'time over', events: () => [{ t: 'round', phase: 'timeover', round: 1, winner: -1 }] },
      { label: 'round end', events: () => [{ t: 'round', phase: 'end', round: 1, winner: 0 }] },
      { label: 'match end', events: () => [{ t: 'round', phase: 'match', round: 3, winner: 0 }] },
    ],
  },
  {
    name: 'Titan cues (A, then B: every keyword the voices know)',
    entries: (a, b) => [
      ...CUE_WORDS.map((w) => ({
        label: `A ${a}-${w}`,
        events: () => [
          { t: 'cue', slot: 0, titan: a, id: `${a}-${w}`, x: 700, y: 300, amount: 1 } as AudioEvent,
        ],
      })),
      ...CUE_WORDS.map((w) => ({
        label: `B ${b}-${w}`,
        events: () => [
          { t: 'cue', slot: 1, titan: b, id: `${b}-${w}`, x: 900, y: 300, amount: 1 } as AudioEvent,
        ],
      })),
      ...(EMITTED_CUES[a] ?? []).map((id) => ({
        label: `A emits ${id}`,
        events: () => [{ t: 'cue', slot: 0, titan: a, id, x: 700, y: 300, amount: 1 } as AudioEvent],
      })),
      ...(EMITTED_CUES[b] ?? []).map((id) => ({
        label: `B emits ${id}`,
        events: () => [{ t: 'cue', slot: 1, titan: b, id, x: 900, y: 300, amount: 1 } as AudioEvent],
      })),
      {
        label: 'unknown id (generic)',
        events: () => [{ t: 'cue', slot: 0, titan: a, id: 'zzz', x: 700, y: 300, amount: 0.5 } as AudioEvent],
      },
    ],
  },
  {
    name: 'Menu',
    entries: () =>
      (
        [
          'move',
          'confirm',
          'back',
          'select',
          'error',
          'start',
          'pause',
          'unpause',
          'roundwin',
          'tick',
        ] as UiSoundId[]
      ).map((id) => ({
        label: id,
        events: () => [{ t: 'ui', id } as AudioEvent],
      })),
  },
  {
    name: 'Stress',
    entries: () => [
      {
        label: 'event storm (limiter test)',
        events: () => {
          const out: AudioEvent[] = [];
          for (let i = 0; i < 24; i++) {
            out.push(
              hit(TITAN_IDS[i % 6]!, TYPES[i % 6]!, {
                energy: 7000,
                heavy: i % 3 === 0,
                onDamaged: 0.8,
                x: 300 + i * 40,
              }),
              { t: 'shockwave', x: 800, y: 300, strength: 1, radius: 260, hue: 0.1 },
              { t: 'matter', kind: 'detach', x: 700, y: 300, mass: 900, slot: (i % 2) as 0 | 1 },
            );
          }
          return out;
        },
      },
    ],
  },
];

const host = $('groups');
const fire = (e: Entry): void => {
  void engine.unlock();
  engine.handle(e.events(titanA.value as TitanId, titanB.value as TitanId));
};
const render = (): void => {
  host.textContent = '';
  const a = titanA.value as TitanId;
  const b = titanB.value as TitanId;
  for (const g of groups) {
    const h = document.createElement('h2');
    h.textContent = g.name;
    const box = document.createElement('div');
    box.className = 'grid';
    for (const e of g.entries(a, b)) {
      const btn = document.createElement('button');
      btn.textContent = e.label;
      btn.addEventListener('click', () => fire(e));
      box.append(btn);
    }
    host.append(h, box);
  }
};
titanA.addEventListener('change', render);
titanB.addEventListener('change', render);
render();

const bind = (id: string, key: 'master' | 'music' | 'sfx'): void => {
  const el = $<HTMLInputElement>(id);
  const apply = (): void => engine.setVolumes({ [key]: Number(el.value) });
  el.addEventListener('input', apply);
  apply();
};
bind('vMaster', 'master');
bind('vMusic', 'music');
bind('vSfx', 'sfx');
for (const id of ['intensity', 'integrity', 'massA', 'resourceA', 'speedA']) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('input', () => ($(`${id}V`).textContent = Number(el.value).toFixed(2)));
}
const scoreBtn = $<HTMLButtonElement>('score');
scoreBtn.addEventListener('click', () => {
  void engine.unlock();
  state.scoreOn = !state.scoreOn;
  scoreBtn.textContent = state.scoreOn ? 'Score: on' : 'Score: off';
  scoreBtn.classList.toggle('on', state.scoreOn);
});

// live meter + score driver
const meter = $<HTMLCanvasElement>('meter');
const g = meter.getContext('2d')!;
let last = performance.now();
const hist: { pre: number; post: number }[] = [];
const seen = { maxPre: 0, maxPost: 0 };
window.__meter = seen;
const frame = (t: number): void => {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  if (state.scoreOn) engine.update(scene(), dt);
  const p = engine.readPeak();
  seen.maxPre = Math.max(seen.maxPre, p.pre);
  seen.maxPost = Math.max(seen.maxPost, p.post);
  hist.push(p);
  if (hist.length > meter.width) hist.shift();
  g.clearRect(0, 0, meter.width, meter.height);
  const H = meter.height;
  g.fillStyle = '#232838';
  g.fillRect(0, H * (1 - 1 / 1.25), meter.width, 1); // full scale line
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i]!;
    g.fillStyle = '#ff5d5d';
    g.fillRect(i, H - Math.min(1.25, h.pre) * (H / 1.25), 1, 2);
    g.fillStyle = '#6fd3ff';
    g.fillRect(i, H - Math.min(1.25, h.post) * (H / 1.25), 1, Math.min(1.25, h.post) * (H / 1.25));
  }
  $('status').textContent = engine.ready
    ? `running · ${engine.latencyMs().toFixed(0)} ms output latency`
    : 'suspended (click to start)';
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

// numeric verification
const runBtn = $<HTMLButtonElement>('verify');
const reportEl = $<HTMLPreElement>('report');
const stateEl = $('verifyState');
async function verify(mode: 'full' | 'quick' | 'titans' | 'stages' | 'body' = 'full'): Promise<void> {
  stateEl.textContent = 'rendering…';
  runBtn.disabled = true;
  try {
    let out: unknown;
    if (mode === 'body') out = window.__body = await runBodyCharacter();
    else if (mode === 'titans') out = window.__titans = await runTitanVerification();
    else if (mode === 'stages') out = window.__stages = await runStageVerification();
    else {
      const r = await runVerification({ quick: mode === 'quick' });
      window.__report = r;
      out = r;
    }
    reportEl.hidden = false;
    reportEl.textContent = JSON.stringify(out, null, 2);
    stateEl.textContent = 'done';
  } catch (e) {
    stateEl.textContent = `failed: ${(e as Error).message}`;
  } finally {
    runBtn.disabled = false;
  }
}
runBtn.addEventListener('click', () => void verify());
const q = new URLSearchParams(location.search);
const mode = q.get('verify');
if (q.has('verify'))
  void verify(mode === 'quick' || mode === 'titans' || mode === 'stages' || mode === 'body' ? mode : 'full');
