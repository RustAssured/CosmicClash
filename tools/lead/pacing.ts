/**
 * Headless pacing + wound-separation evidence (deterministic, Node, real Match / Fighters / matter world).
 *   npx tsx tools/lead/pacing.ts [--a=lastone] [--b=planet] [--n=20] [--seed=1] [--la=3] [--lb=3] [--out=file.json]
 *
 * Per round: live seconds, hits (every landed `hit` event), contacts (distinct attacker move instances that landed),
 * heavy hits (energy ≥ 400 or flagged heavy), how it ended.
 * Per heavy hit (D1 evidence), over the 1.5 s after the blow (hit-stop included; the world is frozen during it):
 *   loss = body mass the TARGET lost; toParticles / toChunks = how the world routed removed matter (ledger deltas);
 *   maxTick = the largest loss in ONE tick ("vanished between two frames"), maxTickAt its offset in ms, and
 *   maxTickParticles = the share of that tick's routed mass that became particles/dust instead of rigid chunks.
 * Writes JSON with every record and prints a summary.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_ARENA,
  DEFAULT_LIGHTING,
  type Difficulty,
  type MatchConfig,
  type MatterLedger,
  type TitanId,
} from '@/contracts';
import { createAI } from '@/ai';
import { createFighter } from '@/combat';
import { createMatterWorld } from '@/matter';
import { createAiSource, createMatch } from '@/sim';
import { getTitanDef } from '@/titans';

const args = process.argv.slice(2);
const opt = (k: string, d: string): string =>
  (args.find((x) => x.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=');

const A = opt('a', 'lastone') as TitanId;
const B = opt('b', 'planet') as TitanId;
const N = +opt('n', '20');
const SEED = +opt('seed', '1');
const LA = +opt('la', '3') as Difficulty;
const LB = +opt('lb', '3') as Difficulty;
const OUT = opt('out', '');
/** `--orbit` / `--zdepth`: the Phase 1 locomotion prototypes (MatchConfig.footwork / zdepth). */
const FOOTWORK: 'classic' | 'orbit' = args.includes('--orbit') ? 'orbit' : 'classic';
const ZDEPTH = args.includes('--zdepth');

interface RoundRec {
  fight: number;
  round: number;
  seconds: number;
  hits: number;
  contacts: number;
  heavy: number;
  end: string;
  winner: string;
}
interface HeavyRec {
  fight: number;
  tick: number;
  attacker: TitanId;
  target: TitanId;
  moveId: string;
  energy: number;
  type: string;
  loss: number;
  toParticles: number;
  toChunks: number;
  maxTick: number;
  maxTickAt: number;
  maxTickParticles: number;
}
const WINDOW = 90;

const rounds: RoundRec[] = [];
const heavies: HeavyRec[] = [];
const t0 = performance.now();

