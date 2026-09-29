import type { Difficulty, TitanId } from '@/contracts';
import { playMatch } from './duel';
const t = (process.argv[2] ?? 'lastone') as TitanId;
const l0 = +(process.argv[3] ?? 6) as Difficulty, l1 = +(process.argv[4] ?? 1) as Difficulty;
const seed = +(process.argv[5] ?? 4);
const { res, ais } = playMatch(seed, t, t, l0, l1, '', true);
console.log(res.wins, res.ticks);
console.log((ais[0]!.log as string[]).join('\n'));
