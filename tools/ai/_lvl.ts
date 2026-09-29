import type { Difficulty, TitanId } from '@/contracts';
import { playMatch } from './duel';
const t = (process.argv[2] ?? 'lastone') as TitanId;
const hi = +(process.argv[3] ?? 6) as Difficulty, lo = +(process.argv[4] ?? 1) as Difficulty;
const fake = process.argv[5] !== 'real';
let w = 0, n = 0; const dur: number[] = []; const kos: string[] = [];
for (let seed = 1; seed <= 10; seed++) {
  for (const flip of [false, true]) {
    const { res, match } = playMatch(seed, t, t, flip ? lo : hi, flip ? hi : lo, '', fake);
    n++; const winner = res.winner;
    if ((winner === 0 && !flip) || (winner === 1 && flip)) w++;
    dur.push(res.ticks / 60);
    kos.push(`${match.wins}`);
  }
}
console.log(t, `L${hi} vs L${lo}: ${w}/${n}`, 'avg s', (dur.reduce((a, b) => a + b, 0) / dur.length).toFixed(0), kos.join(' '));
