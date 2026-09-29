import { Btn } from '@/contracts';
import { ManualSource, createFakeWorld, makeMatch, skipIntro } from '@/combat/testing/harness';
import type { FakeWorld } from '@/combat/testing/fakeWorld';
import type { FighterImpl } from '@/combat';
{
  const m = makeMatch({ createWorld: createFakeWorld });
  const sa = new ManualSource(); const sb = new ManualSource(); m.setSources(sa, sb); skipIntro(m);
  const f0 = m.fighters[0] as FighterImpl, f1 = m.fighters[1] as FighterImpl;
  f1.px = f0.px + 320; f1.py = f0.py;
  m.step(); m.step(); m.step();
  sa.held = Btn.SIGNATURE;
  for (let i = 0; i < 95; i++) {
    m.step();
    const ev = m.events.filter((e) => e.t === 'charge' || e.t === 'release').map((e) => JSON.stringify(e).slice(0, 90));
    if (ev.length || i % 10 === 0) console.log(i, f0.view.state, f0.view.phase, 'charge', f0.view.chargeFrac.toFixed(2), 'foeX', (f1.view.x - f0.view.x).toFixed(0), ev.join(' | '), 'log', (m.world as FakeWorld).damageLog.length);
  }
}
{
  const m = makeMatch({ createWorld: createFakeWorld });
  const sa = new ManualSource(); const sb = new ManualSource(); m.setSources(sa, sb); skipIntro(m);
  const f0 = m.fighters[0] as FighterImpl, f1 = m.fighters[1] as FighterImpl;
  f1.px = f0.px + 320; f1.py = f0.py;
  m.step(); m.step(); m.step();
  sa.held = Btn.SIGNATURE;
  for (let i = 0; i < 78; i++) m.step();
  const sh = { kind: 'point', x: 0, y: 0, r: 0, x0: 0, y0: 0, x1: 0, y1: 0, width: 0, dirX: 0, dirY: 0, range: 0, halfAngle: 0, r0: 0, r1: 0, falloff: 0 };
  f0.liveHitShape(0, 3, sh as never);
  console.log('shape', JSON.stringify(sh), 'f0', f0.px.toFixed(0), f0.py.toFixed(0), 'f1', f1.px.toFixed(0), f1.py.toFixed(0), 'bounds1', f1.view.boundsX0.toFixed(0), f1.view.boundsX1.toFixed(0), f1.view.boundsY0.toFixed(0), f1.view.boundsY1.toFixed(0), 'reach', f0.mv.reach, 'power', f0.mv.power);
  console.log('probe', f1.probe(sh as never).cells, 'foe transform', JSON.stringify(f1.body.transform));
}
