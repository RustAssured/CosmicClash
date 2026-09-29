import { parseScript } from '@/contracts';
import { makeMatch, skipIntro, run, createScriptSource } from '@/combat/testing/harness';
import type { FighterImpl } from '@/combat';
const m = makeMatch();
skipIntro(m);
const t0 = m.tick;
m.setSources(createScriptSource(parseScript('1:right*62,66:strike'), t0), createScriptSource(parseScript('1:left*30'), t0));
run(m, 82);
const f = m.fighters[0] as FighterImpl;
const beh = f.behaviour as unknown as { sys: { n: number; rx: Float32Array; ry: Float32Array; tx: Float32Array; ty: Float32Array; tw: Float32Array; ext: Float32Array; x: Float32Array; y: Float32Array; count: Int8Array; roots: { kind: string }[] } };
const s = beh.sys;
console.log('state', f.state, 'phase', f.mv.phase, f.mv.phaseTick, 'pos', f.px.toFixed(0), f.py.toFixed(0));
for (let i = 0; i < s.n; i++) {
  console.log(i, s.roots[i]!.kind, 'root', s.rx[i]!.toFixed(0), s.ry[i]!.toFixed(0), 'tgt', s.tx[i]!.toFixed(0), s.ty[i]!.toFixed(0), 'tw', s.tw[i]!.toFixed(2), 'ext', s.ext[i]!.toFixed(2), 'cnt', s.count[i], 'tip', s.x[i * 12 + 11]!.toFixed(0), s.y[i * 12 + 11]!.toFixed(0));
}
