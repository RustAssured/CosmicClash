import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';
import fs from 'fs';
import { spawn } from 'child_process';
const mode = process.argv[2] || 'stills';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.log('ERR', String(e)));
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await p.goto('http://localhost:8777/trailer.html');
await p.waitForFunction(() => window.film);
await p.evaluate(() => window.film.ready());
const info = await p.evaluate(() => ({ frames: window.film.frames, cues: window.film.cues() }));
fs.writeFileSync('cues.json', JSON.stringify(info.cues));
console.log('frames', info.frames, 'welds', info.cues.welds.length);
if (mode === 'stills') {
  const times = process.argv.slice(3).map(Number);
  for (const s of times) {
    const d = await p.evaluate(n => window.film.frame(n), Math.round(s * 30));
    fs.writeFileSync(`still_${s}.rgba`, Buffer.from(d, 'base64'));
  }
} else {
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '640x360', '-r', '30', '-i', '-', '-vf', 'scale=1920:1080:flags=neighbor', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'animation', '-pix_fmt', 'yuv420p', 'video.mp4']);
  ff.stderr.on('data', d => process.stderr.write(d));
  const t0 = Date.now();
  for (let n = 0; n < info.frames; n++) {
    const d = await p.evaluate(n => window.film.frame(n), n);
    if (!ff.stdin.write(Buffer.from(d, 'base64'))) await new Promise(r => ff.stdin.once('drain', r));
    if (n % 150 === 0) console.log('frame', n, ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('done', ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
await b.close();
