import { Btn } from '@/contracts';
import { ManualSource, createFakeWorld, makeMatch, skipIntro } from '@/combat/testing/harness';
import type { FighterImpl } from '@/combat';
const m = makeMatch({ a: 'lastone', b: 'asteroid', createWorld: createFakeWorld });
const sa = new ManualSource(); const sb = new ManualSource(); m.setSources(sa, sb); skipIntro(m);
const f0 = m.fighters[0] as FighterImpl, f1 = m.fighters[1] as FighterImpl;
f1.px = f0.px + 330; f1.py = f0.py;
for (let i = 0; i < 3; i++) m.step();
sb.held = Btn.SIGNATURE; m.step(); sb.held = 0;
sb.moveX = -1;
const b = f1.behaviour as unknown as { sState: Uint8Array; sx: Float32Array; sy: Float32Array; svx: Float32Array; swarmOut: number };
for (let i = 0; i < 230; i++) {
  m.step();
  if (i % 20 === 0 || i > 170 && i % 5 === 0) console.log(i, f1.view.state, f1.view.phase, f1.view.phaseTick, 'out', b.swarmOut, 'states', Array.from(b.sState).join(''), 'res', f1.resource, 'body', f1.px.toFixed(0), 'f0', f0.view.state);
}
