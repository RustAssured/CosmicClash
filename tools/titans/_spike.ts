import { parseScript } from '@/contracts';
import { createMatterWorld } from '@/matter';
import { FighterImpl } from '@/combat';
import { createScriptSource, makeMatch, skipIntro } from '@/combat/testing/harness';
const A = '1:right*40,45:strike,80:crush,140:surge,150:right*30,190:sig*50,260:guard*30,300:strike,310:upright*20,330:crush,400:ult,520:strike,560:crush,610:sig*40,700:strike,760:crush';
const B = '1:left*50,60:strike,100:left*20,130:guard*40,200:crush,240:sig,300:surge,330:left*40,370:strike,420:ult,500:crush,540:strike,600:left*30,660:sig,720:crush';
const m = makeMatch({ a: 'lastone', b: 'asteroid', seed: 3, createWorld: (s) => createMatterWorld(s) });
skipIntro(m);
const t0 = m.tick;
m.setSources(createScriptSource(parseScript(A), t0), createScriptSource(parseScript(B), t0));
(m.fighters[0] as unknown as { meter: number }).meter = 1;
(m.fighters[1] as unknown as { meter: number }).meter = 1;
let fm = 0;
const orig = FighterImpl.prototype.tick;
FighterImpl.prototype.tick = function (ctx) { const t = performance.now(); orig.call(this, ctx); fm += performance.now() - t; };
const wt = m.world.tick.bind(m.world);
let wm = 0;
m.world.tick = () => { const t = performance.now(); wt(); wm += performance.now() - t; };
for (let i = 0; i < 1500; i++) {
  fm = 0; wm = 0;
  const t = performance.now();
  m.step();
  const d = performance.now() - t;
  if (d > 6) console.log('tick', i, 'total', d.toFixed(1), 'fighters', fm.toFixed(1), 'world.tick', wm.toFixed(1), 'events', m.events.filter((e) => e.t !== 'shake' && e.t !== 'rumble').map((e) => e.t + (e.t === 'move' ? ':' + e.moveId : '')).join(','));
}