for (let i = 0; i < N; i++) {
  const swapped = i % 2 === 1;
  const ta = swapped ? B : A;
  const tb = swapped ? A : B;
  const cfg: MatchConfig = {
    seed: SEED + i,
    stage: 'nursery',
    mode: 'aivai',
    footwork: FOOTWORK,
    zdepth: ZDEPTH,
    slots: [
      { titan: ta, controller: 'ai', aiLevel: swapped ? LB : LA },
      { titan: tb, controller: 'ai', aiLevel: swapped ? LA : LB },
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
    createAiSource(
      m,
      0,
      createAI(cfg.slots[0].aiLevel!, getTitanDef(ta), cfg.seed * 7 + 1, { footwork: FOOTWORK }),
    ),
    createAiSource(
      m,
      1,
      createAI(cfg.slots[1].aiLevel!, getTitanDef(tb), cfg.seed * 7 + 2, { footwork: FOOTWORK }),
    ),
  );
  const titans = [ta, tb] as const;
  const moveOf: [string, string] = ['', ''];
  const moveStart: [number, number] = [0, 0];
  let cur = { round: 1, start: -1, hits: 0, heavy: 0, contacts: new Set<number>() };
  let prevLedger: MatterLedger = { ...m.world.ledger() };
  const prevMass: [number, number] = [m.fighters[0].view.bodyStats.mass, m.fighters[1].view.bodyStats.mass];
  const open: {
    rec: HeavyRec;
    tick: number;
    target: 0 | 1;
    mass0: number;
    led0: MatterLedger;
    lastMass: number;
  }[] = [];
  let ticks = 0;
  while (m.phase !== 'matchend' && ticks < 60 * 60 * 6) {
    m.step();
    ticks++;
    const led = m.world.ledger();
    for (const e of m.events) {
      if (e.t === 'move') {
        moveOf[e.slot] = e.moveId;
        moveStart[e.slot] = m.tick;
      } else if (e.t === 'round') {
        if (e.phase === 'fight')
          cur = { round: m.round, start: m.tick, hits: 0, heavy: 0, contacts: new Set() };
        else if ((e.phase === 'ko' || e.phase === 'timeover') && cur.start >= 0) {
          rounds.push({
            fight: i,
            round: cur.round,
            seconds: +((m.tick - cur.start) / 60).toFixed(2),
            hits: cur.hits,
            contacts: cur.contacts.size,
            heavy: cur.heavy,
            end: e.phase,
            winner: e.winner === -1 ? '-' : titans[e.winner],
          });
          cur.start = -1;
        }
      } else if (e.t === 'hit' && m.phase === 'fight') {
        cur.hits++;
        cur.contacts.add(e.attacker * 1e7 + moveStart[e.attacker]);
        // discrete major blows only (continuous beam/field slices are flagged heavy but tiny; see telemetry.ts)
        if (e.energy >= 400) {
          cur.heavy++;
          const rec: HeavyRec = {
            fight: i,
            tick: m.tick,
            attacker: titans[e.attacker],
            target: titans[e.target],
            moveId: moveOf[e.attacker],
            energy: Math.round(e.energy),
            type: e.type,
            loss: 0,
            toParticles: 0,
            toChunks: 0,
            maxTick: 0,
            maxTickAt: 0,
            maxTickParticles: 0,
          };
          // the blow was applied inside this step: measure from the state BEFORE it
          open.push({
            rec,
            tick: m.tick - 1,
            target: e.target,
            mass0: prevMass[e.target],
            led0: prevLedger,
            lastMass: prevMass[e.target],
          });
          heavies.push(rec);
        }
      }
    }
    for (let k = open.length - 1; k >= 0; k--) {
      const o = open[k]!;
      const age = m.tick - o.tick;
      const mass = m.fighters[o.target].view.bodyStats.mass;
      const d = o.lastMass - mass;
      if (d > o.rec.maxTick) {
        o.rec.maxTick = +d.toFixed(1);
        o.rec.maxTickAt = Math.round(((age - 1) * 1000) / 60);
        const p = led.particleMass + led.dissipated - prevLedger.particleMass - prevLedger.dissipated;
        const c = led.chunkMass - prevLedger.chunkMass;
        o.rec.maxTickParticles = +(Math.max(0, p) / Math.max(1e-6, Math.max(0, p) + Math.max(0, c))).toFixed(
          2,
        );
      }
      o.lastMass = mass;
      if (age >= WINDOW) {
        o.rec.loss = +(o.mass0 - mass).toFixed(1);
        o.rec.toParticles = +(
          led.particleMass +
          led.dissipated -
          o.led0.particleMass -
          o.led0.dissipated
        ).toFixed(1);
        o.rec.toChunks = +(led.chunkMass - o.led0.chunkMass).toFixed(1);
        open.splice(k, 1);
      }
    }
    prevLedger = { ...led };
    prevMass[0] = m.fighters[0].view.bodyStats.mass;
    prevMass[1] = m.fighters[1].view.bodyStats.mass;
  }
  process.stdout.write(`fight ${i + 1}/${N} done (${(ticks / 60).toFixed(0)} s sim)\n`);
}

const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const med = (a: number[]): number => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1]! : 0;
};
const secs = rounds.map((r) => r.seconds);
console.log(
  `\n${A} vs ${B}, L${LA}/L${LB}, ${N} fights, ${((performance.now() - t0) / 1000).toFixed(0)} s wall`,
);
console.log(
  `rounds ${rounds.length}: length mean ${mean(secs).toFixed(1)} s, median ${med(secs).toFixed(1)} s, ` +
    `in 45–90 s: ${rounds.filter((r) => r.seconds >= 45 && r.seconds <= 90).length}, timeouts ${rounds.filter((r) => r.end === 'timeover').length}`,
);
console.log(
  `per round: hits mean ${mean(rounds.map((r) => r.hits)).toFixed(1)}, contacts ${mean(rounds.map((r) => r.contacts)).toFixed(1)}, ` +
    `heavy ${mean(rounds.map((r) => r.heavy)).toFixed(1)}; contacts per minute ${(mean(rounds.map((r) => r.contacts / Math.max(1, r.seconds))) * 60).toFixed(1)}`,
);
const pctOf = (x: number, y: number): string => `${((x / Math.max(1e-6, y)) * 100).toFixed(0)}%`;
for (const t of [A, B]) {
  const hs = heavies.filter((h) => h.target === t && h.loss > 0);
  console.log(
    `heavy hits ON ${t}: ${hs.length}; largest one-tick loss as share of the 1.5 s loss: median ` +
      `${pctOf(med(hs.map((h) => h.maxTick / Math.max(1e-6, h.loss))), 1)}; that tick routed to particles: median ` +
      `${pctOf(med(hs.map((h) => h.maxTickParticles)), 1)}; overall routed to particles ` +
      `${pctOf(
        hs.reduce((s, h) => s + h.toParticles, 0),
        hs.reduce((s, h) => s + h.toParticles + h.toChunks, 0),
      )}`,
  );
}
const byMove = new Map<string, HeavyRec[]>();
for (const h of heavies)
  byMove.set(`${h.moveId}→${h.target}`, [...(byMove.get(`${h.moveId}→${h.target}`) ?? []), h]);
console.log('  move→target                     n   1.5s loss  max 1-tick  @ms  →particles(that tick)');
for (const [mv, hs] of byMove)
  console.log(
    `  ${mv.padEnd(30)} ${String(hs.length).padStart(3)}  ${med(hs.map((h) => h.loss))
      .toFixed(0)
      .padStart(9)}  ` +
      `${med(hs.map((h) => h.maxTick))
        .toFixed(0)
        .padStart(10)}  ${med(hs.map((h) => h.maxTickAt))
        .toFixed(0)
        .padStart(4)}  ` +
      `${pctOf(med(hs.map((h) => h.maxTickParticles)), 1).padStart(6)}`,
  );
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ a: A, b: B, la: LA, lb: LB, n: N, seed: SEED, rounds, heavies }, null, 1),
  );
  console.log(`written ${OUT}`);
}
