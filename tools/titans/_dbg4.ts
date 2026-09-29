import { parseScript, type TitanId } from '@/contracts';
import { makeMatch, skipIntro, createScriptSource } from '@/combat/testing/harness';
function trial(name: string, a: TitanId, b: TitanId, s0: string, s1: string, ticks: number): void {
  const m = makeMatch({ a, b });
  skipIntro(m);
  const t0 = m.tick;
  m.setSources(createScriptSource(parseScript(s0), t0), createScriptSource(parseScript(s1), t0));
  let cells = 0, mass = 0, hits = 0, e = 0;
  for (let i = 0; i < ticks; i++) {
    m.step();
    for (const ev of m.events) if (ev.t === 'hit') { hits++; cells += ev.cellsRemoved; mass += ev.massRemoved; e += ev.energy; }
  }
  const d = m.fighters[1].view, a0 = m.fighters[0].view;
  console.log(name.padEnd(22), 'hits', hits, 'E', e.toFixed(0), 'cells', cells, 'massRemoved', mass.toFixed(1), '| foe massFrac', d.bodyStats.massFrac.toFixed(3), 'core', d.bodyStats.coreIntegrity.toFixed(2), '| self massFrac', a0.bodyStats.massFrac.toFixed(3));
}
trial('lastone lash→asteroid', 'lastone', 'asteroid', '1:right*62,66:strike', '1:left*30', 140);
trial('lastone shatter→ast', 'lastone', 'asteroid', '1:right*62,66:crush', '1:left*30', 260);
trial('lastone gaze→ast', 'lastone', 'asteroid', '1:right*40,50:sig*40', '1:left*20', 260);
trial('asteroid shoulder→lo', 'lastone', 'asteroid', '1:left*1', '1:left*80,90:strike', 200);
trial('asteroid meteor→lo', 'lastone', 'asteroid', '1:left*1', '1:left*50,60:crush', 260);
