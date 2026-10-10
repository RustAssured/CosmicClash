import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { WORK, arg } from './common';

/**
 * Sync check of a rendered clip: the biggest frame-to-frame brightness jumps (flashes, impacts) against the nearest audio
 * onsets (short-term energy rising ≥ 6 dB over the previous 50 ms). Prints each jump's time and the onset's offset (ms).
 *   npx tsx tools/press/sync.ts --clip=supernova-nova-ko [--file=press/work/clips/x.mov]
 */
const clip = arg('clip', '');
const file = arg('file', `${WORK}/clips/${clip}.mov`);
const run = (args: string[]): Buffer => {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...args], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout;
};
const W = 160;
const H = 90;
const v = run(['-i', file, '-vf', `scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-']);
const n = Math.floor(v.length / (W * H));
const lum: number[] = [];
for (let f = 0; f < n; f++) {
  let s = 0;
  for (let i = 0; i < W * H; i++) s += v[f * W * H + i]!;
  lum.push(s / (W * H));
}
const a = run(['-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
const pcm = new Int16Array(a.buffer, a.byteOffset, a.length >> 1);
const win = 480; // 10 ms
const e: number[] = [];
for (let i = 0; i + win <= pcm.length; i += win) {
  let s = 0;
  for (let k = 0; k < win; k++) s += (pcm[i + k]! / 32768) ** 2;
  e.push(10 * Math.log10(s / win + 1e-12));
}
const onsets: number[] = [];
for (let i = 5; i < e.length; i++) {
  const prev = Math.max(...e.slice(i - 5, i));
  if (e[i]! - prev >= 6 && e[i]! > -40) onsets.push(i * 0.01);
}
const jumps = lum
  .map((l, f) => ({ f, d: f ? l - lum[f - 1]! : 0 }))
  .filter((j) => j.d > 6)
  .sort((x, y) => y.d - x.d)
  .slice(0, 8)
  .sort((x, y) => x.f - y.f);
const fileJson = clip ? JSON.parse(readFileSync(`${WORK}/clips/${clip}.json`, 'utf8')) : null;
for (const j of jumps) {
  const t = j.f / 60;
  const near = onsets.reduce((b, o) => (Math.abs(o - t) < Math.abs(b - t) ? o : b), Infinity);
  console.log(
    `flash @ ${t.toFixed(3)} s (+${j.d.toFixed(0)} luma${fileJson ? `, tick ${fileJson.shot.t0 + fileJson.showOf[j.f]}` : ''}) → nearest audio onset ${Number.isFinite(near) ? `${((near - t) * 1000).toFixed(0)} ms` : 'none'}`,
  );
}
