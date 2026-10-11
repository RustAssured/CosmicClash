/**
 * Bake the Mouth's menu portrait from the LOCKED oracle (the figure canvas, with alpha): the head at rest, facing right, a
 * little of the neck behind it. Writes src/titans/mouth/portraitData.ts (RGBA bytes as base64).
 *   npx tsx tools/mouth/portrait-bake.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { launch } from '../lead/browser';
import { startRenderServer } from '../render/devserver';

const W = 640;
const H = 360;
const PER = 2 * (W + H);

function patch(html: string): string {
  const rep = (from: string, to: string): void => {
    if (!html.includes(from)) throw new Error(`oracle patch point missing: ${from}`);
    html = html.replace(from, to);
  };
  rep('for(let y=Math.floor(opp.y-58);', 'if(window.__noOpp!==true)for(let y=Math.floor(opp.y-58);');
  rep(
    'for(let k=0;k<6;k++){const r=rng(k*13+5);rock(',
    'if(window.__noRocks!==true)for(let k=0;k<6;k++){const r=rng(k*13+5);rock(',
  );
  rep('if(shake>.4){', 'if(shake>.4&&window.__noShake!==true){');
  rep(
    "const cv=document.getElementById('cv'),gx=cv.getContext('2d');",
    "window.__fig=fig;const cv=document.getElementById('cv'),gx=cv.getContext('2d');",
  );
  rep('for(let k=0;k<30;k++)step(1/60);draw();requestAnimationFrame(loop);', 'requestAnimationFrame(loop);');
  rep('window.__F={DMG,', 'window.__F={setFight:v=>{fightBack=v;},setOppMoves:v=>{oppMoves=v;},DMG,');
  return html;
}

const { server, url } = await startRenderServer();
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    let s = 0x5a17c0de;
    Math.random = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    Object.assign(window, { __noOpp: true, __noRocks: true, __noShake: true });
  });
  const html = patch(readFileSync('mouth/reference/demos/mouth-LOCKED-full.html', 'utf8'));
  await page.route('**/mouth-oracle.html', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: html }),
  );
  await page.goto(`${url}/mouth-oracle.html`);
  await page.waitForFunction('window.__F !== undefined');
  const data = (await page.evaluate(`(() => {
    const F = window.__F; F.setFight(false); F.setOppMoves(false);
    F.s = ${PER - H * 0.5};
    Object.assign(F.opp, { x: 620, y: 180, vx: 0, vy: 0 });
    for (let k = 0; k < 200; k++) F.step(1 / 60);
    F.draw();
    const h = F.head;
    const x0 = Math.round(h.x - 104), y0 = Math.round(h.y - 86);
    const im = window.__fig.getContext('2d').getImageData(x0, y0, 180, 172).data;
    let s = ''; for (let i = 0; i < im.length; i += 0x8000) s += String.fromCharCode(...im.subarray(i, i + 0x8000));
    return btoa(s); })()`)) as string;
  const out = `/** The Mouth's menu portrait, baked from the LOCKED oracle by tools/mouth/portrait-bake.ts (RGBA bytes, 180 × 172). */
export const MOUTH_PORTRAIT = { w: 180, h: 172, rgba: '${data}' };
`;
  writeFileSync('src/titans/mouth/portraitData.ts', out);
  console.log(`portrait: 180×172 → src/titans/mouth/portraitData.ts (${data.length} chars)`);
} finally {
  await browser.close();
  await server.close();
}
